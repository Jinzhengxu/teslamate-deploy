#!/usr/bin/env bash
#
# TeslaMate 一键部署 —— 接入服务器上已有的 matrix-chat Caddy（和 poker 同一套路）
#
# 设计原则：
#   1. 幂等 —— 重复执行结果一致；也是升级方式（会先 pull 最新镜像）。
#   2. 绝不影响已有的 matrix / poker —— 不占宿主端口，改 Caddyfile 前先备份，
#      validate 或 reload 任何一步失败都自动回滚。
#   3. 密钥只生成一次，存在项目根目录的 .env（chmod 600），之后一直复用。
#      ENCRYPTION_KEY / 数据库密码一旦生成就不能改，改了旧数据解不开。
#
# 用法（在服务器上，以 root）：
#   TM_DOMAIN=tm.example.com bash deploy/deploy.sh  首次部署（域名会记进 .env，之后不用再给）
#   bash deploy/deploy.sh                          部署 / 升级
#   TM_WEB_PASSWORD='新密码' bash deploy/deploy.sh    部署并设置（或重置）网页登录密码
#   bash deploy/deploy.sh --backup                 备份数据库到 backups/
#   bash deploy/deploy.sh --rollback               下线容器并从 Caddyfile 移除站点块（数据卷保留）
#
# 分时电价（可选，按每段电量所在的月份和时刻给家里的充电算钱）：
#   TM_TOU_FILE=deploy/tou/shandong-ev.conf bash deploy/deploy.sh --tou
#                                                  按季节/月份变化的电价，用配置文件（格式见该文件）
#   TM_TOU_PRICES='23:00-07:00=0.3,07:00-23:00=0.6' bash deploy/deploy.sh --tou
#                                                  全年同一套时段时，直接写在命令行
#   TM_TOU_RECALC=1 bash deploy/deploy.sh --tou    按当前电价重算该围栏里所有历史充电（先自动备份）
#   TM_TOU_PRICES=off bash deploy/deploy.sh --tou  关闭分时电价
#
# 换肤（默认开启，只改网页样式，不动 TeslaMate 本身，见 deploy/theme/）：
#   TM_THEME=off bash deploy/deploy.sh             关掉换肤，恢复原版界面
#   TM_THEME=on bash deploy/deploy.sh              重新打开
#
# 可覆盖的环境变量：
#   TM_DOMAIN         站点域名（必填，首次给一次即可；仓库里不写死任何人的域名）
#   TM_WEB_USER       网页登录用户名（默认 teslamate）
#   CADDY_CONTAINER   Caddy 容器名（默认 matrix-chat-caddy-1）
#   CADDY_NETWORK     Caddy 所在 docker 网络名（默认自动探测）
#   CADDYFILE_HOST    宿主上的 Caddyfile 路径（默认 /root/matrix-chat/Caddyfile）
#   TM_TOU_GEOFENCE   分时电价作用的地理围栏（名字或 ID；只有一个围栏时自动选中）
#   TM_THEME          on / off，是否启用换肤（默认 on，给过一次就记进 .env）
#   FORCE=1           内存不足时也强行部署
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# 调用方显式给的值优先于 .env 里的
_override_domain="${TM_DOMAIN:-}"
_override_password="${TM_WEB_PASSWORD:-}"
_override_tou="${TM_TOU_PRICES:-}"
_override_tou_file="${TM_TOU_FILE:-}"
_override_tou_gf="${TM_TOU_GEOFENCE:-}"
_override_theme="${TM_THEME:-}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi
[[ -n "$_override_domain" ]] && TM_DOMAIN="$_override_domain"
TM_WEB_PASSWORD="$_override_password"
# 命令行给了其中一种电价写法，就忽略 .env 里记着的另一种
[[ -n "$_override_tou" ]] && { TM_TOU_PRICES="$_override_tou"; TM_TOU_FILE=""; }
[[ -n "$_override_tou_file" ]] && { TM_TOU_FILE="$_override_tou_file"; TM_TOU_PRICES=""; }
[[ -n "$_override_tou_gf" ]] && TM_TOU_GEOFENCE="$_override_tou_gf"
[[ -n "$_override_theme" ]] && TM_THEME="$_override_theme"
unset _override_domain _override_password _override_tou _override_tou_file _override_tou_gf _override_theme

# ------------------------------------------------------------------ 参数与常量
DOMAIN="${TM_DOMAIN:-}"
WEB_USER="${TM_WEB_USER:-teslamate}"
CADDY_CONTAINER="${CADDY_CONTAINER:-matrix-chat-caddy-1}"
CADDYFILE_HOST="${CADDYFILE_HOST:-/root/matrix-chat/Caddyfile}"
CADDY_NETWORK="${CADDY_NETWORK:-}"
UPSTREAM_TIMEOUT=180
# 去掉空格，顺手把中文逗号也认了
TOU_PRICES="$(printf '%s' "${TM_TOU_PRICES:-}" | tr -d ' ' | sed 's/，/,/g')"
TOU_FILE="${TM_TOU_FILE:-}"
TOU_GEOFENCE="${TM_TOU_GEOFENCE:-}"
TOU_SQL_FILE="$PROJECT_DIR/.tou.sql"
THEME="$(printf '%s' "${TM_THEME:-on}" | tr '[:upper:]' '[:lower:]')"
THEME_UPSTREAM="teslamate-theme:8080"
TM_UPSTREAM="teslamate:4000"
UPSTREAMS="$TM_UPSTREAM"   # 换肤代理检查通过后改成「换肤代理 + 本体兜底」
# 被动健康检查只在有两个上游时才有意义；只有一个上游时开着它，TeslaMate 重启后
# Caddy 会把它记成「坏的」，恢复后还要白白返回一阵 503
FAIL_DURATION=0
THEME_STATUS="off"         # off / on / failed，最后打印用

BEGIN_MARK='# >>> teslamate BEGIN'
END_MARK='# <<< teslamate END'
SITE_SNIPPET="$SCRIPT_DIR/caddy-site.txt"

SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' || true)"
SERVER_IP="${SERVER_IP:-<这台服务器的公网 IP>}"

WORK_DIR="$(mktemp -d)"
BACKUP_FILE=""
CADDY_MODIFIED=0
CADDYFILE_IN_CONTAINER="/etc/caddy/Caddyfile"
BASIC_AUTH_DIRECTIVE="basic_auth"
NEW_WEB_PASSWORD=""      # 本次新生成/新设置的网页密码，只在最后打印一次
STEP=0

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ------------------------------------------------------------------ 输出 helper
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''
fi

step()  { STEP=$((STEP + 1)); printf '\n%s%s[步骤 %d] %s%s\n' "$C_BOLD" "$C_BLUE" "$STEP" "$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
dim()   { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '    %s✔ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf '    %s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()   { printf '\n%s✘ 错误：%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

dc() { (cd "$PROJECT_DIR" && docker compose "$@"); }

theme_enabled() { [[ "$THEME" != "off" ]]; }

# 按当前开关拼出要启用的 compose profile（换肤 theme、分时电价 tou）
compose_profiles() {
  local p=()
  theme_enabled && p+=(theme)
  tou_enabled && [[ -s "$TOU_SQL_FILE" ]] && p+=(tou)
  local IFS=,
  printf '%s' "${p[*]}"
}

env_set() {
  local key="$1" value="$2"
  if [[ ! -f "$ENV_FILE" ]]; then
    printf '# 由 deploy/deploy.sh 自动生成。TM_ENCRYPTION_KEY / TM_DB_PASS 生成后不要再改！\n' > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    awk -v k="$key" -v v="$value" '
      index($0, k "=") == 1 { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$WORK_DIR/env.new"
    cat "$WORK_DIR/env.new" > "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

env_unset() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -v "^${1}=" "$ENV_FILE" > "$WORK_DIR/env.new" || true
  cat "$WORK_DIR/env.new" > "$ENV_FILE"
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${1:-32}"
  else
    head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

caddy_exec() { docker exec "$CADDY_CONTAINER" "$@"; }

# ------------------------------------------------------------------ Caddyfile 读写（和 poker 一致）
detect_caddyfile_in_container() {
  local host_path="$1" src dst
  while IFS='|' read -r src dst; do
    [[ -z "$src" ]] && continue
    if [[ "$src" == "$host_path" ]]; then printf '%s\n' "$dst"; return 0; fi
    if [[ "$host_path" == "$src"/* ]]; then printf '%s\n' "${dst%/}/${host_path#"$src"/}"; return 0; fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$CADDY_CONTAINER" 2>/dev/null || true)
  return 1
}

strip_block_to() {
  local out="$1"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    index($0, b) { skip = 1; next }
    skip && index($0, e) { skip = 0; next }
    !skip { print }
  ' "$CADDYFILE_HOST" > "$out.raw"
  printf '%s\n' "$(cat "$out.raw")" > "$out"
  rm -f "$out.raw"
}

# 必须用 `cat > 文件` 原地写：Caddyfile 是单文件 bind mount，mv 换 inode 后容器里看到的还是旧文件
write_caddyfile() { cat "$1" > "$CADDYFILE_HOST"; }

restore_caddyfile() {
  if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
    warn "没有可用备份，Caddyfile 未被恢复（本次可能没改过它）"
    return 0
  fi
  warn "正在回滚 Caddyfile：$BACKUP_FILE → $CADDYFILE_HOST"
  write_caddyfile "$BACKUP_FILE"
  if caddy_exec caddy reload --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile >/dev/null 2>&1; then
    ok "已恢复到修改前的配置，matrix / poker 不受影响"
  else
    warn "恢复后的 reload 也失败了！请手工检查：docker logs --tail 50 $CADDY_CONTAINER"
  fi
}

update_caddyfile() {
  local mode="$1"
  if [[ "$mode" == "add" ]]; then step "备份并幂等更新 Caddyfile（$CADDYFILE_HOST）"
  else step "从 Caddyfile 移除 TeslaMate 站点块"; fi

  [[ -f "$CADDYFILE_HOST" ]] || die "找不到 $CADDYFILE_HOST。路径不同请用 CADDYFILE_HOST=/xxx/Caddyfile 指定"

  local new="$WORK_DIR/Caddyfile.new"
  strip_block_to "$new"
  if [[ "$mode" == "add" ]]; then
    printf '\n' >> "$new"
    # bcrypt 哈希只含 [./A-Za-z0-9$]，不会撞上 sed 的 | 分隔符和 & \ 这类特殊字符
    sed -e "s|__DOMAIN__|${DOMAIN}|g" \
        -e "s|__BASIC_AUTH__|${BASIC_AUTH_DIRECTIVE}|g" \
        -e "s|__AUTH_USER__|${WEB_USER}|g" \
        -e "s|__AUTH_HASH__|${TM_WEB_HASH}|g" \
        -e "s|__UPSTREAMS__|${UPSTREAMS}|g" \
        -e "s|__FAIL_DURATION__|${FAIL_DURATION}|g" \
        "$SITE_SNIPPET" >> "$new"
  fi

  CADDYFILE_IN_CONTAINER="$(detect_caddyfile_in_container "$CADDYFILE_HOST" || echo /etc/caddy/Caddyfile)"
  dim "容器内 Caddyfile 路径：$CADDYFILE_IN_CONTAINER"

  if cmp -s "$new" "$CADDYFILE_HOST"; then
    ok "Caddyfile 已是目标状态，无需修改"
  else
    BACKUP_FILE="${CADDYFILE_HOST}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$CADDYFILE_HOST" "$BACKUP_FILE"
    ok "已备份原 Caddyfile → $BACKUP_FILE"
    write_caddyfile "$new"
    CADDY_MODIFIED=1
    if [[ "$mode" == "add" ]]; then ok "已写入 $DOMAIN 站点块"; else ok "已移除 $DOMAIN 站点块"; fi
  fi

  local out
  if out="$(caddy_exec caddy validate --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile 2>&1)"; then
    ok "caddy validate 通过"
  else
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/      /'
    restore_caddyfile
    die "Caddyfile 校验失败，已回滚。请检查 deploy/caddy-site.txt"
  fi

  if out="$(caddy_exec caddy reload --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile 2>&1)"; then
    ok "caddy reload 成功（其他站点不中断）"
  else
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/      /'
    restore_caddyfile
    die "caddy reload 失败，已回滚"
  fi
}

# ------------------------------------------------------------------ 各个步骤
check_prereq() {
  step "前置检查"

  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "请以 root 执行（sudo bash deploy/deploy.sh）"
  command -v docker >/dev/null 2>&1 || die "找不到 docker"
  docker info >/dev/null 2>&1 || die "docker 守护进程没跑起来：systemctl start docker"
  docker compose version >/dev/null 2>&1 || die "找不到 docker compose 插件（v2）"
  [[ -f "$PROJECT_DIR/docker-compose.yml" ]] || die "在 $PROJECT_DIR 下找不到 docker-compose.yml"
  [[ -f "$SITE_SNIPPET" ]] || die "找不到站点片段 $SITE_SNIPPET"
  case "$THEME" in
    on|off) ;;
    *) die "TM_THEME 只能是 on 或 off（现在是「$THEME」）" ;;
  esac
  if theme_enabled; then
    [[ -f "$PROJECT_DIR/deploy/theme/nginx/teslamate-theme.conf" && -f "$PROJECT_DIR/deploy/theme/assets/theme.css" \
       && -f "$PROJECT_DIR/deploy/theme/assets/theme.js" ]] \
      || die "找不到换肤文件 deploy/theme/，请确认代码完整（或用 TM_THEME=off 关掉换肤）"
  fi
  ok "root / docker / compose / 项目文件 均就绪"

  # TeslaMate + Postgres + Grafana 常驻约 500MB。内存 + 空闲 swap 合计不够时硬塞，
  # OOM killer 可能先杀掉 matrix。已经在跑的话不再拦：那部分内存早就算在已用里了。
  # 注意 1G 的 swapfile 在 /proc/meminfo 里显示为 1023MB，门槛别卡在 1024 上。
  local mem_avail swap_free
  mem_avail="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)"
  swap_free="$(awk '/SwapFree/{printf "%d", $2/1024}' /proc/meminfo)"
  info "可用内存 ${mem_avail}MB，空闲 swap ${swap_free}MB"
  if docker inspect teslamate >/dev/null 2>&1; then
    dim "TeslaMate 已在运行，跳过内存门槛"
  elif (( mem_avail + swap_free < 800 )); then
    # 已有的 /swapfile 多半正在用，建议里绝不能复用它的名字
    local f=/swapfile n=2
    while [[ -e "$f" ]]; do f="/swapfile$n"; n=$((n + 1)); done
    warn "内存 + 空闲 swap 合计只有 $((mem_avail + swap_free))MB，TeslaMate 全家约 500MB，余量不够。"
    warn "建议再加 1G swap（新建 $f，不动已有的 swap）："
    dim "fallocate -l 1G $f && chmod 600 $f && mkswap $f && swapon $f"
    dim "echo '$f none swap sw 0 0' >> /etc/fstab"
    [[ "${FORCE:-0}" == "1" ]] || die "为保护已有服务先停在这里。加好 swap 后重跑；确认要硬上就用 FORCE=1 bash deploy/deploy.sh"
    warn "FORCE=1，继续部署"
  elif (( mem_avail < 700 )); then
    warn "物理内存偏紧，会用到一部分 swap（TeslaMate 平时很闲，影响不大）"
  fi
}

detect_caddy() {
  step "探测 Caddy 容器、网络与版本"

  if ! docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1; then
    local guess
    guess="$(docker ps --format '{{.Names}}' | grep -i caddy | head -n 1 || true)"
    [[ -n "$guess" ]] || die "找不到 Caddy 容器。请用 CADDY_CONTAINER=名字 bash deploy/deploy.sh 指定"
    CADDY_CONTAINER="$guess"
    warn "找不到默认容器，自动选中：$CADDY_CONTAINER"
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$CADDY_CONTAINER")" == "true" ]] \
    || die "容器 $CADDY_CONTAINER 没在运行"
  ok "Caddy 容器：$CADDY_CONTAINER"

  if [[ -z "$CADDY_NETWORK" ]]; then
    CADDY_NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER" | awk '{print $1}')"
  fi
  [[ -n "$CADDY_NETWORK" && "$CADDY_NETWORK" != "host" && "$CADDY_NETWORK" != "none" ]] \
    || die "Caddy 的网络模式是 '${CADDY_NETWORK:-空}'，无法按服务名反代，需要手工处理"
  ok "Caddy 所在网络：$CADDY_NETWORK"

  # basicauth 在 Caddy 2.8 改名为 basic_auth，旧名只是兼容别名
  local ver major minor
  ver="$(caddy_exec caddy version 2>/dev/null | awk '{print $1}')"
  major="$(printf '%s' "$ver" | sed -n 's/^v\([0-9]*\)\.\([0-9]*\).*/\1/p')"
  minor="$(printf '%s' "$ver" | sed -n 's/^v\([0-9]*\)\.\([0-9]*\).*/\2/p')"
  if [[ "${major:-2}" -eq 2 && "${minor:-99}" -lt 8 ]]; then
    BASIC_AUTH_DIRECTIVE="basicauth"
  fi
  ok "Caddy 版本 ${ver:-未知}，使用 $BASIC_AUTH_DIRECTIVE 指令"
}

prepare_env() {
  step "准备 .env（密钥只生成一次）"

  env_set TM_DOMAIN "$DOMAIN"
  env_set TM_TZ "${TM_TZ:-Asia/Shanghai}"
  env_set CADDY_NETWORK "$CADDY_NETWORK"

  if [[ -z "${TM_ENCRYPTION_KEY:-}" ]]; then
    TM_ENCRYPTION_KEY="$(rand_hex 32)"; env_set TM_ENCRYPTION_KEY "$TM_ENCRYPTION_KEY"
    ok "已生成 TM_ENCRYPTION_KEY"
  else
    ok "复用已有 TM_ENCRYPTION_KEY"
  fi
  if [[ -z "${TM_DB_PASS:-}" ]]; then
    TM_DB_PASS="$(rand_hex 16)"; env_set TM_DB_PASS "$TM_DB_PASS"
    ok "已生成数据库密码"
  else
    ok "复用已有数据库密码"
  fi
  if [[ -z "${TM_GRAFANA_PW:-}" ]]; then
    TM_GRAFANA_PW="$(rand_hex 12)"; env_set TM_GRAFANA_PW "$TM_GRAFANA_PW"
    ok "已生成 Grafana 管理员密码"
  fi

  # 网页登录：显式给了 TM_WEB_PASSWORD 就（重新）设置；否则复用；都没有就随机生成
  if [[ -n "$TM_WEB_PASSWORD" || -z "${TM_WEB_HASH:-}" ]]; then
    NEW_WEB_PASSWORD="${TM_WEB_PASSWORD:-$(rand_hex 8)}"
    TM_WEB_HASH="$(caddy_exec caddy hash-password --plaintext "$NEW_WEB_PASSWORD" | tail -n 1 | tr -d '\r')"
    [[ "$TM_WEB_HASH" =~ ^[./A-Za-z0-9\$+=]+$ ]] || die "caddy hash-password 输出异常：$TM_WEB_HASH"
    # 单引号：bcrypt 里的 $ 不能被 bash / compose 当成变量展开
    env_set TM_WEB_HASH "'$TM_WEB_HASH'"
    ok "已设置网页登录密码（用户名 $WEB_USER）"
  else
    ok "复用已有网页登录密码"
  fi
  env_set TM_WEB_USER "$WEB_USER"
  env_set TM_THEME "$THEME"
  chmod 600 "$ENV_FILE"
  # 单文件挂载的源文件必须先存在，否则 docker 会把它建成目录
  [[ -f "$TOU_SQL_FILE" ]] || : > "$TOU_SQL_FILE"
}

start_stack() {
  step "拉取镜像并启动（不映射任何宿主端口）"
  mkdir -p "$PROJECT_DIR/import"
  COMPOSE_PROFILES="$(compose_profiles)"
  export COMPOSE_PROFILES
  dc pull || die "镜像拉取失败"
  dc up -d --remove-orphans || die "docker compose up 失败"
  # 不在当前 profile 里的服务 compose 不会去停，关掉换肤时要自己删
  theme_enabled || docker rm -f teslamate-theme >/dev/null 2>&1 || true
  ok "容器已启动"

  # 从 Caddy 容器里去连上游：顺带验证了"两边确实在同一个 docker 网络"
  if ! caddy_exec sh -c 'command -v wget' >/dev/null 2>&1; then
    warn "Caddy 容器里没有 wget，跳过上游连通性检查"
    # 没法验证就不冒险：先直连原版，靠 Caddy 的回落也能用，但少一层不确定
    if theme_enabled; then
      THEME_STATUS="failed"
      warn "同样没法验证换肤代理，本次先不启用换肤（网页为原版界面）"
    fi
    return 0
  fi
  info "等待 TeslaMate 完成数据库迁移并就绪（最多 ${UPSTREAM_TIMEOUT}s）"
  printf '    '
  local waited=0
  while [[ "$waited" -lt "$UPSTREAM_TIMEOUT" ]]; do
    if caddy_exec wget -q -T 5 -O /dev/null http://teslamate:4000/ >/dev/null 2>&1; then
      printf '\n'; ok "Caddy → teslamate:4000 连通"; break
    fi
    sleep 3; waited=$((waited + 3)); printf '.'
  done
  if [[ "$waited" -ge "$UPSTREAM_TIMEOUT" ]]; then
    printf '\n'
    docker logs --tail 30 teslamate 2>&1 | sed 's/^/      /'
    die "TeslaMate 没有在 ${UPSTREAM_TIMEOUT}s 内就绪（上面是它最后 30 行日志）。Caddyfile 未改动"
  fi
  if caddy_exec wget -q -T 5 -O /dev/null http://teslamate-grafana:3000/grafana/api/health >/dev/null 2>&1; then
    ok "Caddy → teslamate-grafana:3000 连通"
  else
    warn "Grafana 暂未就绪（它启动比较慢），稍后可看：docker logs teslamate-grafana"
  fi
  check_theme
}

# 换肤代理自检。任何一步不过都只是退回原版界面（Caddy 直连 teslamate），不拦部署
check_theme() {
  if ! theme_enabled; then
    dim "换肤已关闭（TM_THEME=off），网页为 TeslaMate 原版界面"
    return 0
  fi
  THEME_STATUS="failed"
  local out
  # 用一次性容器校验配置：换肤容器要是正卡在重启循环里，docker exec 根本进不去。
  # --entrypoint nginx 跳过镜像自带的启动脚本，出错时只剩 nginx 自己的报错
  if ! out="$(dc run --rm --no-deps -T --entrypoint nginx teslamate-theme -t 2>&1)"; then
    printf '%s\n' "$out" | grep -v 'Creating\|Created\|Starting\|Started' | tail -n 5 | sed 's/^/      /'
    if [[ "$out" == *"emerg"* || "$out" == *"test failed"* ]]; then
      warn "换肤代理配置校验失败，本次先不用它（网页为原版界面）。请检查 deploy/theme/nginx/"
    else
      warn "没法校验换肤代理配置（docker compose 报错，见上），本次先不用它（网页为原版界面）"
    fi
    return 0
  fi
  # 目录挂载：git pull 后的新配置、新样式容器里已经能看到，配置要 reload 才生效；
  # 没在正常运行（比如之前配置坏了一直在重启）就直接重启它
  if [[ "$(docker inspect -f '{{.State.Status}}' teslamate-theme 2>/dev/null)" == "running" ]]; then
    # nginx -s reload 只是给主进程发个信号就返回，新的 worker 起来之前请求还是旧配置在处理，
    # 马上去检查会误判。等到出现新的 worker 进程再往下走（最多约 5 秒）
    local old_workers new_workers
    old_workers="$(docker exec teslamate-theme pgrep -P 1 2>/dev/null | sort | tr '\n' ' ' || true)"
    docker exec teslamate-theme nginx -s reload >/dev/null 2>&1 || true
    for _ in $(seq 1 25); do
      sleep 0.2
      new_workers="$(docker exec teslamate-theme pgrep -P 1 2>/dev/null | sort | tr '\n' ' ' || true)"
      [[ -n "$new_workers" && "$new_workers" != "$old_workers" ]] && break
    done
  else
    docker restart teslamate-theme >/dev/null 2>&1 || true
  fi
  # 顺带验证了三件事：Caddy 连得上换肤代理、换肤代理连得上 teslamate、样式确实插进了页面
  # 先存进变量再匹配：直接 | grep -q 的话 grep 提前退出，wget 收到 SIGPIPE，pipefail 下整条算失败
  local html err="$WORK_DIR/theme-wget.err"
  for _ in 1 2 3 4 5 6; do
    html="$(caddy_exec wget -q -T 5 -O - "http://$THEME_UPSTREAM/sign_in" 2>"$err" || true)"
    if [[ "$html" == *"/_theme/theme.css"* ]]; then
      UPSTREAMS="$THEME_UPSTREAM $TM_UPSTREAM"
      FAIL_DURATION=10s
      THEME_STATUS="on"
      ok "换肤已启用：Caddy → teslamate-theme:8080 → teslamate:4000（换肤代理出问题时自动直连原版）"
      return 0
    fi
    sleep 2
  done
  [[ -s "$err" ]] && sed 's/^/      /' "$err" | tail -n 3
  # 只留真正的报错：reload 会刷一堆 [notice]，访问日志也帮不上忙
  docker logs --tail 80 teslamate-theme 2>&1 | grep -E '\[(error|crit|alert|emerg)\]' | tail -n 10 | sed 's/^/      /' || true
  warn "换肤代理没有按预期工作（上面是它的报错），本次先不用它，网页为原版界面"
}

final_check() {
  step "最终自检"
  command -v curl >/dev/null 2>&1 || { warn "宿主没有 curl，跳过"; return 0; }

  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" http://127.0.0.1/ || true)"
  case "$code" in
    301|302|307|308) ok "Caddy 已认得 $DOMAIN（HTTP → HTTPS 跳转 $code）" ;;
    *) warn "本机 HTTP 返回 ${code:-无响应}，预期是 308 跳转" ;;
  esac

  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)"
  case "$code" in
    401) ok "https://$DOMAIN/ → 401，密码保护生效，证书也已就绪" ;;
    000) warn "HTTPS 暂时握手失败：多半是证书还没签下来（DNS 还没配或还没生效），见下方说明" ;;
    *)   warn "https://$DOMAIN/ 返回 $code（预期 401）" ;;
  esac
}

# ------------------------------------------------------------------ 分时电价
db_query() { docker exec teslamate-db psql -U teslamate -d teslamate -tA -F '|' -c "$1"; }

tou_enabled() { [[ ( -n "$TOU_PRICES" && "$TOU_PRICES" != "off" ) || -n "$TOU_FILE" ]]; }

# 两种写法统一成配置文件格式：TM_TOU_PRICES 相当于只有一组 [1-12]
tou_source() {
  if [[ -n "$TOU_FILE" ]]; then
    local f="$TOU_FILE"
    [[ "$f" == /* ]] || f="$PROJECT_DIR/$f"
    [[ -f "$f" ]] || die "找不到电价配置文件：$f"
    cat "$f"
  else
    printf '[1-12]\n'
    printf '%s\n' "$TOU_PRICES" | tr ',' '\n'
  fi
}

# 解析并校验电价配置，输出 "月|起|止|价"。12 个月都要有，每个月的时段恰好覆盖 24 小时。
# 出错时只输出原因并返回 1。不用 {n} 这种区间正则：Debian 默认的 mawk 老版本不认。
tou_parse() {
  awk '
    function mins(t,  a) { split(t, a, ":"); return a[1] * 60 + a[2] }
    function fail(msg) { printf "%s\n", msg; bad = 1; exit 1 }
    { raw = $0; sub(/#.*/, ""); gsub(/[ \t\r]/, "") }
    $0 == "" { next }
    /^\[.*\]$/ {
      spec = substr($0, 2, length($0) - 2); nm = 0
      n = split(spec, parts, ",")
      for (i = 1; i <= n; i++) {
        if (parts[i] ~ /^[0-9]+-[0-9]+$/) { split(parts[i], ab, "-"); a = ab[1] + 0; b = ab[2] + 0 }
        else if (parts[i] ~ /^[0-9]+$/) { a = parts[i] + 0; b = a }
        else fail("月份写法不对：[" spec "]（例：[1-2,12]）")
        if (a < 1 || b > 12 || a > b) fail("月份超出 1-12：[" spec "]")
        for (m = a; m <= b; m++) {
          if (m in seen) fail(m " 月同时出现在多个分组里")
          seen[m] = 1; cur[++nm] = m
        }
      }
      next
    }
    {
      if (nm == 0) fail("时段写在了月份分组前面，先写 [月份]：" raw)
      if ($0 !~ /^[0-9][0-9]:[0-5][0-9]-[0-9][0-9]:[0-5][0-9]=[0-9]+(\.[0-9]+)?$/)
        fail("格式不对：" $0 "（应为 HH:MM-HH:MM=每度电价，午夜写 00:00）")
      split($0, kv, "="); split(kv[1], se, "-")
      if (substr(se[1], 1, 2) + 0 > 23 || substr(se[2], 1, 2) + 0 > 23) fail("小时超出 00-23：" $0 "（午夜写 00:00）")
      s = mins(se[1]); e = mins(se[2])
      if (s == e) fail("起止时间相同：" $0)
      for (i = 1; i <= nm; i++) {
        for (t = s; t != e; t = (t + 1) % 1440) cover[cur[i], t]++
        out[++no] = cur[i] "|" se[1] "|" se[2] "|" kv[2]
      }
    }
    END {
      if (bad) exit 1
      for (m = 1; m <= 12; m++) {
        if (!(m in seen)) { printf "%d 月没有配置电价\n", m; exit 1 }
        for (t = 0; t < 1440; t++) if (cover[m, t] != 1) {
          printf "%d 月 %02d:%02d %s\n", m, int(t / 60), t % 60, (cover[m, t] ? "被多个时段重复覆盖" : "不在任何时段里")
          exit 1
        }
      }
      for (i = 1; i <= no; i++) print out[i]
    }'
}

# 由解析后的规则生成计费 SQL。$1 = 规则文件，$2 = 地理围栏 ID
tou_sql() {
  local tz="${TM_TZ:-Asia/Shanghai}" values
  values="$(awk -F'|' -v q="'" '{ printf "%s    (%d, time %s%s%s, time %s%s%s, %s::numeric)", (NR > 1 ? ",\n" : ""), $1, q, $2, q, q, $3, q, $4 }' "$1")"
  cat <<EOF
-- 由 deploy/deploy.sh 生成，别手改；改电价请重新运行 deploy.sh --tou
with price(month, t_from, t_to, price) as (
  values
$values
),
todo as (
  -- 计费电量和 TeslaMate 自己按固定电价算钱时一致：充入电量和耗电量取大的那个
  select id, start_date,
         greatest(coalesce(charge_energy_used, 0), coalesce(charge_energy_added, 0)) as kwh
  from charging_processes
  where geofence_id = $2 and end_date is not null and cost is null
    and coalesce(charge_energy_used, charge_energy_added) is not null
),
seg as (
  -- 相邻两次采样之间的电量（功率 × 间隔，和 TeslaMate 算耗电量的口径一致），
  -- 按区间起点的本地月份和时刻计价
  select c.charging_process_id as pid,
         ((lag(c.date) over win) at time zone 'UTC' at time zone '$tz') as lt,
         greatest(coalesce(c.charger_actual_current * c.charger_voltage * coalesce(c.charger_phases, 1) / 1000.0,
                           c.charger_power, 0), 0)
           * extract(epoch from c.date - (lag(c.date) over win)) as e
  from charges c
  join todo t on t.id = c.charging_process_id
  window win as (partition by c.charging_process_id order by c.date)
),
priced as (
  select s.pid, sum(s.e * p.price) / nullif(sum(s.e), 0) as avg_price
  from seg s
  join price p on p.month = extract(month from s.lt)
   and case when p.t_from < p.t_to then s.lt::time >= p.t_from and s.lt::time < p.t_to
            else s.lt::time >= p.t_from or s.lt::time < p.t_to end
  where s.lt is not null
  group by s.pid
),
fallback as (
  -- 采样不够用（比如只有一个点、功率全是 0）时，按开始时刻的电价算
  select t.id as pid, p.price
  from todo t
  cross join lateral (select (t.start_date at time zone 'UTC' at time zone '$tz') as lt) l
  join price p on p.month = extract(month from l.lt)
   and case when p.t_from < p.t_to then l.lt::time >= p.t_from and l.lt::time < p.t_to
            else l.lt::time >= p.t_from or l.lt::time < p.t_to end
),
upd as (
  update charging_processes cp
     set cost = round(t.kwh * coalesce(pr.avg_price, fb.price), 2)
    from todo t
    left join priced pr on pr.pid = t.id
    left join fallback fb on fb.pid = t.id
   where cp.id = t.id
     and coalesce(pr.avg_price, fb.price) is not null
  returning cp.id, t.kwh, cp.cost
)
select to_char(now() at time zone '$tz', 'YYYY-MM-DD HH24:MI:SS') || ' tou: charge #' || id || ' '
       || round(kwh, 2) || ' kWh -> ' || cost || ' CNY'
from upd order by id;
EOF
}

configure_tou() {
  # 早先的版本用过 TeslaMateAgile，顺手清掉
  docker rm -f teslamate-agile >/dev/null 2>&1 || true
  rm -f "$PROJECT_DIR/.tou.env"

  if [[ "$TOU_PRICES" == "off" ]]; then
    step "关闭分时电价"
    docker rm -f teslamate-tou >/dev/null 2>&1 || true
    : > "$TOU_SQL_FILE"
    env_unset TM_TOU_PRICES
    env_unset TM_TOU_FILE
    env_unset TM_TOU_GEOFENCE
    ok "已停用分时电价计算，已算好的历史费用保留不动"
    return 0
  fi
  tou_enabled || return 0

  step "配置分时电价"
  docker inspect teslamate-db >/dev/null 2>&1 || die "teslamate-db 没在运行，先完整部署一次：bash deploy/deploy.sh"

  local rules="$WORK_DIR/tou.rules"
  tou_source > "$WORK_DIR/tou.src"
  tou_parse < "$WORK_DIR/tou.src" > "$rules" || die "电价配置有误：$(cat "$rules")"
  ok "电价配置校验通过：12 个月都有，每个月的时段都刚好覆盖 24 小时"

  local month_now
  month_now="$(TZ="${TM_TZ:-Asia/Shanghai}" date +%-m)"
  info "本月（${month_now} 月）的时段："
  awk -F'|' -v m="$month_now" '$1 == m { printf "      %s-%s  →  %s 元/度\n", $2, $3, $4 }' "$rules" | sort

  # ---- 选地理围栏
  local rows gf_id gf_name gf_cost line
  rows="$(db_query "select id, name, coalesce(cost_per_unit::text, '') from geofences order by id")"
  if [[ -z "$rows" ]]; then
    die "TeslaMate 里还没有地理围栏。先到 TeslaMate → Geo-Fences 新建一个“家”（电价那栏留空），再重跑"
  fi
  if [[ -n "$TOU_GEOFENCE" ]]; then
    line="$(printf '%s\n' "$rows" | awk -F'|' -v g="$TOU_GEOFENCE" '$1 == g || $2 == g' | head -n 1)"
    [[ -n "$line" ]] || die "找不到地理围栏「$TOU_GEOFENCE」。现有的围栏（ID|名字|固定电价）：
$(printf '%s\n' "$rows" | sed 's/^/      /')"
    IFS='|' read -r gf_id gf_name gf_cost <<< "$line"
  elif [[ "$(printf '%s\n' "$rows" | wc -l)" -eq 1 ]]; then
    IFS='|' read -r gf_id gf_name gf_cost <<< "$rows"
  else
    die "有多个地理围栏，请指定用哪个（写 ID 最省事）：TM_TOU_GEOFENCE=ID
      ID|名字|固定电价
$(printf '%s\n' "$rows" | sed 's/^/      /')"
  fi
  ok "作用于地理围栏：ID $gf_id「$gf_name」"

  if [[ -n "$gf_cost" ]]; then
    warn "这个围栏在 TeslaMate 里填了固定电价 $gf_cost：TeslaMate 会在充电结束时先按它写入费用，"
    warn "而分时电价只处理费用为空的记录，于是永远轮不到。"
    warn "请到 TeslaMate → Geo-Fences 编辑「$gf_name」，把电价清空保存，然后重算：TM_TOU_RECALC=1 bash deploy/deploy.sh --tou"
  fi

  if [[ -n "$TOU_FILE" ]]; then
    env_set TM_TOU_FILE "$TOU_FILE"
    env_unset TM_TOU_PRICES
  else
    env_set TM_TOU_PRICES "$TOU_PRICES"
    env_unset TM_TOU_FILE
  fi
  env_set TM_TOU_GEOFENCE "$gf_id"

  # 原地写：.tou.sql 是单文件挂载，换 inode 的话容器里看到的还是旧文件
  tou_sql "$rules" "$gf_id" > "$WORK_DIR/tou.sql"
  cat "$WORK_DIR/tou.sql" > "$TOU_SQL_FILE"

  if [[ "${TM_TOU_RECALC:-0}" == "1" ]]; then
    do_backup
    local n
    n="$(db_query "with u as (update charging_processes set cost = null where geofence_id = $gf_id returning 1) select count(*) from u")"
    ok "已清空该围栏内 $n 次充电的费用，马上按当前电价重算"
  fi

  # 先在这里直接算一轮再起定时容器：既能马上看到结果，也顺便验证生成的 SQL 能跑。
  # 反过来的话，容器一启动就把活干完了，这里什么也看不到。
  local out
  if ! out="$(docker exec -i teslamate-db psql -U teslamate -d teslamate -X -q -t -A -v ON_ERROR_STOP=1 < "$TOU_SQL_FILE" 2>&1)"; then
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/      /'
    die "计费 SQL 执行失败（上面是报错）"
  fi
  if [[ -n "$out" ]]; then
    ok "本次算好了 $(printf '%s\n' "$out" | wc -l) 次充电（最多显示 10 条）："
    printf '%s\n' "$out" | tail -n 10 | sed 's/^/      /'
  else
    ok "目前没有待计算的充电"
  fi

  COMPOSE_PROFILES="$(compose_profiles)"
  export COMPOSE_PROFILES
  dc up -d teslamate-tou || die "teslamate-tou 启动失败"
  ok "定时计算已启动：以后每次在这个围栏里充完电，5 分钟内自动算好"
  dim "计算记录：docker logs -f teslamate-tou"
}

print_next_steps() {
  cat <<EOF

${C_BOLD}${C_GREEN}==================== 部署完成 ====================${C_RESET}

${C_BOLD}1) Cloudflare DNS（还没加的话）${C_RESET}
     类型 A   名称 ${DOMAIN%%.*}   内容 ${SERVER_IP}   代理状态 ${C_YELLOW}仅 DNS（灰云）${C_RESET}
   Caddy 会自动走 Let's Encrypt 签证书，看进度：
     docker logs -f ${CADDY_CONTAINER} 2>&1 | grep -i ${DOMAIN}
   拿到正式证书后，想切橙云就和 poker 一样：切橙云 + SSL/TLS 模式 Full。
   ${C_DIM}（自用服务一直保持灰云也完全可以，证书续期最省心。）${C_RESET}

${C_BOLD}2) 登录信息${C_RESET}
     TeslaMate   https://${DOMAIN}/
EOF
  if [[ -n "$NEW_WEB_PASSWORD" ]]; then
    printf '                 用户名 %s   密码 %s%s%s   %s← 只显示这一次，请记下%s\n' \
      "$WEB_USER" "$C_BOLD" "$NEW_WEB_PASSWORD" "$C_RESET" "$C_YELLOW" "$C_RESET"
  else
    printf '                 用户名 %s   密码沿用上次（忘了就：TM_WEB_PASSWORD=新密码 bash deploy/deploy.sh）\n' "$WEB_USER"
  fi
  cat <<EOF
     Grafana     https://${DOMAIN}/grafana
                 用户名 admin   密码见 ${ENV_FILE} 里的 TM_GRAFANA_PW

${C_BOLD}3) 连上你的车${C_RESET}
   在自己电脑上运行 tesla_auth 拿到 Access Token / Refresh Token，
   粘贴到 TeslaMate 登录页。国区账号会按 token 自动走 tesla.cn，不用额外配置。
   登录后到 Settings → URLs：
     Web App    https://${DOMAIN}
     Dashboards https://${DOMAIN}/grafana

${C_BOLD}常用命令${C_RESET}
   升级            bash deploy/deploy.sh
   备份数据库      bash deploy/deploy.sh --backup
   分时电价        TM_TOU_FILE=deploy/tou/shandong-ev.conf bash deploy/deploy.sh --tou
   换肤开 / 关     TM_THEME=on|off bash deploy/deploy.sh   ${C_DIM}（当前：$(case "$THEME_STATUS" in on) printf '已启用' ;; failed) printf '已开启但没生效，见上方 ⚠，网页暂为原版' ;; *) printf '已关闭，原版界面' ;; esac)）${C_RESET}
   看日志          docker logs -f teslamate
   下线            bash deploy/deploy.sh --rollback   ${C_DIM}（数据卷保留）${C_RESET}

${C_BOLD}Caddyfile 备份：${C_RESET}$( [[ "$CADDY_MODIFIED" -eq 1 ]] && printf '%s' "$BACKUP_FILE" || printf '本次未修改' )

EOF
}

do_backup() {
  step "备份 TeslaMate 数据库"
  docker inspect teslamate-db >/dev/null 2>&1 || die "teslamate-db 容器不存在"
  mkdir -p "$PROJECT_DIR/backups"
  local f="$PROJECT_DIR/backups/teslamate-$(date +%Y%m%d-%H%M%S).sql.gz"
  docker exec teslamate-db pg_dump -U teslamate teslamate | gzip > "$f"
  chmod 600 "$f"
  ok "已备份 → $f（$(du -h "$f" | cut -f1)）"
  dim "恢复方法见 https://docs.teslamate.org/docs/maintenance/backup_restore"
}

require_domain() {
  [[ -n "$DOMAIN" ]] && return 0
  die "没有设置站点域名。首次部署这样运行（之后会记在 .env 里）：

    TM_DOMAIN=tm.example.com bash deploy/deploy.sh"
}

do_deploy() {
  require_domain
  printf '%s%sTeslaMate —— 开始部署（域名 %s）%s\n' "$C_BOLD" "$C_BLUE" "$DOMAIN" "$C_RESET"
  check_prereq
  detect_caddy
  prepare_env
  start_stack
  update_caddyfile add
  final_check
  configure_tou
  print_next_steps
}

do_tou() {
  [[ -n "$TOU_PRICES" || -n "$TOU_FILE" ]] || die "请给出电价，例如：
    按季节变化：TM_TOU_FILE=deploy/tou/shandong-ev.conf bash deploy/deploy.sh --tou
    全年一套：  TM_TOU_PRICES='23:00-07:00=0.3,07:00-23:00=0.6' bash deploy/deploy.sh --tou
  关闭：TM_TOU_PRICES=off bash deploy/deploy.sh --tou"
  [[ -f "$ENV_FILE" ]] || die "找不到 $ENV_FILE，先完整部署一次：TM_DOMAIN=... bash deploy/deploy.sh"
  configure_tou
}

do_rollback() {
  printf '%s%sTeslaMate —— 回滚%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  detect_caddy
  update_caddyfile remove
  step "停止并移除容器（不加 -v，数据卷保留）"
  # 带上所有 profile，compose 才认得 teslamate-theme / teslamate-tou，否则它们会被落下
  export COMPOSE_PROFILES=theme,tou
  [[ -f "$TOU_SQL_FILE" ]] || : > "$TOU_SQL_FILE"
  dc down --remove-orphans || warn "docker compose down 失败，可手工 docker rm -f teslamate teslamate-db teslamate-grafana teslamate-mqtt teslamate-tou teslamate-theme"
  cat <<EOF

${C_BOLD}${C_GREEN}回滚完成。${C_RESET}
  · 容器已下线，Caddyfile 里的站点块已移除并 reload，matrix / poker 不受影响。
  · 行车数据仍在数据卷里，重新 bash deploy/deploy.sh 即可恢复。
  · 真要彻底删除数据：docker volume rm teslamate_teslamate-db teslamate_teslamate-grafana-data teslamate_mosquitto-conf teslamate_mosquitto-data
  · Cloudflare 上的 A 记录需要你手工删除。

EOF
}

case "${1:-}" in
  "")            do_deploy ;;
  --backup|-b)   do_backup ;;
  --rollback|-r) do_rollback ;;
  --tou)         do_tou ;;
  --help|-h)     awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *)             die "未知参数：$1（可用：--tou / --backup / --rollback / --help）" ;;
esac
