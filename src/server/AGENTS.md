# Worker 规则

先读根 `AGENTS.md`；涉及边界看 `docs/architecture.md`，新增配置或部署操作看 `docs/deployment.md`，测试看 `docs/testing.md`。

- 权限、秘密夸可见性、Peer Bonus 额度在服务端校验；D1 批次须保持原子性。
- 所有配置在 `settings.ts` 声明，`config.ts` 读取；执行 `pnpm --silent run config example > .env.example` 同步示例。
- D1 批量写入使用 `json_each` 集合式语句，避免逐行查询；SQL 参数通过 `db.ts` 的 `q()` 转换。
- 结构变更追加迁移，不改旧迁移。绑定变化运行 `pnpm run types`，不要手写生成的 Worker 类型。
