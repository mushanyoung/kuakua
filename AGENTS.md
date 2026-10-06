# AGENTS.md — 部署与维护指南

给负责部署、升级、改配置的 agent 看的。和人沟通用对方的语言；命令、配置项名保持原样。

夸夸跑在 Cloudflare 上：一个 Worker（接口 + 网页）、D1（数据库）、R2（头像和上传的名单）、Cloudflare Access（登录）。没有需要维护的服务器；任何装了这个仓库和凭据的电脑都能部署。

## 先记住这几条

- **部署相关的一切都在 git 之外**，`git pull` 不会碰它们：
  - `.env.production` 部署配置（含密钥，权限 600）
  - `.env.cloudflare` Cloudflare API 凭据（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；也可以用 `CLOUDFLARE_ENV_FILE` 指向别处）
  - `local/` 名单 `roster.csv`、头像、`values.json`，以及脚本生成的 `wrangler.json`、上次部署记录
- **不要为了某个部署改代码或提交上面这些文件。** 需要新的可配置项时，在 `src/server/settings.ts` 里声明（见文末"改代码"）。
- 所有配置项的唯一来源是 `src/server/settings.ts`；`.env.example` 是从它生成的。部署时，`deploy.sh` 把其中给 Worker 的项变成 Worker 的变量和密钥。
- 工具：
  - `bun run doctor` 体检配置：缺什么、错什么、有哪些新配置项还没确认过（只读，随时可跑）
  - `bun run config set KEY VALUE` / `unset KEY` 改配置（`list` / `get KEY` 查看，密钥会打码）
  - `./scripts/cloudflare-setup.sh` 准备 Cloudflare 账号里的 D1、R2、Access（幂等）
  - `./scripts/deploy.sh` 部署或重新部署（幂等）

## 任务 A：首次部署（新的 Cloudflare 账号）

### 0. 准备

一台装了 git、curl、jq、[bun](https://bun.sh)（≥ 1.4）的电脑（Linux / macOS）。

```bash
git clone <repo> kuakua && cd kuakua
bun install
```

### 1. 和运维人员逐项确认配置

先跑 `bun run doctor`，它会列出每一项。下面这些需要问人，问清楚后用 `bun run config set KEY VALUE` 写进去：

| 要问的 | 写到 | 说明 |
|---|---|---|
| 网站地址 | `PUBLIC_URL` | `https://<hostname>`；hostname 所在的域名必须在他们的 Cloudflare 账号里 |
| 管理员邮箱 | `ADMIN_EMAILS` | 逗号分隔；管理员能同步名单、导出 Peer Bonus 报表、看光荣榜、删任何帖子 |
| 人员名单来源 | `DIRECTORY_SOURCE` | `roster`（一份名单文件）或 `lark`（Lark/飞书通讯录每日同步，需要 `LARK_*`） |
| 名单文件 | `ROSTER_FILE` | 默认 `./local/roster.csv`。格式见下文；向对方要名单和头像 |
| 额外允许登录的邮箱域名 | `ALLOWED_EMAIL_DOMAINS` | 可空。空 = 只有名单里的人和管理员能登录 |
| 时区 | `APP_TIMEZONE` | 每月 1 日零点重置 Peer Bonus 额度 |
| 品质标签 | `VALUES_FILE` | 可空（用内置 8 个）；要自定义就照 `deploy/values.example.json` 写到 `local/values.json` |
| Peer Bonus 额度 | `BONUS_MONTHLY_ALLOWANCE`、`BONUS_POINTS` | 每人每月可送出的积分、每份给每人的积分 |
| 数据放在哪 | `DATA_LOCATION` | D1 和 R2 的区域；用户在亚洲就填 `apac`。只在第一次创建时生效 |
| 同一账号多个部署？ | `WORKER_NAME` | 每个部署一个名字（D1、R2 跟着它命名） |
| Lark 每日同步时间 | `SYNC_CRON` | UTC 的 cron，默认 `0 19 * * *`（北京时间凌晨 3 点） |

`doctor` 里 "Not in the config file yet" 下列出的项，即使用默认值也请 `config set` 一次写进文件——这样以后升级时，新增的配置项才会单独显眼地出现在这个列表里。

#### 名单格式（`DIRECTORY_SOURCE=roster`）

CSV，第一行是表头，列顺序随意，只有 `email`、`name` 必填。也可以用同样字段的 JSON 数组（文件名以 `.json` 结尾）。示例：`deploy/roster.example.csv`。

| 列 | 说明 |
|---|---|
| `email` | 登录邮箱（Cloudflare Access 用它识别人），不区分大小写，不能重复 |
| `name` | 显示名 |
| `en_name` | 英文名（英文界面用） |
| `department` / `department_en` | 部门及英文名 |
| `title` | 职务 |
| `manager` | 上级的邮箱（抄送时会推荐"TA 的上级"） |
| `avatar` | 头像：名单文件所在文件夹里的相对路径（如 `avatars/alice.jpg`），或 https 链接。JPEG/PNG/WebP/GIF，建议 ≤ 640px 方图；没有就用渐变色首字头像 |

`#` 开头的行会被忽略。名单和头像由 `deploy.sh`（或单独的 `bun scripts/push-roster.ts`）上传，网站一分钟内自动同步：新人出现、改名生效、从名单里删掉的人被停用（历史感谢保留）。名单有任何错误时整份不生效，错误显示在管理页。

### 2. Cloudflare

请运维人员：

1. 在 Cloudflare 账号里打开一次 **Zero Trust**，起一个 team 名，并在 Settings → Authentication 加一个登录方式（One-time PIN 最简单，Google 等也可以）。
2. 打开 **R2**（免费额度够用）。用 Lark 同步的部署建议开 **Workers 付费版**（$5/月）：免费版每次运行只能发 50 个外部请求，Lark 全量同步不够。
3. 创建一个 API Token（My Profile → API Tokens → Create Custom Token），权限：
   - Account › Workers Scripts: Edit
   - Account › D1: Edit
   - Account › Workers R2 Storage: Edit
   - Account › Access: Apps and Policies: Edit
   - Account › Access: Organizations, Identity Providers, and Groups: Read
   - Account › Account Settings: Read
   - Zone › Workers Routes: Edit、Zone › DNS: Edit（网站域名所在的 zone）
4. 把它写进 `.env.cloudflare`（`chmod 600`）：
   ```
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   ```

然后：

```bash
./scripts/cloudflare-setup.sh
```

它会建/复用 D1、R2、Access 策略和应用，并把 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`D1_DATABASE_ID` 写进 `.env.production`。如果它说 hostname 上还有别的 DNS 记录，那条记录会挡住 Worker；确认可以替换后用 `--replace-dns` 重跑。

### 3. 部署

```bash
bun run doctor        # 必须没有 ✗
./scripts/deploy.sh
```

脚本最后会等到 `https://<hostname>/healthz` 跑的是这次的版本才算成功。让管理员打开网站登录：管理页的"名单同步 / Lark 通讯录同步"显示成功、人数对得上（Lark 模式可点"立即同步"，不用等到夜里）。

## 任务 B：升级（拉了新代码之后）

```bash
git pull --ff-only
bun run doctor
```

- 有 ✗：通常是新版本加了必填项，按提示问人、`config set`。
- 有 "is not a known setting"：新版本不再用这一项，确认后 `bun run config unset KEY`。
- "Not in the config file yet" 里有新出现的项：新版本加的可选配置。向运维人员说明它是什么、默认值是什么，按他们的选择 `config set`（保留默认也写一次）。
- 如果改了 `ADMIN_EMAILS`、`ALLOWED_EMAIL_DOMAINS`、名单里的邮箱或 `PUBLIC_URL`：重跑 `./scripts/cloudflare-setup.sh`。

然后 `./scripts/deploy.sh`。它会先列出自上次部署以来的提交（读一下，告诉运维人员这次更新了什么），再装依赖、体检、打包、记下数据库还原点、迁移数据库结构、上传名单、部署并确认新版本已上线。

## 任务 C：日常改配置

| 想做的事 | 怎么做 |
|---|---|
| 加人 / 删人 / 改名 / 换上级 / 换头像 | 改名单文件和头像 → `bun scripts/push-roster.ts`（或整个 `./scripts/deploy.sh`），一分钟内生效。加删了邮箱的话再跑 `./scripts/cloudflare-setup.sh` 更新登录名单 |
| 改 `.env.production` 里任何一项 | `bun run config set KEY VALUE` → `./scripts/deploy.sh` |
| 改品质标签 | 改 `VALUES_FILE` 指向的文件 → `./scripts/deploy.sh`。已用过的标签 id 不要删改，否则旧帖子上的标签不再显示 |
| 换域名 | `config set PUBLIC_URL ...` → `./scripts/cloudflare-setup.sh` → `./scripts/deploy.sh` |

## 从旧的"本机部署"迁过来（一次性）

旧版本在一台机器上用 systemd + Cloudflare Tunnel 运行，数据在 `DATA_DIR`（默认 `./data`）里的 SQLite 和头像文件夹。在那台机器上：

1. `git pull`，`bun install`，按 `bun run doctor` 的提示补新配置（`WORKER_NAME`、`DATA_LOCATION`、`SYNC_CRON`、`CLOUDFLARE_ENV_FILE`…），`unset` 不再用的 `PORT`、`HOST`、`DATA_DIR`、`SERVICE_NAME`、`LARK_SYNC_INTERVAL_HOURS`。
2. 先用一个**测试地址**验证：`config set PUBLIC_URL https://<测试 hostname>` → `./scripts/cloudflare-setup.sh` → `bun scripts/import-sqlite.ts data/kuakua.db` → `./scripts/deploy.sh`，请人登录测试地址看数据是否完整。
3. 切换正式地址：
   ```bash
   sudo systemctl stop kuakua                          # 旧站停止写入
   bun run config set PUBLIC_URL https://<正式 hostname>
   bun scripts/import-sqlite.ts data/kuakua.db          # 用最新数据覆盖 D1
   ./scripts/cloudflare-setup.sh --replace-dns          # 删掉指向 tunnel 的 CNAME
   ./scripts/deploy.sh                                  # Worker 接管正式地址
   ```
   确认正式地址正常后：`sudo systemctl disable kuakua`；tunnel 里这个 hostname 的路由可以删掉。旧数据目录保留作备份。

## 回滚与排障

- 实时日志：`bunx wrangler tail -c local/wrangler.json`（`-c` 用 `deploy.sh` 生成的配置）。
- 回滚代码：`bunx wrangler rollback -c local/wrangler.json`（回到上一个版本），或 `git checkout <commit>` → `./scripts/deploy.sh`。
- 回滚数据：每次部署前的 D1 还原点记在 `local/last-deploy` 第三列；`bunx wrangler d1 time-travel restore <WORKER_NAME> --bookmark <还原点> -c local/wrangler.json`。D1 自带 30 天内任意时刻的还原（付费版；免费版 7 天）。
- 有人登录后看到 `email_domain_not_allowed`：他的邮箱不在名单 / Lark 通讯录、`ALLOWED_EMAIL_DOMAINS`、`ADMIN_EMAILS` 里。
- 被 Cloudflare 登录页拦住：重跑 `./scripts/cloudflare-setup.sh`（名单变了要更新 Access 策略），检查 Zero Trust 里的登录方式。

## 改代码时

- 本地开发：`bun run demo:seed`（本地 D1 填演示数据），`bun run dev`（http://127.0.0.1:4381，用本地 D1/R2，以 `wrangler.jsonc` 里的 `DEV_AUTH_EMAIL` 管理员身份登录；请求头 `X-Dev-Email` 可以切换成别人），`bun run typecheck`。
- 改了 `wrangler.jsonc` 的绑定或变量：`bun run types` 重新生成 `src/server/worker-configuration.d.ts`。
- 加配置项：在 `src/server/settings.ts` 声明（说明、默认值、`scope`、是否必填、校验），Worker 需要的话在 `src/server/config.ts` 用 `get("KEY")` 读（没声明的读不了），然后 `bun run config example > .env.example`。不要在代码里写死任何公司、域名、人。
- 数据库结构：在 `migrations/` 加新的 `NNNN_xxx.sql`，不要改已有的；`deploy.sh` 会自动应用。D1 只支持 `?1` 这种参数，`src/server/db.ts` 的 `q()` 把代码里的 `$name` 转换过去。
- D1 一次请求最多 1000 条查询（免费版 50）：批量写入用 `json_each` 的集合式语句，不要逐行循环。
