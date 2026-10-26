# 架构与边界

浏览器经 Cloudflare Access 登录后访问同一个 Worker。Worker 提供 React 静态资源和 `/api/*`、`/avatars/*`；D1 保存人员、帖子、积分与同步状态，R2 保存来源头像、自定义头像、名单。Cron 驱动通讯录同步，无常驻服务器。

| 模块 | 责任 |
| --- | --- |
| `src/server/worker.ts` | 路由、请求校验、错误响应、后台通知生命周期 |
| `auth.ts` / `config.ts` | Access JWT 校验、身份与运行配置 |
| `store.ts` / `db.ts` | 业务权限、积分、可见性、D1 查询与原子批次 |
| `directory.ts`、`roster*.ts`、`lark*.ts` | 名单 / Lark 同步及群成员解析 |
| `avatars.ts`、`email.ts`、`notify.ts` | R2 头像和通知适配 |
| `src/web/` | React 页面、交互、双语、Tailwind 和主题 CSS |
| `src/shared/` | 标签、表情、头像等跨端规则 |
| `scripts/` | Node.js 开发工具、打包、配置生成及部署流程 |

业务权限必须在服务端执行，前端隐藏入口不能替代授权。秘密夸仅发送人、接收人及抄送人可见；管理员身份本身不授予内容可见性。积分按部署时区分月，在 D1 原子批次中检查余额与写入。

`settings.ts` 是所有部署配置的唯一声明源，`.env.example` 由它生成。线上配置由部署脚本生成到 `local/`；本地开发和测试不需要线上凭据。数据库结构只追加 `migrations/NNNN_*.sql`，不修改已应用的迁移。
