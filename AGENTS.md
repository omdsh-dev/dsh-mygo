# dsh-mygo — 仓库规则（仓库级补充）

> 本仓库是 dsh-dev 工作区内的插件治理框架仓库。工作区级守则见 dsh_dev/
> AGENTS.md（含「核心框架仓库例外条款」）；本文件登记仓库级约定与验证命令，
> 两者冲突时以工作区守则为准。

## npm SDK 与安装形态

- 依赖只来自官方 NPM SDK（@deepseek-ai/* 公开 registry 包；2026-08-13 起
  官方包已公开发布，无需 NPM_TOKEN）；内部包间 `workspace:^` 为发布前过渡态
  （收口条件见 dsh_dev/AGENTS.md 例外 #2）。
- 禁止修改 DSH 源码：vendor 零补丁；install.sh 已随 P1 退役（2026-08-13）。
- **P3 起仓库自包含**：根 package.json + pnpm-workspace.yaml + 仓内
  tsconfig.base.json；不再向任何 dsh checkout 同步文件；例外 #1（checkout
  写入豁免）随之失效删除。

## next 分支重做约定（2026-08-13 登记）

- `next` 分支为 v0.2 重做线：包名统一 `@r05en1cu/dsh-*`，`author` /
  `maintainers` 声明 `r05En1cU`；发布留作 handoff（dsh_dev/AGENTS.md 发布
  禁令条款），publish-mygo.mjs 只改造不执行。
- 现阶段分发渠道：不发任何公开 registry（含自有 scope）；一律走
  GitHub repo + pnpm git spec 安装形态（`dsh plugin add github:<owner>/
  <repo>#<commit>&path:/packages/<pkg>`），依赖 push 禁令解除后生效
  （2026-08-13 用户裁决）。
- 强耦合依赖分析体系（resolver / dsh.lock / 冲突求解 / 激活求解器）已退役
  （P1，2026-08-13）：存档提交 `43bb296`（main）；pnpm 安装状态为唯一真相源，
  mygo 账本降级为治理视图（P3 已落地 `src/governance.ts`）。
- 安装/分发走 dsh 0812 原生 profile bundle 机制：mygo / mygo-cli 携带
  `dsh.bundle.patch` + 包内 cordis.patch.yml；install.sh、vendor/cordis-alias、
  vendor/PATCHES.md 已随 P1 删除；面板已迁入 `packages/extensions/mygo-panel`
  （P3），vendor/ 不再承载运行时包。

## 包级规范（对齐官方 plugin-template，npm SDK 形态）

- 每包 package.json 提供 build / typecheck / test / verify:self-contained /
  prepare 五个标准脚本；exports / files 白名单与 src 布局同步维护。
- 验证回路（仓内，无网拦截）：
  `pnpm -r run verify:self-contained && pnpm -r run typecheck && pnpm -r test
  && pnpm -r run build`；提交前另跑 EB 套件（`test/eb` 独立配置）与
  全量回归。

## 提交纪律

- 内测期禁 push / 禁 npm publish（dsh_dev/AGENTS.md 守则）。
- 禁 emoji（含提交信息，扫描口径 Emoji_Presentation=Yes；tests/fixtures
  整体豁免）。
- extension/mygo-rdb 三件本地修正（package.json / bom.spec.ts /
  extension-mygo-rdb.spec.ts）永不提交，维持用户既有 ignore 裁决。
