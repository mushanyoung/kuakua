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

本地地址 `http://127.0.0.1:4381`，使用 `cloudflare.config.ts` 开发模式的模拟身份和本地 D1/R2。`X-Dev-Email` 可切换身份；`demo:seed` 会替换本地数据，不接触部署数据。网页文件变化自动重新构建，浏览器刷新查看。生产运行在 Workers；Node.js 用于工具链与测试。

前端由 esbuild 打包，PostCSS 编译 Tailwind，输出 `dist/`；`pnpm run build` 通过 `cf build` 将 Worker 和静态资源打包至 `.cloudflare/output/v0/`，不上传。静态资源使用绝对 URL，保证 `/u/:id`、`/k/:id` 等深链接正常加载。

## Cloudflare 工具链

固定使用 `cf` 1.0.0-beta.23、`@cloudflare/vite-plugin` 2.0.0-beta.v.5、Vite 8.3.5、Miniflare 5.20261023.0-beta 和 `@cloudflare/config` 0.28.1。cf 的 Node engines 为 `^22.23.0 || ^24.22.0 || ^26.12.0`，项目固定的 Node 26.12.1 满足要求。稳定版 Vite 插件 1.x 仍依赖 Wrangler，不能替换这里的 2.0 beta。项目直接依赖和锁文件都不再包含 Wrangler。

`cloudflare.config.ts` / `scripts/lib/worker-config.ts` 声明运行配置，`vite.config.ts` 声明本地端口、存储和构建。cf 实际调用 Vite/Rolldown；esbuild + PostCSS 仍负责网页资源，Vite 将 `dist/` 复制进 Build Output。构建不增加 Worker source map 或远端日志、traces 上传。Vite 禁用自动 dotenv 加载和远端 bindings，部署设置仍只由项目配置读取。

`pnpm run build` 和 `pnpm run dev` 显式传 `--mode development`，无需部署文件。生产使用 `--mode production`，读取 `.env.production`（可用 `ENV_FILE` 指定）；未知 mode 报错。注意直接运行 `cf build` 时，Vite 默认 mode 是 production；请使用项目脚本或明确传 mode。`--prebuilt` 必须与产物记录的 mode 一致。

```sh
export DO_NOT_TRACK=1 CF_SEND_TELEMETRY=false WRANGLER_SEND_METRICS=false
pnpm run build                         # 网页前置步骤 + development Worker
pnpm run build:web
pnpm exec cf build --mode production   # 仅构建，需部署设置，不需认证
pnpm exec cf deploy --mode production --prebuilt --dry-run --no-provision
```

项目脚本与 CI 均设置以上隐私变量。直接执行 cf 前也应设置它们。`pnpm run types` 生成 `.cloudflare/types/index.d.ts`，`typecheck` 会自动先生成。cf 不执行 package.json 的前置网页构建，因此使用 `pnpm run build` / `pnpm run deploy`。

本地存储路径继续为 `.wrangler/state`，这是保留数据的路径名，不是运行依赖；D1 ID 为 `local-dev`，R2 为 `kuakua-files`。cf 的 migrations 子命令只接受 UUID，但 `cf d1 raw --local` 实测接受此历史 ID。`scripts/lib/local-d1.ts` 通过该命令执行 SQL，并沿用 `d1_migrations` 的已应用历史；每份迁移及其历史记录作为原子批次执行，失败回滚。生产仍用 `cf d1 migrations apply <D1_DATABASE_ID> --dir migrations`。R2 本地操作显式传 `--persist-to .wrangler/state`。不要删除、重命名或迁移开发者现有存储目录。

2026-10-26 的 pnpm 发布等待期例外仅覆盖 `pnpm-workspace.yaml` 列出的六个精确版本；完整依赖按锁文件安装。依据：[官方构建后端和 mode](https://developers.cloudflare.com/cf/projects/)、[cf beta.23 发布记录](https://github.com/cloudflare/cf/releases/tag/cf%401.0.0-beta.23)。迁移证据和限制见 [迁移记录](cf-migration.md)。

## 迭代

1. 确定可独立验证和回退的小单元，先准备可运行路径及适用检查。
2. 实现与正常调试；业务行为变更包含相应测试，命令、架构、操作变化同步文档。
3. 执行适用检查，通过即实际提交。提交说明目的，不混入无关变更或部署文件。
4. 交付前执行 `pnpm run check` 完整质量门槛，分别报告本地结果和 GitHub Actions 实际状态。没有运行的写“未执行”。

不安排独立 code review 或 reviewer agent，不配置 AI 自动审查。此约束不影响正常调试、测试和问题修复。

## 文档维护

`docs/` 只放现行的项目约束、决策理由与操作方法；过时操作直接删除，需要追溯的旧方案才移到 `docs/archive/`。模块特有约束在该目录的 `AGENTS.md`，根入口通过导航说明何时读取。`CLAUDE.md` 只引用根入口，避免多份规范漂移。

## 格式与样式

`pnpm run format:check`、`pnpm run lint` 不得有警告或错误，使用 `pnpm run format` / `pnpm run lint:fix` 修复。主题分布在 `src/web/styles/`，由入口 CSS 按原有顺序导入；通用布局使用 Tailwind。头像的行内大小通过 CSS 变量提供，响应式样式可正常覆盖。组件样式使用明确前缀：头像描边为 `avatar-ring`，积分圆环为 `allowance-ring`；两者曾共用 `.ring`，导致圆环的百分比尺寸覆盖头像尺寸，也与 Tailwind 的同名工具类冲突。原生 dialog 提供焦点约束和 Escape 关闭，人员选择器支持键盘选择。
