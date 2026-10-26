# 工具与部署脚本

先读根 `AGENTS.md`；工具链看 `docs/development.md`，实际部署或配置变更先读 `docs/deployment.md`。

- 脚本由固定 Node.js 执行；使用 Node API，运行期相对 TypeScript import 带 `.ts`。
- cf 只通过本地 pnpm 依赖执行；现有依赖用 `pnpm install --frozen-lockfile` 安装。
- cf 运行配置来自根 `cloudflare.config.ts` / `lib/worker-config.ts`，业务配置仍由 `settings.ts` 声明；只有生产 mode 读取部署设置。Vite 2.0 beta 是构建后端；本地 D1 通过 `lib/local-d1.ts` 调用 cf raw，保留历史 ID 和迁移表，不维护第二份运行配置。
- 本地测试使用隔离存储；修改演示数据工具时用 `--persist-to=<临时目录>` 验证，避免替换开发者现有数据。
- `.env.production`、Cloudflare 凭据、`local/` 留在 git 之外，输出不得泄露密钥。开发检查不部署线上资源。
