# 夸夸 Kuakua

团队内部互相夸夸的网站：发 **Kudos**（表扬，不限次数）或 **Peer Bonus**（附带积分，每人每月有额度）。整站跑在 Cloudflare 上（Workers + D1 + R2），由 Cloudflare Access 负责登录，没有需要维护的服务器。

**部署、升级、改配置：看 [AGENTS.md](AGENTS.md)**（写给 agent 的逐步指南，人也能照着做）。

## 功能

- 中文 / English 切换（默认中文，偏好记在服务端，Lark 通知也按这个语言发）
- 人员名单二选一：
  - **名单文件**（`DIRECTORY_SOURCE=roster`）：一份 CSV/JSON，列出邮箱、姓名、部门、职务、上级和头像；上传后网站一分钟内自动同步
  - **Lark / 飞书通讯录**（`DIRECTORY_SOURCE=lark`）：每天自动同步同事、部门、头像（只下载变了的头像），并发 Lark 通知
- 夸夸墙、表情回应（含一键 +1）、评论、个人主页、个人夸夸链接
- 抄送：被抄送的人能看到这条感谢（接了 Lark 时会收到通知）但不算被夸；默认推荐被夸同事的上级和你自己的上级
- 秘密夸：只有发送人、被夸的人和抄送的人能看到（夸夸墙、详情、个人主页、评论、表情都按这个过滤；别人打开链接是 404），不广播到群、不进首页关系图；首页总数、光荣榜和 Peer Bonus 报表这些不含内容的统计仍然计入
- 可以夸自己、抄送自己（Peer Bonus 不能发给自己）；夸自己不计入光荣榜和"最常感谢 TA 的人"
- 通知（各自可选）：
  - **Lark**：被夸的人收到"XX 夸了你"卡片，夸人的人收到回执（Peer Bonus 附本月剩余额度），可选同步广播到一个群；需要 Lark 通讯录
  - **邮件**（Cloudflare Email Service）：被夸、被抄送的人各收一封（夸自己或抄送自己时自己也收一封），按各自语言，回复即回复发送人；每个人可在主页关闭。名单和 Lark 两种来源都能用
- 品质标签（团队协作、使命必达……）可以按部署自定义（`VALUES_FILE`）
- 管理页（`ADMIN_EMAILS`）：光荣榜（最受感谢 / 最会夸人）、同事目录、手动同步名单、导出每月 Peer Bonus 报表（CSV）。光荣榜和同事目录对普通同事隐藏

## Peer Bonus 规则

- 每人每月额度 `BONUS_MONTHLY_ALLOWANCE`（默认 10），按 `APP_TIMEZONE` 每月 1 日重置
- 每份 Peer Bonus 固定给每位被夸的人 `BONUS_POINTS` 积分（默认 1，发送者不能选；多人时乘以人数）
- Peer Bonus 留言至少 10 个字；不能发给自己
- 发送者可以在当月删除自己的感谢（积分退回），管理员可以删除任意一条

## 架构

```
浏览器 → Cloudflare Access（邮箱登录）→ Worker（自定义域名）
                                         ├─ 静态资源  dist/（网页、字体，Workers Static Assets）
                                         ├─ D1        数据库（自带 30 天时间点还原）
                                         ├─ R2        头像、上传的名单
                                         └─ Cron      每日同步通讯录
```

- `src/server/` Worker
  - `worker.ts` 入口和路由；`settings.ts` 所有配置项的声明，`config.ts` 读取它们
  - `auth.ts` 校验 `Cf-Access-Jwt-Assertion`（issuer + AUD）
  - `store.ts` 数据层，`db.ts` D1 封装；结构在 `migrations/`
  - `directory.ts` 名单同步调度；`roster.ts` / `roster-file.ts` 名单；`lark.ts` Lark 通讯录同步和通知；`avatars.ts` R2 头像
- `src/web/` React 前端，部署时由 `scripts/build-web.ts` 打包到 `dist/`；字体自托管（`/fonts/*`，大陆可访问）
- `src/shared/values.ts` 品质标签和表情回应，前后端共用
- `scripts/` `config.ts`（`bun run doctor` / `bun run config`）、`deploy.sh`、`cloudflare-setup.sh`、`push-roster.ts`、`import-sqlite.ts`（从旧的本机部署迁移数据）
- `deploy/` 名单和品质标签的示例

## 常用命令

```bash
bun run doctor                       # 体检部署配置
bun run config list                  # 查看配置（密钥打码）；set KEY VALUE / unset KEY 修改
./scripts/cloudflare-setup.sh        # 准备 D1、R2、Access（幂等）
./scripts/deploy.sh                  # 部署 / 拉代码后重新部署
bun scripts/push-roster.ts           # 只上传改过的名单和头像
bunx wrangler tail -c local/wrangler.json   # 线上实时日志
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
bun run demo:seed      # 本地 D1 填演示数据（24 位假同事、64 条感谢）
bun run dev            # http://127.0.0.1:4381 ，本地 D1/R2，以 mushan@example.com（管理员）身份登录
bun run typecheck
```
