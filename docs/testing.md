# 测试策略

质量目标是验证实际业务行为。规则、重要边界和异常路径用 unit tests；权限、存储和外部服务适配用真实本地 Workers / D1 / R2 集成测试；主要用户流程通过浏览器 e2e 验证。

目前 `pnpm run test:integration` 运行 `tests/*.test.ts`：头像上传、恢复、权限、无效输入、并发与数据库失败；Lark 群权限、分页、去重、未同步成员与人数上限。Wrangler 测试 harness 使用隔离本地资源，Lark 使用本地 HTTP stub，不需要 Cloudflare 凭据。

执行 `pnpm run typecheck` 检查 strict 类型，`pnpm run build` 验证生产网页与 Worker 打包。部署配置体检 `pnpm run doctor` 属于部署任务，不要求开发者拥有线上配置。

不得用关规则、skip、宽松断言或 mock 掉被验证行为来通过检查。必须修复真实问题；必要例外限定至具体文件或行，说明原因并在本页记录。自动生成的 Worker 类型由 `pnpm run types` 更新，不手工格式化。

## Biome 门槛与例外

`pnpm run format:check` 与 `pnpm run lint` 均将警告视为失败；`pnpm run format` 格式化，`pnpm run lint:fix` 只应用安全修复。启用全部 recommended 基线，不关闭规则。生成的 `src/server/worker-configuration.d.ts` 和 `pnpm-lock.yaml` 排除手工格式化，由各自工具生成。

仅保留以下就地说明的例外：`useApi` 的 nonce / 调用方失效键、Feed 的查询切换键、Lark 群选择的重试键是显式 Effect 触发条件，不能按未使用依赖删除；reduced-motion 中的四条 `!important` 保证用户减少动态效果的偏好覆盖组件及行内动画。所有例外以具体 Effect 或 CSS 声明为范围。
