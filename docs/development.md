# 开发与提交

先读根目录 `AGENTS.md`；修改具体模块时再读目标路径上的规则。现有产品已可运行，新工作以小步完成和实际提交为单位，不重建应用骨架。

## 环境

安装 `.node-version` 中的 Node.js 26.12.1，然后 `npm install --global pnpm@12.15.0`。`packageManager` 与 `engines` 固定版本，`pnpm-workspace.yaml` 拒绝不匹配的环境。只用 `pnpm install --frozen-lockfile` 安装已有依赖；主动升级时更新锁文件与版本说明。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run check
pnpm run demo:seed
pnpm run dev
```

本地地址 `http://127.0.0.1:4381`，使用 `wrangler.jsonc` 中的模拟身份和本地 D1/R2。`X-Dev-Email` 可切换身份；`demo:seed` 会替换本地数据，不接触部署数据。网页文件变化自动重新构建，浏览器刷新查看。生产运行在 Workers；Node.js 用于工具链与测试。

前端由 esbuild 打包，PostCSS 编译 Tailwind，输出 `dist/`；`pnpm run build` 另将 Worker 打包至 `.wrangler/build/`，不上传。静态资源使用绝对 URL，保证 `/u/:id`、`/k/:id` 等深链接正常加载。

## 迭代

1. 确定可独立验证和回退的小单元，先准备可运行路径及适用检查。
2. 实现与正常调试；业务行为变更包含相应测试，命令、架构、操作变化同步文档。
3. 执行适用检查，通过即实际提交。提交说明目的，不混入无关变更或部署文件。
4. 交付前执行 `pnpm run check` 完整质量门槛，分别报告本地结果和 GitHub Actions 实际状态。没有运行的写“未执行”。

不安排独立 code review 或 reviewer agent，不配置 AI 自动审查。此约束不影响正常调试、测试和问题修复。

## 文档维护

`docs/` 只放现行的项目约束、决策理由与操作方法；过时操作直接删除，需要追溯的旧方案才移到 `docs/archive/`。模块特有约束在该目录的 `AGENTS.md`，根入口通过导航说明何时读取。`CLAUDE.md` 只引用根入口，避免多份规范漂移。

## 格式与样式

`pnpm run format:check`、`pnpm run lint` 不得有警告或错误，使用 `pnpm run format` / `pnpm run lint:fix` 修复。主题分布在 `src/web/styles/`，由入口 CSS 按原有顺序导入；通用布局使用 Tailwind。头像的行内大小通过 CSS 变量提供，响应式样式可正常覆盖。原生 dialog 提供焦点约束和 Escape 关闭，人员选择器支持键盘选择。
