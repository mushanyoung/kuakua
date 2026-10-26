# 夸夸 Kuakua

团队内部互相夸夸的网站：发 **Kudos**（表扬，不限次数）或 **Peer Bonus**（附带积分，每人每月有额度）。整站跑在 Cloudflare 上（Workers + D1 + R2），由 Cloudflare Access 负责登录，没有需要维护的服务器。

**Agent 每次任务先读 [AGENTS.md](AGENTS.md)。** 部署、升级、改配置见 [部署指南](docs/deployment.md)，开发与工具链见 [开发流程](docs/development.md)。

## 功能

- 中文 / English 切换（默认中文，偏好记在服务端，Lark 通知也按这个语言发）
- 人员名单二选一：
  - **名单文件**（`DIRECTORY_SOURCE=roster`）：一份 CSV/JSON，列出邮箱、姓名、部门、职务、上级和头像；上传后网站一分钟内自动同步
  - **Lark / 飞书通讯录**（`DIRECTORY_SOURCE=lark`）：每天自动同步同事、部门、头像（只下载变了的头像），并发 Lark 通知
- 夸夸墙、表情回应（含一键 +1）、评论、个人主页、个人夸夸链接
- 接入 Lark / 飞书通讯录后，可在“夸谁”下选择机器人已加入的群，完整展开为同事，再逐一删除；自动去重并跳过已抄送的人（Peer Bonus 也跳过自己）。未同步或已停用的成员会提示跳过数量；超过每条 20 人时需手动删减后发送。
- 抄送：被抄送的人能看到这条感谢（接了 Lark 时会收到通知）但不算被夸；默认推荐被夸同事的上级和你自己的上级
- 秘密夸：只有发送人、被夸的人和抄送的人能看到（夸夸墙、详情、个人主页、评论、表情都按这个过滤；别人打开链接是 404），不广播到群、不进首页关系图；首页总数、光荣榜和 Peer Bonus 报表这些不含内容的统计仍然计入
- 可以夸自己、抄送自己（Peer Bonus 不能发给自己）；夸自己不计入光荣榜和"最常感谢 TA 的人"
- 每个人可以在自己的主页上传头像（JPG / PNG / WebP / GIF，最大 5 MB）；管理员也可以在其他人的主页修改头像。上传的头像优先显示，名单 / Lark 同步不会覆盖它；点击“恢复原头像”会删除上传的图片，恢复最新的名单 / Lark 头像，没有来源头像时显示首字头像。
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

TypeScript strict、React、Tailwind CSS；Node.js 26.12.1 + pnpm 12.15.0 用于开发、测试和构建。生产请求由 Cloudflare Workers 执行。模块边界和数据流见 [架构](docs/architecture.md)。

## 常用命令

```bash
pnpm run doctor                       # 体检部署配置
pnpm run config list                  # 查看配置（密钥打码）；set KEY VALUE / unset KEY 修改
./scripts/cloudflare-setup.sh        # 准备 D1、R2、Access（幂等）
./scripts/deploy.sh                  # 部署 / 拉代码后重新部署
node scripts/push-roster.ts           # 只上传改过的名单和头像
# 线上实时日志：Cloudflare Dashboard → Workers & Pages → 目标 Worker → Logs → Live
```

## Lark 应用需要的权限（`DIRECTORY_SOURCE=lark`）

在 [Lark 开发者后台](https://open.larksuite.com/app)（飞书：open.feishu.cn）给自建应用开通（应用身份）：

| 权限                                                                   | 用途                                       |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| `contact:contact.base:readonly`                                        | 读取通讯录                                 |
| `contact:user.base:readonly`                                           | 姓名、头像                                 |
| `contact:user.email:readonly`                                          | 邮箱，用来和登录邮箱对应                   |
| `contact:user.department:readonly`、`contact:department.base:readonly` | 部门                                       |
| `contact:user.employee:readonly`                                       | 职务、入职时间（可选）                     |
| `im:message:send_as_bot` + 开启机器人能力                              | 被夸时发通知（可选）                       |
| `im:chat:read`、`im:chat.members:read` + 开启机器人能力                | 从群聊展开被夸同事（可选，与通知开关独立） |

并把 **通讯录权限范围** 设为「全部成员」，然后发布新版本。离职或移出范围的同事会自动隐藏，但历史感谢保留。

群聊选人复用 `LARK_APP_ID` / `LARK_APP_SECRET`，需 `DIRECTORY_SOURCE=lark`。开通上述两项群权限并发布应用后，把应用机器人加入需要使用的群。站点内已登录用户可以选择这些群；当前使用应用身份，范围为[机器人所在的群](https://open.feishu.cn/document/server-docs/group/chat/list)，[读取群成员](https://open.feishu.cn/document/server-docs/group/chat-member/get)也要求机器人在群内。缺少权限时会显示配置提示，仍可手动选人。选群只用于填写被夸名单，通知继续按现有配置发送。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm run demo:seed      # 本地 D1 填演示数据（24 位假同事、64 条感谢）
pnpm run dev            # http://127.0.0.1:4381 ，本地 D1/R2，以 mushan@example.com（管理员）身份登录
pnpm exec playwright install chromium
pnpm run check        # 格式、lint、strict、unit、集成、e2e、生产构建
pnpm run typecheck
pnpm run test:avatars  # 本地 Workers / D1 / R2 头像回归测试（使用 Node.js）
pnpm run test:lark-chats # 群聊选人接口回归测试（本地 Lark stub + Workers / D1）
```

完整命令、覆盖范围、CI 和失败诊断见 [测试策略](docs/testing.md)。GitHub Actions 在 push / pull_request 执行相同检查。
