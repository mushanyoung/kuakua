# 测试规则

先读根 `AGENTS.md` 和 `docs/testing.md`。

- unit tests 验证核心规则与边界，集成测试验证真实本地 Workers / D1 / R2，e2e 用真实浏览器操作页面；只替代外部服务与时间等不可控输入。
- 使用独立测试数据库及 R2，测试结束关闭 Miniflare；不要使用开发者 `.wrangler/state` 或生产凭据。
- 失败保留日志与 Playwright trace、截图、视频。修复行为或测试自身的错误，不降低断言，不添加 skip / only，不靠重试隐藏失败。
- 测试代码也纳入 strict 类型检查与 Biome；例外就地说明，并记录在测试策略中。
