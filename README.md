# 🐋 dsh-mygo

> 给 DSH 装上“受管插件”：HMR 热替换 + 完整插件生命周期，0 侵入。
> 名字致敬《BanG Dream! It's MyGO!!!!!》（迷途之子）——插件们各怀心思，
> 但总有一个地方会把它们聚在一起。

**版本：0.2.1 · 2026-08-10**（0810 分支适配 + 客户端兼容 + 测试清理；
0.2.0：HMR 语义重构 + 依赖体系 + 持久化 + BOM）

mygo 是 DSH 的受管插件层：插件不再是裸的 Cordis 行，而是有安装/启停/卸载/
替换/恢复语义、能热替换（HMR）、坏插件不会拖垮后端的“受管对象”。权限核心已
移除，通过透明 facade 直接用宿主 API——不需要改 dsh core。

## 支持的分支

- **0810（主支持）**：`snapshots/20260810T155924Z-8ec407cd64`，浏览器
  half 原生 `dsh.client` 语义；
- **0809（兼容）**：可运行；浏览器 half 需要 `dshClient`，面板/桥接自动
  双写、官方 bundle 安装自动注入，无需手动处理；
- **无 `dsh.client` 语义的旧插件**：暂不支持（等插件作者升级），不会硬适配。

## 快速开始

目标 checkout 拉 0810 分支后，用仓库里的 `install.sh` 接线（复制包、tsconfig、
依赖、profile 行、记录自身版本）：

```sh
git clone https://github.com/dsh2026/test-r05En1cU.git -b snapshots/20260810T155924Z-8ec407cd64 <dsh-checkout>
git clone https://github.com/dsh-external/dsh-mygo.git
cd dsh-mygo
DSH_CHECKOUT=<dsh-checkout> ./install.sh
cd <dsh-checkout> && pnpm run build
dsh web
```

重启后设置页出现 **“My 插件”** 和 **“外部应用”** 两个分区：

- 插件安装：GitHub 仓库 / 本地文件夹 / zip·tar.gz / **官方 bundle tgz**；
  可勾选“自动安装依赖并构建”；
- 启停/卸载（二次确认）、配置模板与保存（HMR 热生效）、远程更新（GitHub
  插件走 `updateRaw` 热替换，session 不重启）；
- **mygo 自身更新**：检查更新里包含 `dsh-mygo`（`~/.dsh/mygo-self.json`
  记录远端/commit/version），更新走 Loader 热重载 + recover；
- **BOM**：导出当前依赖图为 `dsh.bom/v1`（mygo 自身一等成员），只读对账，
  离线脚手架生成新插件声明骨架。

## 它能做什么

- **HMR 插件管理**：install / enable / disable / replace / uninstall /
  recover；替换对齐宿主 `fiber.update`（dispose-first：先释放旧代再应用
  新代），seat 类注册不重复，失败自动回滚重挂旧代；
- **兼容性检查与插件依赖**：Fabric 五级词汇（depends / recommends /
  suggests / conflicts / breaks）+ 传递闭包链报告、激活求解器、bundle 轨
  统一依赖图、声明式 manifest（package.json `dsh.mygo` 段 +
  `ctx.entrypoints`）；
- **零侵入 raw 接入**：`fromCordisPlugin` / `adoptRaw` 直接纳入任意 Cordis
  插件，facade 拦截注册面（tools / systemPrompt / httpServer / skills /
  commands / effect / timers），其余透传宿主；
- **持久化后端无关**：mygo-rdb extension 把注册表持久化切到 rdb/postgres
  （store-provider 接管 + sqlite→rdb 迁移 + audit 迁入），并支持从
  jsonl / sqlite / rdb 会话读取对话记录；
- **停用/卸载语义**：停用后工具保持注册、dispatch 拦截回报；卸载持久化
  tombstone，重装自动清除；
- **外部应用模式**：独立 `mygo-apps` 根、进程组启停、沙箱档位、
  `syncUninstall: false` 标识 + 操作审计；
- **配置助手**：临时对话（continuable child session），自动读配置模板、
  装插件、改配置，排队 + 超时自愈；
- **P4 BOM**：依赖参考物（intent+lock 双段）、只读对账、离线脚手架；
  套件生命周期（install/upgrade/apply）留 P5。

## 开发者

- **BOM 参考**：`POST /api/mygo/bom/export` 生成
  `~/.dsh/mygo-boms/<profile>/dsh.bom.{json,md}`；新插件声明用
  `POST /api/mygo/bom/check { "target": "<dir>" }` 校验；
- **脚手架**：`node ~/.dsh/mygo-boms/bom-scaffold.mjs <id> --bom
  ~/.dsh/mygo-boms/<profile>/dsh.bom.json`，自动填 `depends
  service:mygo-core` 当前版本带；
- **声明式 manifest v1**：package.json `dsh.mygo` 段（entrypoints +
  compatibility）；client half 用 `dsh.client`（0809 另兼容 `dshClient`）；
- **构建/测试**在 dsh checkout 里做（dsh-mygo 是源树）：

```sh
cd <dsh-checkout>
node node_modules/typescript/bin/tsc -b packages/core/mygo-api packages/cordis/mygo --pretty false
node node_modules/tsdown/dist/run.mjs --config packages/core/mygo-api/tsdown.config.ts
node node_modules/tsdown/dist/run.mjs --config packages/cordis/mygo/tsdown.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  packages/core/mygo-api/tests packages/cordis/mygo/tests
```

全量测试建议拆小串行跑（WSL 环境偶发 worker D 状态）；运行实例用
`~/.dsh/source/current` 的构建产物，改完需同步 + 重建 lib + 重启。

文档：`CHANGELOG.md`（版本记录）、`docs/development-memo.md`（开发备忘录）、
`docs/next/`（提案与设计）。

## 边界与已知问题

- **新增带 client half 的包（桥接或官方 bundle）要重启才进 roster**：
  宿主 ClientModuleHost 对包的分类判定做进程级缓存，0809/0810 一致；
  代码重建走 rev HMR，无需重启；
- **`immediate` 替换策略等待 in-flight 事件（无超时）**：插件有常驻事件
  监听时建议用 `drain`（30s 超时，失败不动旧代）；
- **rdb 注册表依赖 PostgreSQL**（mygo-pg 容器 / Docker Desktop），
  PG 不可用会 fail-loud（`registry backend self-check failed ... 5432`）；
- 显式不支持：0804/0805 时代工作区插件（`workspace:` 协议）、apply 内
  `ctx.plugin` 组合子插件（如 dsh-rewind）、依赖渲染器核心补丁的插件
  （split-panes / working-activity）；
- storage-domain medium-reset 不回补（0 侵入冲突）；
- BOM 套件生命周期（install/upgrade/apply/reconcile）→ P5。

## 常见问题

- **设置页看不到“My 插件”？** 0810 需要面板包声明 `dsh.client`（0.2.1 已
  带）；装完 bundle/插件后强刷，若 client half 仍不出现先重启
  （ClientModuleHost 缓存边界）。
- **装插件报“版本过老”？** 0804/0805 时代工作区插件需要放进 dsh 源码仓库
  安装，请用作者的新版独立包。
- **后端起不来？** 先看日志：守卫桥接会跳过导入失败/不支持的插件；日志出现
  `registry backend self-check failed ... 5432` 时先确认 PG 在线。
- **配置保存长时间不返回？** `immediate` 策略等待该插件 in-flight 事件
  结束（无超时），建议改用 `drain`。

---

License: MIT
