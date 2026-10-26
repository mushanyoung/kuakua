# cf CLI 迁移验证

2026-10-26，从 `0ec0bb1` 迁移，分支 `codex/cf-only-migration`。使用 Node 26.12.1 / pnpm 12.15.0；cf 固定为当日 registry latest `1.0.0-beta.23`，满足其 Node engines。构建采用官方无 Wrangler 依赖的 Vite 插件 `2.0.0-beta.v.5`，Vite `8.3.5`；Miniflare 固定 `5.20261023.0-beta`。

完整本地质量检查已通过；独立依赖仓库的干净重建待执行。线上验收尚未完成，没有远端写入。

## 迁移矩阵

| 原入口/配置                             | 当前实现                                                                                           | 证据与状态                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `wrangler.config.ts` / Wrangler bundler | `vite.config.ts` + 官方 Vite 2.0 beta，cf 委派 Vite/Rolldown                                       | 两个 mode 构建成功，旧配置删除                                                       |
| dev 前置 Wrangler D1 migrations         | `local-d1.ts` → `cf d1 raw --local`，原路径/ID/历史表                                              | 历史幂等、失败批次回滚、真实 cf dev HTTP 通过                                        |
| 演示数据 Wrangler execute               | cf raw 原子 SQL 批次                                                                               | 24 人/64 帖数据可由 cf dev 读到                                                      |
| Wrangler harness / legacy 配置适配器    | Miniflare 5/workerd + cf 构建产物 + cf 运行配置                                                    | 22 集成、12 浏览器测试通过；定时事件实际执行                                         |
| 类型生成                                | `cf workers types --mode development`                                                              | strict 类型检查通过                                                                  |
| 生产构建/发布/CI                        | 网页前置构建 → `cf build --mode production` → `cf deploy --prebuilt --no-provision --secrets-file` | 虚构配置的普通及 prebuilt dry-run 通过；远端发布未执行                               |
| D1/R2、Access、Email Sending、DNS 运维  | cf 对应 resource 命令；邮件按发信域名单独定位 zone                                                 | 真实 CLI 对本地 API fixture 验证首次开通、重复执行、外部 Access 策略保护；线上未执行 |
| 代码回滚                                | `cf workers deployments list/create`，明确 version UUID 与百分比                                   | create dry-run 请求核对通过；实际回滚未执行                                          |
| 实时日志                                | Dashboard → 目标 Worker → Logs → Live                                                              | cf 不支持终端流式日志；用户明确批准入口变化                                          |
| Custom Domain 归属查询                  | 保留 setup 原有的一次只读 API GET                                                                  | cf beta.23 命令/schema 无此接口；用户明确批准保留，非 cf 命令                        |

项目的配置转换已在前序提交 `9627476` 完成。本次首先执行 `cf migrate --dry-run --bundler vite`，返回 `No Wrangler config found`：已没有可转换的 JSON/TOML 源配置。因此保留现有 `cloudflare.config.ts`，手工替换构建后端，没有伪造旧配置或覆盖资源声明。没有遗留迁移 TODO/阻断语句；缺资源和未知 mode 的校验继续保留。

## 有效配置与数据

`cloudflare.config.ts`、`scripts/lib/worker-config.ts`、`src/server/settings.ts` 相对迁移基线内容完全不变。配置单元测试和 Build Output 回归覆盖以下映射；真实部署文件与账户资源本次未读取/核验。

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

本地保留 `.wrangler/state` 路径及原资源身份；目录名不代表 Wrangler 依赖。曾用迁移前 Wrangler 4.148.0 在临时目录写入 D1 标记及 R2 对象，随后 cf 成功读取相同值；没有访问开发者实际数据。cf migrations 子命令仍拒绝 `local-dev`，cf raw 已验证支持，因此本地迁移按既有 `d1_migrations` 表记录执行。schema 与 history 同批次提交，失败无部分写入。生产迁移文件保持原样，不执行数据迁移或生命周期变更。

## 验证记录

- `pnpm install --frozen-lockfile`：通过。
- `pnpm run check`：格式、lint（零告警）、strict 类型、20 unit、22 integration、4 CLI、12 e2e、生产网页与 Worker 构建全部通过。原有断言保留，未加 skip/retry。
- CLI 回归在临时项目对 development / production 分别执行 `cf build`、`cf deploy --dry-run --no-provision`、`cf deploy --prebuilt --dry-run --no-provision`。production 使用虚构设置和测试 secret；产物不含 secret 值或开发身份。
- `cf dev --mode development` 实际启动，请求 `/api/me`、R2 头像和 SPA 深链接，验证 D1/R2 互通；退出后关闭进程、删除临时存储。
- setup 使用真实 cf CLI、仅指向本地 HTTP fixture，验证 API 请求和响应处理；保留的 curl 只读检查使用明确的测试替身。
- `cf workers deployments create ... --dry-run`：核对了 Worker 名、version UUID、百分比及 API 请求。`cf d1 migrations apply <测试 UUID> --dir migrations --dry-run` 仅验证参数，未声称它验证了远端数据库。
- `bash -n scripts/cloudflare-setup.sh scripts/deploy.sh`：通过。
- `pnpm list --depth Infinity --json` 与完整 `pnpm-lock.yaml`：均无 Wrangler 包。可执行脚本、CI、测试和程序化 import 无 Wrangler 调用；实际构建输出明确显示 `Delegating to pnpm vite build`，无 `wrangler.config.ts`。
- 独立 store、无旧 node_modules/构建缓存、限制 PATH 的重建：待执行。

本地证据在 `test-results/check.log`、`unit.xml`、`integration.xml`、`cli.xml`、`e2e.xml`、`cf-dev.log`、`rollback-dry-run.json` 和 `d1-dry-run.json`。这些是本次实际运行产物，不入 git；长期证据是本页和可重跑的测试。GitHub Actions：未执行，不等同于本地检查通过。

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

需要目标环境授权后才执行 `pnpm run deploy`、`scripts/cloudflare-setup.sh`、`pnpm run roster:push` 或回滚命令；它们会写远端资源/配置/数据。先读回账户、Worker、D1/R2、域名与版本，再执行 Access 登录、通知、目录同步和安全测试对象的持久性 smoke tests。本次均未执行。

线上验收和真实资源关联仍未验证。代码 Git revert 不回滚 D1/R2/Access/DNS，旧版本须兼容现存 schema、bindings 和 secrets；数据库回退按部署前还原点另行操作。除用户批准的日志入口与一个既有只读 API 例外外，没有降低功能或验证标准。三层 Wrangler 清理已落实；干净重建后再确认完整的本地迁移状态。
