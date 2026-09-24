# teslamate-deploy

把 [TeslaMate](https://github.com/teslamate-org/teslamate)（自托管的特斯拉数据记录器）一键部署到一台**已经有 Caddy 容器占着 80/443** 的服务器上。

- 不占任何宿主端口：TeslaMate 和 Grafana 接入 Caddy 所在的 docker 网络，由 Caddy 反代并自动签 HTTPS 证书。
- 同一个域名：`https://你的域名/` 是 TeslaMate，`https://你的域名/grafana` 是 Grafana，两边共用一个登录页。每台设备登录一次就会记住，不用每次输密码，进 Grafana 也不用再登录。
- 改 Caddyfile 前自动备份，校验或 reload 失败自动回滚，不影响 Caddy 上已有的站点。
- 所有密钥首次运行时随机生成，保存在服务器本地的 `.env`，不进仓库。

> This project is an unofficial community tool and is not affiliated with, endorsed by, or supported by the official TeslaMate project.
>
> 本项目是非官方的社区工具，与 TeslaMate 官方项目没有任何关联，也未获其认可或支持。

## 前提

- 服务器上有一个正在运行的 Caddy 容器，Caddyfile 以文件方式挂进去（默认按 `matrix-chat-caddy-1` + `/root/matrix-chat/Caddyfile`，不同可用环境变量覆盖，见下）
- Docker 和 Docker Compose v2
- 可用内存 + 空闲 swap 合计至少 800MB（TeslaMate 全家约占 500MB）。不够时脚本会停下，并给出不会覆盖已有 swap 的加 swap 命令

## 部署

**1. 加 DNS 记录**（先做，Caddy 才能立刻签证书）

在 Cloudflare 添加 A 记录，指向服务器 IP，**代理状态选“仅 DNS”（灰云）**。
橙云会拦住 Let's Encrypt 的 HTTP-01 验证。拿到证书后想切橙云，记得把 SSL/TLS 模式设为 Full。

**2. 拉代码并运行**（root）

```bash
git clone https://github.com/Jinzhengxu/teslamate-deploy.git /root/teslamate
cd /root/teslamate
TM_DOMAIN=tm.example.com bash deploy/deploy.sh
```

域名会记进 `.env`，以后直接 `bash deploy/deploy.sh` 即可。运行结束会打印网页登录密码，**只显示这一次**。Grafana 不用单独登录（它自己的 admin 密码在 `.env` 的 `TM_GRAFANA_PW`，平时用不到）。

**3. 连上车**

在自己电脑上用 [tesla_auth](https://github.com/adriankumpf/tesla_auth/releases/latest) 登录特斯拉账号，拿到 Access Token 和 Refresh Token，粘贴到 TeslaMate 登录页。国区账号会按 token 自动走 tesla.cn，不用额外配置。

登录后在 Settings → URLs 里填：Web App `https://你的域名`，Dashboards `https://你的域名/grafana`。

## 日常命令

```bash
cd /root/teslamate
git pull && bash deploy/deploy.sh                 # 升级（同时拉最新镜像）
bash deploy/deploy.sh --backup                    # 备份数据库到 backups/
TM_WEB_PASSWORD='新密码' bash deploy/deploy.sh     # 重置网页登录密码（所有设备都要重新登录）
bash deploy/deploy.sh --rollback                  # 下线并移除 Caddy 站点块（数据卷保留）
docker logs -f teslamate                          # 看日志
```

## 登录

TeslaMate 本身没有登录，谁打开网址都能看到车的实时位置，所以 Caddy 在前面加了一道密码：

- 打开网站先看到登录页。登录一次，这台设备就会记住（浏览器保存一个 400 天的 cookie，每次打开页面自动续期，常用的设备就一直不用再输）。
- Grafana 在同一道登录后面：登录过的设备点「控制台」里的面板直接进，不再要 Grafana 的密码。
- 退出当前设备：打开 `https://你的域名/_auth/logout`。
- 手机丢了、或者在别人电脑上登录过：重置密码，所有设备都会退出。

验证全在 Caddy 里完成，不依赖换肤代理，换肤代理挂了也不会绕过登录。

## 网页换肤（默认开启）

TeslaMate 自带的网页比较朴素。这里在 Caddy 和 TeslaMate 之间夹了一个很小的 nginx（`teslamate-theme`，约 5MB 内存），给每个页面加一份新样式，TeslaMate 本身一行不改，升级镜像照常：

- 手机优先：底部标签栏（主页 / 控制台 / 收藏点 / 设置），「控制台」点开是一个 Grafana 面板列表；输入框不小于 16px，iPhone 上点输入框不会自动放大页面。
- 首页车辆卡片：状态胶囊（充电绿、行驶蓝、正在休眠琥珀），大号电量加电量条（带充电上限刻度），「100% 时续航」直接显示，其余数据排成两列（桌面三列）小卡片；没锁车、车门车窗开着、胎压低这类图标标成琥珀色。
- 设置页改成 iOS 那种分组列表；收藏点列表整行可点、编辑页地图顶满卡片；充电费用、登录页统一成卡片式。
- 亮 / 暗两套配色跟随 TeslaMate「设置 → 主题」，文字对比度按 WCAG AA 调过。
- 不从外网加载任何字体或脚本，国内打开不受影响。

换肤代理挂了也不影响使用：Caddy 会自动改为直连 TeslaMate，只是变回原版界面。样式在 [deploy/theme/assets/](deploy/theme/assets/)，改完 `git pull` 后浏览器刷新即生效。

```bash
TM_THEME=off bash deploy/deploy.sh    # 关掉，恢复原版界面
TM_THEME=on bash deploy/deploy.sh     # 重新打开
```

## 分时电价（可选）

TeslaMate 的地理围栏只能填一个固定电价。家里是分时电价（尤其是像山东这样按月份换时段的）时，用这里的分时计费：每 5 分钟检查一次该围栏里刚结束、还没算钱的充电，把每段电量按它所在的**本地月份和时刻**查电价，费用写回 TeslaMate，所有页面和 Grafana 面板都能直接看到。它只读写本地数据库，不和特斯拉通信，不影响车休眠。

1. 在 TeslaMate → Geo-Fences 新建“家”的围栏，**电价那栏留空**（填了的话 TeslaMate 会先按固定价写入费用，分时电价就轮不到了）。
2. 在服务器上运行，二选一：

```bash
# 按月份变化的电价：用配置文件。仓库自带山东（含济南）居民充电桩 2026-10-01 起的时段
TM_TOU_FILE=deploy/tou/shandong-ev.conf bash deploy/deploy.sh --tou

# 全年同一套时段：直接写在命令行
TM_TOU_PRICES='23:00-07:00=0.3,07:00-23:00=0.6' bash deploy/deploy.sh --tou
```

配置文件格式见 [deploy/tou/shandong-ev.conf](deploy/tou/shandong-ev.conf)：`[1-2,12]` 开一组月份，下面每行一个 `HH:MM-HH:MM=电价`。12 个月都要有，每组必须刚好覆盖 24 小时（跨午夜写 `23:00-07:00`，午夜写 `00:00`），写错了脚本会指出是哪个月哪一分钟漏了或重复了。

- 只有一个围栏时自动选中；有多个时脚本会列出来，用 `TM_TOU_GEOFENCE=ID` 指定。
- 设置时围栏里已有、还没算钱的历史充电会马上补算，并显示结果。
- 跨季节、跨午夜的充电按每段各自所在的月份和时刻分别计价。
- 电价或时段变了（国网山东每年 11 月公布下一年的时段）：改配置文件后重新运行 `--tou`。只影响之后的充电；要按新规则重算历史：`TM_TOU_RECALC=1 bash deploy/deploy.sh --tou`（会先自动备份数据库）。
- 阶梯电价没法按次计算（取决于当月累计用量），填你平时所在那一档的单价。
- 关闭：`TM_TOU_PRICES=off bash deploy/deploy.sh --tou`
- 计算记录：`docker logs -f teslamate-tou`

## 可覆盖的环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TM_DOMAIN` | 无（必填） | 站点域名，首次给一次即可 |
| `TM_WEB_USER` | `teslamate` | 网页登录用户名 |
| `CADDY_CONTAINER` | `matrix-chat-caddy-1` | Caddy 容器名，找不到时自动搜名字含 caddy 的容器 |
| `CADDY_NETWORK` | 自动探测 | Caddy 所在的 docker 网络 |
| `CADDYFILE_HOST` | `/root/matrix-chat/Caddyfile` | 宿主上的 Caddyfile 路径 |
| `TM_TOU_FILE` | 无 | 分时电价配置文件（按月份变化时用） |
| `TM_TOU_GEOFENCE` | 自动 | 分时电价作用的地理围栏（名字或 ID） |
| `TM_THEME` | `on` | 网页换肤开关（`on` / `off`），给过一次就记进 `.env` |
| `FORCE` | `0` | 设为 `1` 时内存不足也继续部署 |

## 注意

- `.env` 里的 `TM_ENCRYPTION_KEY` 和 `TM_DB_PASS` 生成后**不要改**，改了已保存的 token 解不开、数据库连不上。
- 特斯拉正在逐个账号关闭 TeslaMate 依赖的非官方 Owner API。如果 token 有效却一直拿不到数据，需要改用官方 Fleet API，见 [TeslaMate 文档](https://docs.teslamate.org/docs/configuration/api/)。
