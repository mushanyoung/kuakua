# 夸夸 Kuakua

内部互相夸夸的网站：发 **Kudos**（公开表扬，不限次数）或 **Peer Bonus**（附带积分，每人每月有额度）。
线上地址：https://kuakua.maxinsights.ai （Cloudflare Access 保护，仅限 `@maxinsights.ai` 邮箱）

- 中文 / English 切换（默认中文，偏好会记到服务端，Lark 通知也按这个语言发）
- 从 Lark 通讯录同步所有同事、部门、头像（每 6 小时一次，头像缓存在本地）
- 夸夸墙、表情回应（含一键 +1）、评论、个人主页
- 抄送：被抄送的同事收到 Lark 通知但不算被夸；默认推荐被夸同事的上级和你自己的上级
- Lark 卡片通知：被夸的人收到"XX 夸了你"，夸人的人收到"你夸了 XX"回执（Peer Bonus 附本月剩余额度）；可选同步广播到一个群
- 管理页（目前只有 `mushan@maxinsights.ai`，写死在 `src/server/config.ts` 的 `ADMIN_EMAILS`）：光荣榜（最受感谢 / 最会夸人）、同事目录、手动同步通讯录、导出每月 Peer Bonus 报表（CSV）。光荣榜和同事目录对普通同事隐藏

## 架构

```
浏览器 → Cloudflare Access（公司邮箱登录）→ Cloudflare Tunnel → 127.0.0.1:4380（本机 Bun 进程）
                                                                 ├─ SQLite  data/kuakua.db（每日备份到 data/backups，保留 14 天）
                                                                 └─ 头像    data/avatars/
```

- `src/server/` Bun HTTP 服务：`auth.ts` 校验 `Cf-Access-Jwt-Assertion`（issuer + AUD），`lark.ts` 负责通讯录同步和通知，`store.ts` 是数据层
- `src/web/` React 前端，由 Bun 的 HTML import 在启动时打包；字体自托管（`/fonts/*`，大陆可访问）
- `src/shared/values.ts` 品质标签和表情回应的定义，前后端共用

## 运维

```bash
sudo systemctl status kuakua          # 服务状态
sudo journalctl -u kuakua -f          # 日志（含 [lark] 同步结果）
sudo systemctl restart kuakua         # 改了代码或 .env.production 之后
bun run sync                          # 立即同步一次 Lark 通讯录（也可以在网站「管理」页点）
```

配置在 `.env.production`（权限 600，不进 git），字段说明见 `.env.example`。

Cloudflare 配置（DNS、Tunnel 路由、Access 应用和 `/healthz` 放行）由 `scripts/cloudflare-setup.sh` 完成，可重复执行：

```bash
CLOUDFLARE_ENV_FILE=/mnt/conf/repomind/config/cloudflare.env ./scripts/cloudflare-setup.sh   # 输出 Access AUD
```

`systemd` 单元文件在 `deploy/kuakua.service`，修改后 `sudo cp deploy/kuakua.service /etc/systemd/system/ && sudo systemctl daemon-reload`。

## Lark 应用需要的权限

在 [Lark 开发者后台](https://open.larksuite.com/app) 给应用开通（应用身份）：

| 权限 | 用途 |
|---|---|
| `contact:contact.base:readonly` | 读取通讯录 |
| `contact:user.base:readonly` | 姓名、头像 |
| `contact:user.email:readonly` | 邮箱，用来和登录邮箱对应 |
| `contact:user.department:readonly`、`contact:department.base:readonly` | 部门 |
| `contact:user.employee:readonly` | 职务、入职时间（可选） |
| `im:message:send_as_bot` + 开启机器人能力 | 被夸时发通知（可选） |

并把 **通讯录权限范围** 设为「全部成员」，然后发布新版本。离职或移出范围的同事会自动隐藏，但历史感谢保留。

## 本地开发

```bash
bun install
bun run demo:seed      # 在 ./data-demo 生成演示数据（24 位假同事、64 条感谢）
bun run dev            # http://127.0.0.1:4381 ，以 mushan@maxinsights.ai 身份登录
bun run typecheck
```

## Peer Bonus 规则（可在 .env.production 调整）

- 每人每月额度 `BONUS_MONTHLY_ALLOWANCE`（默认 10），按 `APP_TIMEZONE`（默认北京时间）每月 1 日重置
- 单次可选积分 `BONUS_AMOUNTS`（默认 1 / 2 / 5，按人计，多人时乘以人数）
- Peer Bonus 留言至少 10 个字；不能发给自己
- 发送者可以在当月删除自己的感谢（积分退回），管理员可以删除任意一条
