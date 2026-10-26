# 夸夸：Agent 入口

每次任务先读取本文件，再仅按目标路径和当前任务需要读取沿途目录的 `AGENTS.md` 与下列资料；不要预先遍历所有文档。

## 项目与职责

团队内部 Kudos / Peer Bonus 应用：React 网页 + Cloudflare Worker API、D1、R2、Access。`src/server/` 负责权限与业务规则，`src/web/` 负责交互，`src/shared/` 放共享约定，`scripts/` 负责本地开发与部署。运维提供部署配置与凭据，Agent 负责实现、测试和同步文档。

## 技术约束

- TypeScript `strict`；Node.js **26.12.1**、pnpm **12.15.0**（`.node-version`、`package.json`）。使用 Tailwind CSS，保留项目主题 CSS；线上仍是 Workers runtime。
- 依赖只用 pnpm，提交 `pnpm-lock.yaml`，本地与 CI 均按锁文件安装；版本升级同步配置与文档。
- 配置唯一声明源为 `src/server/settings.ts`。`.env.production`、`.env.cloudflare`、`local/` 不入 git，不写死部署方的信息。

## 工作方式与质量门槛

- 简述实施顺序后直接推进；常规选择自行判断。只在信息缺失实质影响目标或范围时提问，并继续不受影响的工作。
- 新工作先建立最小可运行骨架和质量检查，再逐步实现可验收功能。拆成小而完整、可独立验证和回退的单元；每个单元通过适用检查后，**实际创建 Git commit**，提交信息说明目的。
- 每个 commit 只聚焦一个目的，包含代码、测试及必要文档。行为、命令或架构改变时同一 commit 更新现行文档，删除过时内容；历史材料移入 `docs/archive/`，模块规则写入对应目录的 `AGENTS.md`。
- Biome recommended 统一格式与 lint，警告和错误均须修复；strict 类型检查、核心规则/边界/异常的 unit tests、主要流程 e2e 和生产构建均是交付门槛。
- 禁止靠关闭规则、跳过测试或放宽断言掩盖问题；必要例外须限定范围并就地说明理由、在测试策略中记录。
- 正常调试和验证照常进行。**禁止任何独立代码审查**：不得启动 reviewer agent、安排额外 code review 任务或添加 AI 自动审查工作流。
- 交付简述实现、Git commits、实际检查结果及未解决阻塞；本地结果与 GitHub Actions 实际状态分开报告，未执行的明确写“未执行”。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium  # 首次准备浏览器
pnpm run check               # 全部质量门槛，与 CI 相同
pnpm run dev                 # 本地网页与 Worker，127.0.0.1:4381
pnpm run demo:seed           # 替换本地 D1 为演示数据
pnpm run format:check        # Biome 格式检查
pnpm run lint                # recommended，警告也失败
pnpm run typecheck           # 独立 strict 类型检查
pnpm run test:unit           # 核心规则与边界
pnpm run test:integration    # 本地 Workers / D1 / R2 回归
pnpm run test:cli            # cf 开发服务、存储与生产打包 dry-run（先 build）
pnpm run test:e2e            # 桌面与移动端浏览器流程（先 build）
pnpm run build              # 网页生产构建 + cf Worker 打包
pnpm run doctor             # 只读部署配置体检
```

## 按任务读取

| 任务                       | 必要资料                                                     |
| -------------------------- | ------------------------------------------------------------ |
| 开发、依赖、提交           | [开发流程](docs/development.md)                              |
| 模块边界、运行环境、数据流 | [架构](docs/architecture.md)、[现行决策](docs/decisions.md)  |
| 测试或质量检查             | [测试策略](docs/testing.md)                                  |
| 首次部署、升级、配置、回滚 | [部署指南](docs/deployment.md)；不要为了开发任务读取部署密钥 |
| 用户功能或产品规则         | [README](README.md)                                          |
| 追溯已废弃方案             | 仅按需读 `docs/archive/`；历史内容不作为现行规范             |
