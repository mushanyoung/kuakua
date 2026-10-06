# 夸夸 Kuakua

团队内部互相夸夸的网站：发 **Kudos**（表扬，不限次数）或 **Peer Bonus**（附带积分，每人每月有额度）。由 Cloudflare Access 负责登录，一台机器上一个 Bun 进程 + SQLite 就能跑。

**部署、升级、改配置：看 [AGENTS.md](AGENTS.md)**（写给 agent 的逐步指南，人也能照着做）。

## 功能

- 中文 / English 切换（默认中文，偏好记在服务端，Lark 通知也按这个语言发）
- 人员名单二选一：
  - **名单文件**（`DIRECTORY_SOURCE=roster`）：一份 CSV/JSON，列出邮箱、姓名、部门、职务、上级和头像；文件改了自动同步
  - **Lark / 飞书通讯录**（`DIRECTORY_SOURCE=lark`）：自动同步同事、部门、头像（默认每 6 小时），并发 Lark 通知
- 夸夸墙、表情回应（含一键 +1）、评论、个人主页、个人夸夸链接
- 抄送：被抄送的人能看到这条感谢（接了 Lark 时会收到通知）但不算被夸；默认推荐被夸同事的上级和你自己的上级
- 秘密夸：只有发送人、被夸的人和抄送的人能看到（夸夸墙、详情、个人主页、评论、表情都按这个过滤；别人打开链接是 404），不广播到群、不进首页关系图；首页总数、光荣榜和 Peer Bonus 报表这些不含内容的统计仍然计入
- 可以夸自己、抄送自己（Peer Bonus 不能发给自己）；夸自己不计入光荣榜和"最常感谢 TA 的人"
- Lark 卡片通知：被夸的人收到"XX 夸了你"，夸人的人收到"你夸了 XX"回执（Peer Bonus 附本月剩余额度）；可选同步广播到一个群
- 品质标签（团队协作、使命必达……）可以按部署自定义（`VALUES_FILE`）
- 管理页（`ADMIN_EMAILS`）：光荣榜（最受感谢 / 最会夸人）、同事目录、手动同步名单、导出每月 Peer Bonus 报表（CSV）。光荣榜和同事目录对普通同事隐藏

## Peer Bonus 规则

- 每人每月额度 `BONUS_MONTHLY_ALLOWANCE`（默认 10），按 `APP_TIMEZONE` 每月 1 日重置
- 每份 Peer Bonus 固定给每位被夸的人 `BONUS_POINTS` 积分（默认 1，发送者不能选；多人时乘以人数）
- Peer Bonus 留言至少 10 个字；不能发给自己
- 发送者可以在当月删除自己的感谢（积分退回），管理员可以删除任意一条

## 架构

```
浏览器 → Cloudflare Access（邮箱登录）→ Cloudflare Tunnel → 127.0.0.1:PORT（本机 Bun 进程，systemd 管理）
                                                             ├─ SQLite  DATA_DIR/kuakua.db（每日备份到 DATA_DIR/backups，保留 14 天）
                                                             └─ 头像    DATA_DIR/avatars/
```

- `src/server/` Bun HTTP 服务
  - `settings.ts` 所有配置项的声明（默认值、说明、校验），`config.ts` 读取它们
  - `auth.ts` 校验 `Cf-Access-Jwt-Assertion`（issuer + AUD）
  - `directory.ts` 名单同步调度；`roster.ts` / `roster-file.ts` 名单文件；`lark.ts` Lark 通讯录同步和通知
  - `store.ts` 数据层，`db.ts` 结构迁移
- `src/web/` React 前端，由 Bun 的 HTML import 在启动时打包；字体自托管（`/fonts/*`，大陆可访问）
- `src/shared/values.ts` 品质标签和表情回应，前后端共用
- `scripts/` `config.ts`（`bun run doctor` / `bun run config`）、`deploy.sh`、`cloudflare-setup.sh`、`backup.ts`
- `deploy/` systemd 单元模板、名单和品质标签的示例

## 常用命令

```bash
bun run doctor                       # 体检部署配置
bun run config list                  # 查看配置（密钥打码）；set KEY VALUE 修改
./scripts/deploy.sh                  # 部署 / 拉代码后重新部署
./scripts/cloudflare-setup.sh        # 配置 Cloudflare tunnel、DNS、Access（幂等）
bun run sync                         # 立即同步一次名单 / 通讯录（也可以在管理页点）
sudo journalctl -u kuakua -f         # 日志（服务名见 SERVICE_NAME）
```

## Lark 应用需要的权限（`DIRECTORY_SOURCE=lark`）

在 [Lark 开发者后台](https://open.larksuite.com/app)（飞书：open.feishu.cn）给自建应用开通（应用身份）：

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
bun run dev            # http://127.0.0.1:4381 ，以 mushan@example.com（管理员）身份登录
bun run typecheck
```
