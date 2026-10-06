# AGENTS.md — 部署与维护指南

给负责部署、升级、改配置的 agent 看的。和人沟通用对方的语言；命令、配置项名保持原样。

## 先记住这几条

- **部署相关的一切都在 git 之外**，`git pull` 不会碰它们：
  - `.env.production` 应用配置（含密钥，权限 600）
  - `.env.cloudflare` Cloudflare API 凭据（只给 `scripts/cloudflare-setup.sh` 用；也可以用 `CLOUDFLARE_ENV_FILE` 指向别处）
  - `local/` 名单 `roster.csv`、头像、`values.json`、上次部署记录、tunnel token
  - `DATA_DIR`（默认 `./data`）数据库、头像缓存、备份
- **不要为了某个部署改代码或提交上面这些文件。** 需要新的可配置项时，在 `src/server/settings.ts` 里声明（见文末"改代码"）。
- 所有配置项的唯一来源是 `src/server/settings.ts`；`.env.example` 是从它生成的。
- 三个工具：
  - `bun run doctor` 体检配置，告诉你缺什么、错什么、有哪些新配置项还没确认过（只读，随时可跑）
  - `bun run config set KEY VALUE` 写配置（`list` / `get KEY` 查看，密钥会打码）
  - `./scripts/deploy.sh` 部署或重新部署（幂等，跑多少次都行）

## 任务 A：首次部署（新机器 / 新 Cloudflare 账号）

### 0. 机器准备

需要 Linux + systemd、sudo、git、curl、jq、[bun](https://bun.sh)（≥ 1.4）、[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。缺的先装好（`bun run doctor` 会检查）。

```bash
git clone <repo> kuakua && cd kuakua
bun install
```

### 1. 和运维人员逐项确认配置

先跑 `bun run doctor`，它会列出每一项。下面这些需要问人，问清楚后用 `bun run config set KEY VALUE` 写进去：

| 要问的 | 写到 | 说明 |
|---|---|---|
| 网站地址 | `PUBLIC_URL` | `https://<hostname>`，hostname 所在的域名必须在他们的 Cloudflare 账号里 |
| 管理员邮箱 | `ADMIN_EMAILS` | 逗号分隔；管理员能同步通讯录、导出 Peer Bonus 报表、看光荣榜、删任何帖子 |
| 人员名单来源 | `DIRECTORY_SOURCE` | `roster`（一份名单文件）或 `lark`（Lark/飞书通讯录自动同步，需要 `LARK_*`） |
| 名单文件 | `ROSTER_FILE` | 默认 `./local/roster.csv`。格式见下文；向对方要名单和头像 |
| 额外允许登录的邮箱域名 | `ALLOWED_EMAIL_DOMAINS` | 可空。空 = 只有名单里的人和管理员能登录 |
| 时区 | `APP_TIMEZONE` | 每月 1 日零点重置 Peer Bonus 额度 |
| 品质标签 | `VALUES_FILE` | 可空（用内置 8 个）；要自定义就照 `deploy/values.example.json` 写到 `local/values.json` |
| Peer Bonus 额度 | `BONUS_MONTHLY_ALLOWANCE`、`BONUS_POINTS` | 每人每月可送出的积分、每份给每人的积分 |
| 同机多实例？ | `SERVICE_NAME`、`PORT` | 一台机器跑多个部署时，每个用不同的服务名和端口 |

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
| `avatar` | 头像：相对名单文件的路径（如 `avatars/alice.jpg`），或 https 链接。JPEG/PNG/WebP/GIF，建议 ≤ 640px 方图；没有就用渐变色首字头像 |

`#` 开头的行会被忽略。名单文件改动后，运行中的服务一分钟内自动重新同步：新人出现、改名生效、从名单里删掉的人被停用（历史感谢保留）。名单有任何错误时整份不生效，错误显示在管理页和日志里。

### 2. Cloudflare（新账号也行）

请运维人员准备：

1. 在 Cloudflare 账号里打开一次 **Zero Trust**，起一个 team 名，并在 Settings → Authentication 加一个登录方式（One-time PIN 最简单，Google 等也可以）。
2. 创建一个 API Token，权限：Account › Cloudflare Tunnel: Edit；Account › Access: Apps and Policies: Edit；Account › Access: Organizations, Identity Providers, and Groups: Read；Zone › DNS: Edit（网站域名所在的 zone）。
3. 把它写进 `.env.cloudflare`（`chmod 600`）：
   ```
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   ```

然后：

```bash
./scripts/cloudflare-setup.sh
```

它会建/复用 tunnel、DNS、tunnel 路由、Access 策略和应用，并把 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` 写进 `.env.production`。如果它说 tunnel 没有在运行的 connector，就按提示执行 `sudo cloudflared service install "$(cat local/cloudflared-token)"`。

### 3. 部署

```bash
bun run doctor        # 必须没有 ✗
./scripts/deploy.sh
```

最后确认：`https://<hostname>/healthz` 返回 `ok`；让管理员打开网站登录，管理页的"名单同步 / Lark 通讯录同步"显示成功，人数对得上。

## 任务 B：升级（拉了新代码之后）

```bash
git pull --ff-only
bun run doctor
```

- 有 ✗：通常是新版本加了必填项，按提示问人、`config set`。
- "Not in the config file yet" 里有新出现的项：这是新版本加的可选配置。向运维人员说明它是什么、默认值是什么，按他们的选择 `config set`（保留默认也写一次）。
- 如果改了 `ADMIN_EMAILS`、`ALLOWED_EMAIL_DOMAINS`、名单里的邮箱、`PUBLIC_URL` 或 `PORT`：重跑 `./scripts/cloudflare-setup.sh`。

然后 `./scripts/deploy.sh`。它会先列出自上次部署以来的提交（读一下，告诉运维人员这次更新了什么），再装依赖、体检、备份数据库、刷新 systemd 单元、重启并等健康检查通过。数据库结构变更在启动时自动迁移。

## 任务 C：日常改配置

| 想做的事 | 怎么做 |
|---|---|
| 加人 / 删人 / 改名 / 换上级 | 改名单文件；一分钟内自动生效。加删了邮箱的话再跑一次 `./scripts/cloudflare-setup.sh` 更新登录名单 |
| 换头像（同一个文件名） | 管理页点"立即同步"，或 `bun run sync` |
| 改 `.env.production` 里任何一项 | `bun run config set KEY VALUE`，然后 `./scripts/deploy.sh` |
| 改品质标签 | 改 `VALUES_FILE` 指向的文件，然后 `./scripts/deploy.sh`。已用过的标签 id 不要删改，否则旧帖子上的标签不再显示 |
| 换域名 | `config set PUBLIC_URL ...` → `./scripts/cloudflare-setup.sh` → `./scripts/deploy.sh` |

## 回滚与排障

- 日志：`sudo journalctl -u <SERVICE_NAME> -f`（启动时打印当前 commit 和通讯录来源）。
- 每次部署前的数据库备份：`<DATA_DIR>/backups/pre-deploy-<commit>-<时间>.db`（保留最近 10 个）；另有每日备份 `kuakua-YYYY-MM-DD.db`（保留 14 天）。
- 回滚代码：`git checkout <上一个 commit>` → `./scripts/deploy.sh`。如果跨过了数据库结构变更，还要恢复对应的部署前备份：停服务 → 把备份复制成 `<DATA_DIR>/kuakua.db` 并删掉 `kuakua.db-wal`、`kuakua.db-shm` → `./scripts/deploy.sh`。
- 有人登录后看到 `email_domain_not_allowed`：他的邮箱不在名单 / Lark 通讯录、`ALLOWED_EMAIL_DOMAINS`、`ADMIN_EMAILS` 里。
- 进不了 Cloudflare 登录页或被 Access 拒绝：重跑 `./scripts/cloudflare-setup.sh`，检查 Zero Trust 里的登录方式。

## 改代码时

- 本地开发：`bun run demo:seed`（生成 `./data-demo`），`bun run dev`（http://127.0.0.1:4381，以 `mushan@example.com` 管理员身份登录），`bun run typecheck`。
- 加配置项：在 `src/server/settings.ts` 声明（说明、默认值、是否必填、校验），在 `src/server/config.ts` 用 `get("KEY")` 读取（没声明的读不了），然后 `bun run config example > .env.example`。不要在代码里写死任何公司、域名、人。
- 数据库结构：在 `src/server/db.ts` 的 `migrations` 末尾追加，不要改已有的。
