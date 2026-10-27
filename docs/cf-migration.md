# cf CLI 迁移验证

2026-10-26，从 `0ec0bb1` 迁移，分支 `codex/cf-only-migration` 已快进合并并推送到 `main`。使用 Node 26.12.1 / pnpm 12.15.0；cf 固定为 `1.0.0-beta.23`，满足其 Node engines。构建采用官方无 Wrangler 依赖的 Vite 插件 `2.0.0-beta.v.5`，Vite `8.3.5`；Miniflare 固定 `5.20261023.0-beta`。

实现提交 `4d23970`，本地完整质量检查和独立依赖仓库的干净重建均通过。合并后从 `main` 提交 `0ae95a5` 执行完整 `pnpm run deploy`，生产版本为 `7b0cbd22-e15b-4e81-ac13-fc4d3be208fe`，Cloudflare 读回发布来源为 `cf_cli`，该版本承载 100% 流量。

发布前保存 D1 还原点；三份迁移均已应用，本次无待应用迁移、无名单文件变更。发布后远端 Worker 模块与本地生产包逐字节一致，SHA-256 为 `fcb25760f8a2b9259e08b1fdfb3ab5e038327368851430319babba29900a0d1c`。前序用户报告已完成线上验收；本次独立验证范围和剩余限制见下文。

## 迁移矩阵

| 原入口/配置                             | 当前实现                                                                                           | 证据与状态                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `wrangler.config.ts` / Wrangler bundler | `vite.config.ts` + 官方 Vite 2.0 beta，cf 委派 Vite/Rolldown                                       | 两个 mode 构建成功，旧配置删除                                                     |
| dev 前置 Wrangler D1 migrations         | `local-d1.ts` → `cf d1 raw --local`，原路径/ID/历史表                                              | 历史幂等、失败批次回滚、真实 cf dev HTTP 通过                                      |
| 演示数据 Wrangler execute               | cf raw 原子 SQL 批次                                                                               | 24 人/64 帖数据可由 cf dev 读到                                                    |
| Wrangler harness / legacy 配置适配器    | Miniflare 5/workerd + cf 构建产物 + cf 运行配置                                                    | 22 集成、12 浏览器测试通过；定时事件实际执行                                       |
| 类型生成                                | `cf workers types --mode development`                                                              | strict 类型检查通过                                                                |
| 生产构建/发布/CI                        | 网页前置构建 → `cf build --mode production` → `cf deploy --prebuilt --no-provision --secrets-file` | 两种 dry-run 及 main 正式部署通过；远端模块与本地产物完全一致                      |
| D1/R2、Access、Email Sending、DNS 运维  | cf 对应 resource 命令；邮件按发信域名单独定位 zone                                                 | setup fixture 通过；线上存储、Access、域名及 Email Sending 读回通过，发信 DNS 匹配 |
| 代码回滚                                | `cf workers deployments list/create`，明确 version UUID 与百分比                                   | create dry-run 请求核对通过；实际回滚未执行                                        |
| 实时日志                                | Dashboard → 目标 Worker → Logs → Live                                                              | cf 不支持终端流式日志；用户明确批准入口变化                                        |
| Custom Domain 归属查询                  | 保留 setup 原有的一次只读 API GET                                                                  | cf beta.23 命令/schema 无此接口；用户明确批准保留，非 cf 命令                      |

项目的配置转换已在前序提交 `9627476` 完成。本次首先执行 `cf migrate --dry-run --bundler vite`，返回 `No Wrangler config found`：已没有可转换的 JSON/TOML 源配置。因此保留现有 `cloudflare.config.ts`，手工替换构建后端，没有伪造旧配置或覆盖资源声明。没有遗留迁移 TODO/阻断语句；缺资源和未知 mode 的校验继续保留。

## 有效配置与数据

`cloudflare.config.ts`、`scripts/lib/worker-config.ts`、`src/server/settings.ts` 相对迁移基线内容完全不变。配置单元测试和 Build Output 回归覆盖以下映射；本次部署已通过 doctor，并读回实际账户、Worker、D1/R2、域名与 Access 配置。

| 项目           | development                                                  | production                                                                           |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Worker         | `kuakua-dev`                                                 | `WORKER_NAME`                                                                        |
| D1             | 名 `kuakua`，ID `local-dev`                                  | 名 `WORKER_NAME`，ID `D1_DATABASE_ID`，要求已存在                                    |
| R2             | `kuakua-files`                                               | `${WORKER_NAME}-files`                                                               |
| 账户           | 本地模拟，无需账户                                           | 现有凭据环境中的 `CLOUDFLARE_ACCOUNT_ID`                                             |
| HTTP 入口      | 127.0.0.1:4381，模拟身份                                     | `PUBLIC_URL` hostname 的 Custom Domain，禁用 workers.dev / preview URL，不含开发身份 |
| 绑定           | DB、FILES、ASSETS、业务 text、可选 EMAIL                     | 同样绑定规则；非空 secret 只声明 `bindings.secret()`，值不进入构建产物               |
| 资源路由       | SPA fallback，`/api/*`、`/avatars/*` Worker first            | 相同                                                                                 |
| runtime / cron | `2026-10-01`、`nodejs_compat`；`SYNC_CRON` 默认 `0 19 * * *` | 相同                                                                                 |
| 日志与生命周期 | 保留 `observability.enabled=true`                            | 不新增日志、traces 或 source map 上传；无 DO / Workflows / Containers                |

行为差异：Vite 的 build 默认 mode 是 production，项目 `build`/`dev`/`types` 均显式使用 development；发布显式使用 production。prebuilt 的 mode 不匹配会失败。前端仍由原 esbuild/PostCSS 构建，Vite 复制其产物；Worker 压缩器改为 Rolldown。Vite 禁用自动 dotenv 加载及远端 bindings，部署配置仍由项目唯一设置源处理。

本地保留 `.wrangler/state` 路径及原资源身份；目录名不代表 Wrangler 依赖。曾用迁移前 Wrangler 4.148.0 在临时目录写入 D1 标记及 R2 对象，随后 cf 成功读取相同值；没有访问开发者实际数据。cf migrations 子命令仍拒绝 `local-dev`，cf raw 已验证支持，因此本地迁移按既有 `d1_migrations` 表记录执行。schema 与 history 同批次提交，失败无部分写入。生产迁移文件保持原样，部署的 migrations apply 返回空数组，没有数据迁移或生命周期变更。

## 验证记录

- `pnpm install --frozen-lockfile`：通过。
- `pnpm run check`：格式、lint（零告警）、strict 类型、20 unit、22 integration、4 CLI、12 e2e、生产网页与 Worker 构建全部通过。原有断言保留，未加 skip/retry。
- CLI 回归在临时项目对 development / production 分别执行 `cf build`、`cf deploy --dry-run --no-provision`、`cf deploy --prebuilt --dry-run --no-provision`。production 使用虚构设置和测试 secret；产物不含 secret 值或开发身份。
- `cf dev --mode development` 实际启动，请求 `/api/me`、R2 头像和 SPA 深链接，验证 D1/R2 互通；退出后关闭进程、删除临时存储。
- setup 使用真实 cf CLI、仅指向本地 HTTP fixture，验证 API 请求和响应处理；保留的 curl 只读检查使用明确的测试替身。
- `cf workers deployments create ... --dry-run`：核对了 Worker 名、version UUID、百分比及 API 请求。`cf d1 migrations apply <测试 UUID> --dir migrations --dry-run` 仅验证参数，未声称它验证了远端数据库。
- `bash -n scripts/cloudflare-setup.sh scripts/deploy.sh`：通过。
- `pnpm list --depth Infinity --json` 与完整 `pnpm-lock.yaml`：均无 Wrangler 包。可执行脚本、CI、测试和程序化 import 无 Wrangler 调用；实际构建输出明确显示 `Delegating to pnpm vite build`，无 `wrangler.config.ts`。
- 从提交 `4d23970` 建立临时 detached worktree，使用空的独立 pnpm store 和 cache；PATH 仅含固定 node/pnpm/jq 与系统工具，`command -v wrangler` 失败。重新 frozen install、执行完整 `pnpm run check`（58 个测试）及依赖树扫描全部通过；确认没有 Wrangler binary/package/config。临时 worktree/store 已删除，证据为 `test-results/clean-check.log`。

本地证据在 `test-results/check.log`、`unit.xml`、`integration.xml`、`cli.xml`、`e2e.xml`、`cf-dev.log`、`rollback-dry-run.json` 和 `d1-dry-run.json`。这些是实际运行产物，不入 git；长期证据是本页和可重跑的测试。

GitHub Actions 已实际执行：[首次 main 检查](https://github.com/mushanyoung/kuakua/actions/runs/40441586474) 的格式、lint、类型、unit、build、integration 通过，CLI 开发流程超时。[串行复跑](https://github.com/mushanyoung/kuakua/actions/runs/40442556246) 定位到 Vite 在主机与端口之间输出 ANSI 控制码，导致测试未识别已启动的服务。地址解析现先去掉控制码，并强制彩色输出覆盖此回归；保留串行执行、原超时、全部断言和零重试。后续实际结果见 [main 检查记录](https://github.com/mushanyoung/kuakua/actions/workflows/check.yml?query=branch%3Amain)。本地通过不代替 CI 通过。

## 发布后核验

- D1 的 `0001_initial.sql`、`0002_email_notify.sql`、`0003_custom_avatars.sql` 均已应用；`migrations list` 为空，`PRAGMA quick_check` 为 `ok`。部署前后用户、帖子、评论和表情数量一致。
- R2 名单内容与部署前及本地文件一致；最近一次目录同步记录成功。没有主动触发新的线上同步。
- 全部 Worker bindings、compatibility date/flags、observability 与部署前一致；D1、R2、ASSETS 和 EMAIL 绑定均保留，无开发身份。
- Custom Domain 与配置一致，workers.dev 和预览 URL 关闭；Access 应用、audience 和策略未变。首页及 API 的匿名请求、伪造开发身份和无效 JWT 请求均被重定向到预期 Access 登录域名。
- Cron 与 `SYNC_CRON` 一致；cf 当前未暴露 schedules 读取命令，本次以临时只读 API GET 核验，没有新增运维入口。
- Email Sending 已通过用户 cf CLI 的 OAuth 身份核验：具备 `email-sending.read`，发信域名已启用，公开 MX/SPF/DKIM/DMARC 与 cf 返回的记录一致。项目 `.env.cloudflare` 的 API Token 查询此接口返回 403；这与 CLI 登录身份的权限不同，核验时仅在子进程移除 Token 环境变量，未修改部署凭据。真实登录后的交互和实际邮件收发本次未执行，不能用前序用户验收替代本次自动化结果。

部署日志和读回证据存于不入 git 的 `local/cf-validation/`；D1 还原点与发布提交记于 `local/last-deploy`。

## 常用命令与发布边界

```sh
export DO_NOT_TRACK=1 CF_SEND_TELEMETRY=false WRANGLER_SEND_METRICS=false
pnpm run dev
pnpm run demo:seed                       # 替换本地演示数据
pnpm run check
pnpm run build                          # development；含网页前置构建
pnpm run build:web
pnpm exec cf build --mode production
pnpm exec cf deploy --mode production --prebuilt --dry-run --no-provision
pnpm run doctor                         # 只读部署体检
```

`pnpm run deploy`、`scripts/cloudflare-setup.sh`、`pnpm run roster:push` 和回滚命令会写远端资源/配置/数据，应在目标环境授权范围内执行。本次用户明确授权合并和部署，已完成正式发布；未重新开通资源或执行实际回滚。

代码 Git revert 不回滚 D1/R2/Access/DNS，旧版本须兼容现存 schema、bindings 和 secrets；数据库回退按部署前还原点另行操作。入口层、构建层、依赖层均已清除 Wrangler，并通过干净重建和正式部署。实时日志使用 Dashboard、setup 保留既有 Custom Domain 只读 API 查询，均是用户已接受的 cf 能力边界。现存 `.wrangler/state` 名称、关闭 metrics 的环境变量，以及不可修改的历史 SQL 注释不是 Wrangler 调用。
