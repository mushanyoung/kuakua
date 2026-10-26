# 现行技术决策

- **2026-10-26：固定 Node.js 26.12.1 + pnpm 12.15.0。** 开发、构建、测试、部署脚本使用同一工具链；Node 原生 TypeScript 执行与 `node:sqlite` 支撑脚本，不再依赖 Bun。线上保留 Cloudflare Workers、D1、R2 和 Access，以免工具链迁移改变部署模型。
- **保留 React + esbuild。** 现有路由和 API 足够简单，独立 `tsc --noEmit` 覆盖类型检查；不引入额外应用框架。网页资源 URL 绝对化，字体继续自托管。
- **Tailwind 参与真实构建。** PostCSS 编译 theme/utilities，通用布局优先用工具类；现有主题 CSS 继续维护。暂不引入 Preflight，因为现有全局 reset 已定义页面外观，避免本次迁移改变所有控件样式。依据：[Tailwind 的分开导入方式](https://tailwindcss.com/docs/preflight)。
- **部署与质量检查分离。** `build` 包含 Worker dry-run；它验证打包，不证明线上资源与登录可用。只有明确部署任务才操作 Cloudflare，质量检查无需生产凭据。依据：[Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/general/)。

- **质量门槛使用 Node test runner + Playwright。** 纯业务规则直接在 Node 执行；Workers 集成测试用项目锁定的 Wrangler harness，浏览器测试覆盖桌面和移动视口。所有 D1/R2 都隔离，不用真实 Access 凭据或通知渠道。测试代码也做 strict 检查；Playwright 禁止 only、禁用重试，不隐藏偶发失败。依据：[Playwright fixtures](https://playwright.dev/docs/test-fixtures)。
- **同毫秒请求的积分原子性。** 集成测试曾稳定复现余额不足时错误关联旧帖的收件人，引发约束冲突。保留单一 D1 原子批次，使用前序插入的 `changes()` 守卫子表；不放宽唯一约束，也不以忽略冲突替代错误处理。
