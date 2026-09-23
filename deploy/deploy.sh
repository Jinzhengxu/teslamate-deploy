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
# 可覆盖的环境变量：
#   TM_DOMAIN         站点域名（必填，首次给一次即可；仓库里不写死任何人的域名）
#   TM_WEB_USER       网页登录用户名（默认 teslamate）
#   CADDY_CONTAINER   Caddy 容器名（默认 matrix-chat-caddy-1）
#   CADDY_NETWORK     Caddy 所在 docker 网络名（默认自动探测）
#   CADDYFILE_HOST    宿主上的 Caddyfile 路径（默认 /root/matrix-chat/Caddyfile）
#   FORCE=1           内存不足时也强行部署
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# 调用方显式给的值优先于 .env 里的
_override_domain="${TM_DOMAIN:-}"
_override_password="${TM_WEB_PASSWORD:-}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi
[[ -n "$_override_domain" ]] && TM_DOMAIN="$_override_domain"
TM_WEB_PASSWORD="$_override_password"
unset _override_domain _override_password

# ------------------------------------------------------------------ 参数与常量
DOMAIN="${TM_DOMAIN:-}"
WEB_USER="${TM_WEB_USER:-teslamate}"
CADDY_CONTAINER="${CADDY_CONTAINER:-matrix-chat-caddy-1}"
CADDYFILE_HOST="${CADDYFILE_HOST:-/root/matrix-chat/Caddyfile}"
CADDY_NETWORK="${CADDY_NETWORK:-}"
UPSTREAM_TIMEOUT=180

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
  ok "root / docker / compose / 项目文件 均就绪"

  # TeslaMate + Postgres + Grafana 常驻约 500MB。小机上硬塞，OOM killer 可能先杀掉 matrix。
  # 已经在跑的话不再拦：那部分内存早就算在已用里了。
  local mem_avail swap_total
  mem_avail="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)"
  swap_total="$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)"
  info "可用内存 ${mem_avail}MB，swap ${swap_total}MB"
  if docker inspect teslamate >/dev/null 2>&1; then
    dim "TeslaMate 已在运行，跳过内存门槛"
  elif [[ "$mem_avail" -lt 700 && "$swap_total" -lt 1024 ]]; then
    warn "内存偏紧：TeslaMate 全家大约要 500MB，而且没有足够的 swap 兜底。"
    warn "建议先加 2G swap（一次性，重启后仍有效）："
    dim "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    dim "echo '/swapfile none swap sw 0 0' >> /etc/fstab"
    [[ "${FORCE:-0}" == "1" ]] || die "为保护已有服务先停在这里。加好 swap 后重跑；确认要硬上就用 FORCE=1 bash deploy/deploy.sh"
    warn "FORCE=1，继续部署"
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
  chmod 600 "$ENV_FILE"
}

start_stack() {
  step "拉取镜像并启动（不映射任何宿主端口）"
  mkdir -p "$PROJECT_DIR/import"
  dc pull || die "镜像拉取失败"
  dc up -d --remove-orphans || die "docker compose up 失败"
  ok "容器已启动"

  # 从 Caddy 容器里去连上游：顺带验证了"两边确实在同一个 docker 网络"
  if ! caddy_exec sh -c 'command -v wget' >/dev/null 2>&1; then
    warn "Caddy 容器里没有 wget，跳过上游连通性检查"
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
  print_next_steps
}

do_rollback() {
  printf '%s%sTeslaMate —— 回滚%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  detect_caddy
  update_caddyfile remove
  step "停止并移除容器（不加 -v，数据卷保留）"
  dc down --remove-orphans || warn "docker compose down 失败，可手工 docker rm -f teslamate teslamate-db teslamate-grafana teslamate-mqtt"
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
  --help|-h)     sed -n '2,25p' "$0" ;;
  *)             die "未知参数：$1（可用：--backup / --rollback / --help）" ;;
esac
