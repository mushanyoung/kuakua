# 网页规则

先读根 `AGENTS.md`；页面交互与测试看 `docs/testing.md`，工具链看 `docs/development.md`。

- 中文和英文文案同步维护在 `i18n.ts`；前端权限显示与服务端规则保持一致。
- 使用 Tailwind 通用工具类；主题与复杂效果在 `styles/` 对应组件文件维护，不创建重复样式系统。
- 交互支持键盘、可访问名称、焦点和 reduced-motion；Effect 依赖变化必须验证没有请求循环或无意重置用户输入。
- 主要流程 e2e 使用真实网页和本地 Worker；API mock 不替代流程验收。
