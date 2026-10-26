# 测试策略与 CI

先按 `.node-version` / `package.json` 安装 Node.js 26.12.1、pnpm 12.15.0，然后：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium       # Linux 缺系统库时加 --with-deps
pnpm run check
```

`check` 依次执行格式、lint、strict 类型、unit、生产构建、集成测试和 e2e；任一失败即返回非零。构建先于运行时测试，为真实静态资源提供输入。单独运行集成或 e2e 前，先执行 `pnpm run build`。部署配置体检 `doctor` 属于部署任务，不要求开发检查拥有线上凭据。

## 分层与覆盖

| 命令                        | 验证范围                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run format:check`     | Biome 格式，警告即失败                                                                                                                                   |
| `pnpm run lint`             | Biome recommended，警告即失败                                                                                                                            |
| `pnpm run typecheck`        | 网页、脚本、Worker、全部测试与 Playwright 配置，均为 strict                                                                                              |
| `pnpm run test:unit`        | 积分按唯一接收人计费、自赠规则、抄送去重、消息与人数边界；时区月界、跨年、夏令时、闰月；名单解析与路径越界、品质标签校验                                 |
| `pnpm run test:integration` | 本地 Workers / D1 / R2：头像权限、并发、数据库失败；Lark 权限、分页、人数上限；积分并发与返还、秘密夸、管理权限、停用用户                                |
| `pnpm run test:e2e`         | Chromium 桌面和移动视口：键盘选人并发送、详情深链接、表情、评论与删除；Bonus 校验和额度返还；秘密夸与抄送可见性；头像上传恢复及双语偏好；管理员 CSV 导出 |
| `pnpm run build`            | esbuild + Tailwind 网页生产资源，以及 Wrangler `--dry-run --minify` Worker 打包                                                                          |

核心规则无须模拟数据库即可测试；集成与浏览器测试使用真实 Worker 和隔离 D1/R2，只替代 Lark 等外部服务。固定时钟入口仅用于集成测试，稳定复现同毫秒请求，生产入口不包含它。浏览器测试用本地模拟身份，不验证线上 Access 身份提供方。网络登录和真实通知在部署后按部署指南验收。

每个测试独立清理数据，harness 结束时关闭。e2e 不依赖开发者的 `.wrangler/state`，不启动现有 dev server。失败不得通过 skip、only、放宽断言或增加重试隐藏；修复行为或测试自身的错误。Playwright 开启 `forbidOnly`，`retries: 0`。

## 报告与流水线

`.github/workflows/check.yml` 在所有 push / pull_request 上使用 `ubuntu-24.04`，Node 与 pnpm 精确版本来自仓库，Actions 固定完整 commit SHA，依赖按 `pnpm-lock.yaml` 安装。Playwright 下载由锁定版本指定的 Chromium；CI 运行与本地相同的 `pnpm run check`，不部署，不配置 AI 自动审查。

unit / 集成的 JUnit 分别在 `test-results/unit.xml`、`integration.xml`；e2e 的 JUnit 在 `test-results/e2e.xml`，HTML 在 `playwright-report/`。失败保留 trace、截图、视频和 Worker 日志，CI 用 `always()` 上传这些报告及 `test-results/check.log`，保留 14 天。可用 `pnpm exec playwright show-report` 或 `pnpm exec playwright show-trace <trace.zip>` 查看。输出目录不入 git。

本地通过不表示 GitHub Actions 已运行；交付时分别报告实际执行状态，没有运行的明确写“未执行”。

## Biome 例外

`pnpm run format` 格式化，`pnpm run lint:fix` 只应用安全修复。启用 recommended 基线，不关闭规则。`worker-configuration.d.ts` 和 `pnpm-lock.yaml` 由工具生成，排除手工格式化；仍检查所引用的类型与锁文件安装一致性。

仅保留就地说明的窄范围例外：`useApi` 的 nonce / 调用方失效键、Feed 的查询切换键、Lark 群选择的重试键是显式 Effect 触发条件；reduced-motion 的四条 `!important` 保证用户偏好覆盖组件及行内动画；无前置依赖的 Playwright fixture 必须用空解构参数，让框架解析依赖。增加例外时在具体位置说明理由，并同步本页。
