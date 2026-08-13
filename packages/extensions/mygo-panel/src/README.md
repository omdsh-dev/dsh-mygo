# Source Layout

`src/index.ts` 是面板服务端注册面（settings.section / api 路由）；
`src/client/` 是 Web 客户端（Panel.tsx 等，经 build.mjs 产出 lib/client.js）；
`src/css-modules.d.ts` 是 CSS Modules 类型声明。新增客户端能力时同步更新
`package.json` 的 `exports` 白名单（./client）。
