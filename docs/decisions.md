# 现行技术决策

- **2026-10-26：固定 Node.js 26.12.1 + pnpm 12.15.0。** 开发、构建、测试、部署脚本使用同一工具链；Node 原生 TypeScript 执行与 `node:sqlite` 支撑脚本，不再依赖 Bun。线上保留 Cloudflare Workers、D1、R2 和 Access，以免工具链迁移改变部署模型。
- **保留 React + esbuild。** 现有路由和 API 足够简单，独立 `tsc --noEmit` 覆盖类型检查；不引入额外应用框架。网页资源 URL 绝对化，字体继续自托管。
- **Tailwind 参与真实构建。** PostCSS 编译 theme/utilities，通用布局优先用工具类；现有主题 CSS 继续维护。暂不引入 Preflight，因为现有全局 reset 已定义页面外观，避免本次迁移改变所有控件样式。依据：[Tailwind 的分开导入方式](https://tailwindcss.com/docs/preflight)。
- **部署与质量检查分离。** `build` 包含 Worker dry-run；它验证打包，不证明线上资源与登录可用。只有明确部署任务才操作 Cloudflare，质量检查无需生产凭据。依据：[Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/general/)。
