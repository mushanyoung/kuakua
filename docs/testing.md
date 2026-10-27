# 测试策略与 CI

先按 `.node-version` / `package.json` 安装 Node.js 26.12.1、pnpm 12.15.0，然后：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium       # Linux 缺系统库时加 --with-deps
pnpm run check
```

`check` 依次执行格式、lint、strict 类型、unit、生产构建、集成测试、CLI 回归和 e2e；任一失败即返回非零。构建先于运行时测试，为真实静态资源提供输入。单独运行集成、CLI 回归或 e2e 前，先执行 `pnpm run build`。部署配置体检 `doctor` 属于部署任务，不要求开发检查拥有线上凭据。

## 分层与覆盖

| 命令                        | 验证范围                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run format:check`     | Biome 格式，警告即失败                                                                                                                                   |
| `pnpm run lint`             | Biome recommended，警告即失败                                                                                                                            |
| `pnpm run typecheck`        | 网页、脚本、cf/Vite 配置、Worker、全部测试与 Playwright 配置，均为 strict                                                                                |
| `pnpm run test:unit`        | 积分按唯一接收人计费、自赠规则、抄送去重、消息与人数边界；时区月界、跨年、夏令时、闰月；名单解析与路径越界、品质标签校验                                 |
| `pnpm run test:integration` | 本地 Workers / D1 / R2：头像权限、并发、数据库失败；Lark 权限、分页、人数上限；积分并发与返还、秘密夸、管理权限、停用用户                                |
| `pnpm run test:cli`         | D1 迁移原子性、cf R2 与开发服务互通；两个 mode 的发布 dry-run；setup 对本地 API fixture 的幂等与 Access 策略保护                                         |
| `pnpm run test:e2e`         | Chromium 桌面和移动视口：键盘选人并发送、详情深链接、表情、评论与删除；Bonus 校验和额度返还；秘密夸与抄送可见性；头像上传恢复及双语偏好；管理员 CSV 导出 |
| `pnpm run build`            | esbuild + Tailwind 网页生产资源，以及 `cf build` 的压缩 Worker 和 Build Output 校验                                                                      |

所有请求通过 Miniflare 的真实 HTTP 地址发送；头像超限流式上传读取完整错误响应，避免取消上传流干扰 D1/R2 RPC 连接。头像布局回归使用生产构建后的真实页面，验证自己和同事的详情页：桌面头像为 132px，移动端为 104px，导航头像保持各自尺寸，积分圆环仍填满 88px 容器。断言图片加载后的实际尺寸，防止共享类名覆盖尺寸后撑开页面。

Cloudflare 配置 unit tests 验证开发身份隔离、生产资源 ID、域名和 Cron、邮件绑定开关、密钥不进入构建变量，以及缺少资源/错误 mode 的失败路径。`pnpm run test:cli` 在临时项目中运行本地迁移和演示数据导入、cf R2 上传与 `cf dev`，用真实 HTTP 确认 D1 和头像数据可见；两个 mode 均执行 `cf build`、`cf deploy --dry-run` 和 `cf deploy --prebuilt --dry-run`，生产使用虚构设置；错误 mode 的预构建发布必须失败。本地迁移额外验证历史幂等性和失败批次的 schema/history 原子回滚，不发布资源。setup 回归运行真实 cf CLI，API 指向本地 HTTP fixture，唯一保留的 curl 查询使用测试替身；验证首次开通、重复执行、外部 Access 策略不改写及邮件开通。日志写入 `test-results/cf-dev.log`。CLI 回归在 Miniflare 集成测试关闭后单独运行，并使用临时开发服务注册目录。

CLI 测试文件串行运行，避免多组 cf/workerd 子进程争抢 CI runner 资源；单项 30 秒超时保持不变。unit 和集成测试仍按 Node 默认并发执行。

类型由 `cf workers types` 生成到 `.cloudflare/types/index.d.ts`，`typecheck` 每次先生成。生成的 Env 类型引用 TypeScript 配置，配置又引用 Node 文件工具，因此 Worker 类型检查同时加载 Node 类型；运行环境仍由 Workers runtime 类型和 `nodejs_compat` 约束。测试直接使用 Miniflare 5/workerd，运行 cf/Vite 已生成的 Worker 代码；从同一 cf 配置取得绑定，测试存储与注册目录隔离。Miniflare beta 的 Fetcher 类型未声明 scheduled 方法，测试先验证其真实存在再调用，不替代业务定时任务。

核心规则无须模拟数据库即可测试；集成与浏览器测试使用真实 Worker 和隔离 D1/R2，只替代 Lark 等外部服务。固定时钟仅在测试运行器加载构建产物时注入，稳定复现同毫秒请求，生产产物不包含它。浏览器测试用本地模拟身份，不验证线上 Access 身份提供方。网络登录和真实通知在部署后按部署指南验收。

每个测试独立清理数据，Miniflare 结束时关闭。e2e 不依赖开发者的 `.wrangler/state`，不启动现有 dev server。失败不得通过 skip、only、放宽断言或增加重试隐藏；修复行为或测试自身的错误。Playwright 开启 `forbidOnly`，`retries: 0`。

## 报告与流水线

`.github/workflows/check.yml` 在所有 push / pull_request 上使用 `ubuntu-24.04`，Node 与 pnpm 精确版本来自仓库，Actions 固定完整 commit SHA，依赖按 `pnpm-lock.yaml` 安装。Playwright 下载由锁定版本指定的 Chromium；CI 运行与本地相同的 `pnpm run check`，不部署，不配置 AI 自动审查。

unit / 集成 / CLI 的 JUnit 分别在 `test-results/unit.xml`、`integration.xml`、`cli.xml`；e2e 的 JUnit 在 `test-results/e2e.xml`，HTML 在 `playwright-report/`。失败保留 trace、截图、视频和 Worker 日志，CI 用 `always()` 上传这些报告及 `test-results/check.log`，保留 14 天。可用 `pnpm exec playwright show-report` 或 `pnpm exec playwright show-trace <trace.zip>` 查看。输出目录不入 git。

本地通过不表示 GitHub Actions 已运行；交付时分别报告实际执行状态，没有运行的明确写“未执行”。

## Biome 例外

`pnpm run format` 格式化，`pnpm run lint:fix` 只应用安全修复。启用 recommended 基线，不关闭规则。`.cloudflare/` 类型和构建产物、`pnpm-lock.yaml` 由工具生成，排除手工格式化；仍检查所引用的类型与锁文件安装一致性。

仅保留就地说明的窄范围例外：`useApi` 的 nonce / 调用方失效键、Feed 的查询切换键、Lark 群选择的重试键是显式 Effect 触发条件；reduced-motion 的四条 `!important` 保证用户偏好覆盖组件及行内动画；无前置依赖的 Playwright fixture 必须用空解构参数，让框架解析依赖。增加例外时在具体位置说明理由，并同步本页。
