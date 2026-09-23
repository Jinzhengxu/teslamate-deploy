# teslamate-deploy

把 [TeslaMate](https://github.com/teslamate-org/teslamate)（自托管的特斯拉数据记录器）一键部署到一台**已经有 Caddy 容器占着 80/443** 的服务器上。

- 不占任何宿主端口：TeslaMate 和 Grafana 接入 Caddy 所在的 docker 网络，由 Caddy 反代并自动签 HTTPS 证书。
- 同一个域名：`https://你的域名/` 是 TeslaMate（前面加了一层密码），`https://你的域名/grafana` 是 Grafana（自带登录）。
- 改 Caddyfile 前自动备份，校验或 reload 失败自动回滚，不影响 Caddy 上已有的站点。
- 所有密钥首次运行时随机生成，保存在服务器本地的 `.env`，不进仓库。

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

域名会记进 `.env`，以后直接 `bash deploy/deploy.sh` 即可。运行结束会打印网页登录密码，**只显示这一次**；Grafana 的 admin 密码在 `.env` 的 `TM_GRAFANA_PW`。

**3. 连上车**

在自己电脑上用 [tesla_auth](https://github.com/adriankumpf/tesla_auth/releases/latest) 登录特斯拉账号，拿到 Access Token 和 Refresh Token，粘贴到 TeslaMate 登录页。国区账号会按 token 自动走 tesla.cn，不用额外配置。

登录后在 Settings → URLs 里填：Web App `https://你的域名`，Dashboards `https://你的域名/grafana`。

## 日常命令

```bash
cd /root/teslamate
git pull && bash deploy/deploy.sh                 # 升级（同时拉最新镜像）
bash deploy/deploy.sh --backup                    # 备份数据库到 backups/
TM_WEB_PASSWORD='新密码' bash deploy/deploy.sh     # 重置网页登录密码
bash deploy/deploy.sh --rollback                  # 下线并移除 Caddy 站点块（数据卷保留）
docker logs -f teslamate                          # 看日志
```

## 分时电价（可选）

TeslaMate 的地理围栏只能填一个固定电价。家里是峰谷电价的话，用 [TeslaMateAgile](https://github.com/AmyJeanes/TeslaMateAgile) 按时段算：它每 5 分钟检查一次新完成的充电，按每个时段实际充进去的电量分别计价，把费用写回 TeslaMate，所有页面和 Grafana 面板都能直接看到。

1. 在 TeslaMate → Geo-Fences 新建“家”的围栏，**电价那栏留空**（填了的话 TeslaMate 会先按固定价写入费用，分时电价就轮不到了）。
2. 在服务器上运行（时段必须刚好覆盖 24 小时，跨午夜可以写成 `23:00-07:00`，午夜写 `00:00`）：

```bash
TM_TOU_PRICES='23:00-07:00=0.3,07:00-23:00=0.6' bash deploy/deploy.sh --tou
```

- 只有一个围栏时自动选中；有多个时脚本会列出来，用 `TM_TOU_GEOFENCE=ID` 指定。
- 设置时围栏里已有、但还没算钱的历史充电会被自动补算。
- 改电价只影响之后的充电。要按新电价重算历史：`TM_TOU_RECALC=1 bash deploy/deploy.sh --tou`（会先自动备份数据库）。
- 夏季/非夏季电价不同时，换季时重新运行一次，填新的时段即可；已算好的历史费用不受影响。
- 阶梯电价没法按次计算（取决于当月累计用量），建议填你平时所在那一档的单价。
- 关闭：`TM_TOU_PRICES=off bash deploy/deploy.sh --tou`

## 可覆盖的环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TM_DOMAIN` | 无（必填） | 站点域名，首次给一次即可 |
| `TM_WEB_USER` | `teslamate` | 网页登录用户名 |
| `CADDY_CONTAINER` | `matrix-chat-caddy-1` | Caddy 容器名，找不到时自动搜名字含 caddy 的容器 |
| `CADDY_NETWORK` | 自动探测 | Caddy 所在的 docker 网络 |
| `CADDYFILE_HOST` | `/root/matrix-chat/Caddyfile` | 宿主上的 Caddyfile 路径 |
| `TM_TOU_GEOFENCE` | 自动 | 分时电价作用的地理围栏（名字或 ID） |
| `FORCE` | `0` | 设为 `1` 时内存不足也继续部署 |

## 注意

- `.env` 里的 `TM_ENCRYPTION_KEY` 和 `TM_DB_PASS` 生成后**不要改**，改了已保存的 token 解不开、数据库连不上。
- 特斯拉正在逐个账号关闭 TeslaMate 依赖的非官方 Owner API。如果 token 有效却一直拿不到数据，需要改用官方 Fleet API，见 [TeslaMate 文档](https://docs.teslamate.org/docs/configuration/api/)。
