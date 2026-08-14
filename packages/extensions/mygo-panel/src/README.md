# Source Layout

`src/index.ts` 是面板服务端注册面（settings.section / api 路由）；
`src/client/` 是 Web 客户端（r7 起组件化拆分，经 tsdown 产出 lib/client.js）：

- `api.ts` — /api/mygo/* 类型化客户端与全部面板数据类型（单点契约镜像）
- `Panel.tsx` — 主壳：头部概览（版本/统计/BOM）+ 标签页导航 + 通知条 + 配置抽屉
- `PluginList.tsx` / `InstallPanel.tsx` / `UpdatesPanel.tsx` /
  `ConfigHelper.tsx` — 四个标签页
- `ConfigEditor.tsx` — 抽屉形态配置编辑器（表单/JSON、重置模板、复制 JSON）
- `ConfirmDialog.tsx` — 危险操作/计划警告统一确认弹窗
- `ConfigCards.tsx` / `ConfigFields.tsx` — settings.plugin.item 槽聚合
  卡片与共享字段编辑器

`src/css-modules.d.ts` 是 CSS Modules 类型声明。新增客户端能力时同步更新
`package.json` 的 `exports` 白名单（./client）。
