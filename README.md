# dsh-mygo

> DSH 的受管插件层：**轻量核心 + 一切皆扩展**。
> 名字致敬《BanG Dream! It's MyGO!!!!!》——插件们各怀心思，但总有一个地方
> 会把它们聚在一起。

**版本：0.2.0-rc.0（2026-08-13，next 重做线）** · 包名统一 `@r05en1cu/dsh-*`，
author/maintainers 声明 `r05En1cU`（发布留作 handoff）。上一线：0.2.x（HMR 受管
插件 + 外部应用 + 远程更新，面板中心）与 0.0.1-rc.1（@deepseek-ai scope 内测线）。

> **next 分支重做中（v0.2 线）**：强耦合依赖分析体系（resolver / dsh.lock/v1
> lockfile / 不可变 package-store / 激活求解器）已退役——pnpm 安装状态是唯一
> 真相源，mygo 账本降级为治理视图（P3 落地）。安装形态重做中（install.sh 已
> 退役，新形态随 P3 提供）。

## 这是什么

mygo 把 DSH 的插件从「裸 Cordis 行」升级为「受管对象」：安装/启停/替换/恢复
语义、符号级校验、确定性打包分发、结构化失败报告，以及运行期政策闸（requires）
与挂载时符号快照反应式重载。**核心不做产品功能**——CLI、web 面板、外部存储、
未来的 loader 都是插件/扩展。

### 核心功能定位（本次变更）

| 维度 | 0.2.x（旧） | 0.2.0-rc.0（当前，next 重做后） |
|---|---|---|
| 核心 | 面板中心的 HMR 生命周期 + 外部应用 + 远程更新 | 包治理核心：单插件版本选择 / 普通落盘还原 / 政策闸 / 符号快照 / 报告（求解器与 lockfile 已退役） |
| 分发 | GitHub/文件夹/压缩包/官方 bundle tgz（面板装） | `mygo-pack/v1` 确定性打包 + CLI `pack/restore`（离线、原子、可审计） |
| 依赖管理 | 兼容性告警为主 | manifest v3 兼容词汇直通（告警/预检面）+ 符号前置门 + 双存在告警；跨插件约束求解已删除 |
| 运行期 | HMR 替换 | 七步替换协议 + swapPolicy + dispose 超时放弃等待（dispose-abandoned，不阻塞回滚） + requires 政策闸（INACTIVE/自动激活） |
| 用户面 | 设置页「My 插件」面板 | 面板（扩展）+ `dsh --profile <p> mygo pack|restore|init`（扩展插件） |
| 生态接口 | 直触 manager | `@r05en1cu/dsh-mygo-api` 契约层（Cordis-free），外部工具 SHOULD 只依赖它 |

## 设计：轻量核心 + 一切皆扩展

- **核心**（`packages/cordis/mygo`）：manifest/版本选择/还原/校验/政策闸/报告/
  生命周期引擎。零产品 UI，零宿主耦合（通过 `mygo-api` 契约与 Cordis 桥接）。
- **契约层**（`packages/core/mygo-api`）：Cordis-free 的插件作者面
  （`definePlugin`、manifest/environment 类型、`PluginError` 39 码、fake-env）。
- **扩展**：
  - `packages/cordis/mygo-cli` —— 用户命令面（pack/restore/init），本身是 mygo 受管插件；
  - `packages/extensions/mygo-panel` —— web 设置页「My 插件」面板（`settings.section` 槽 + `/api/mygo/*`）；
  - `extension/mygo-rdb` —— 外部注册表存储（sqlite/postgres，`RegistryStore` 契约）；
  - loader 契约（v1 内置 standard/mixin）—— 未来 loader 插件化。

## 版本号与 npm 迁移

- **版本线（next 重做）**：`VERSION` 单源 **0.2.0-rc.0**，三包 `package.json`
  版本同步；包名统一 `@r05en1cu/dsh-mygo-api` / `@r05en1cu/dsh-mygo` /
  `@r05en1cu/dsh-mygo-cli`，`author`/`maintainers` 声明 `r05En1cU`。
  安装器写入 `~/.dsh/mygo-self.json`（install.sh 退役后由 P3 新安装形态承担）。
- **转 npm**：
  - 依赖与 peer 全部改用 `@deepseek-ai/cordis`（rc.1）+ rc peer 区间；
  - `publishConfig.access: restricted`；发布流水线 `scripts/publish-mygo.mjs`
    （mygo-api / mygo / panel；CLI 待纳入），发布留作 handoff；
  - 未发布的内部依赖在源码态用 `workspace:^`（@deepseek-ai/* 与 @r05en1cu/*
    过渡豁免），发布后切换为 registry 区间；
  - 安装形态：next 分支重做中（install.sh 已退役；新形态走 dsh 0812 原生
    profile bundle / pnpm 机制，随 P3 落地，见 docs/next/）。

## 快速开始

> P3 起仓库自包含（pnpm workspace + 公开 registry 依赖）；安装形态 =
> dsh 0812 原生 profile bundle 机制，install.sh 已退役。

### 安装（dsh 0812+ 原生 profile bundle）

mygo / mygo-cli 是标准 `dsh.bundle` 包（包内 `cordis.patch.yml` 层）：

```sh
# 发布留作 handoff；内测期从仓库 tarball 安装
dsh plugin --profile web add <dsh-mygo.tgz>     # pnpm add + bundle 层对账
dsh plugin --profile web add <dsh-mygo-cli.tgz>
dsh web                                          # profile 组合自动挂载 mygo 行
```

git spec 渠道（`dsh plugin add github:r05En1cU/dsh-mygo#<commit>&path:/packages/cordis/mygo`
形态）按 D9 登记，push 禁令解除后生效。

### 命令面（CLI 扩展插件）

```sh
dsh --profile web mygo install <spec> [--json]        # profile 目录 pnpm add + bundle 对账
dsh --profile web mygo uninstall <name> [--json]
dsh --profile web mygo enable|disable <id> [--json]   # profile patch 层 disabled 块
dsh --profile web mygo pack [-o out.mygo-pack] [--json]
dsh --profile web mygo restore <pack> [--profile <target>] [--json]
dsh --profile web mygo init <name> [--id <id>] [--dir <dir>] [--json]
```

CLI 本身是 mygo 受管插件：可经面板 folder 安装激活，也可出现在打包产物中
（自举：还原后落盘入口与源码逐字节一致）。

### 开发验证（仓内自包含回路）

```sh
pnpm install
pnpm -r run verify:self-contained && pnpm -r run typecheck && pnpm -r test && pnpm -r run build
```

### Web 面板

设置页「My 插件」：安装（GitHub/文件夹/压缩包）、启停/卸载、配置编辑、
BOM 导出、远程更新（外部应用面为旧扩展，按需保留）。

> 治理差异提示：面板 folder 安装走静态装载（adoptRaw），账目 = 桥接行 + 安装
> 目录 + 静态记录；dsh.lock/v1 已随求解体系退役，账本分叉收口为「pnpm 安装
> 状态唯一真相 + mygo 治理视图」（CD-2，P3 落地，
> docs/next/2026-08-12-cd-2-panel-adoptraw-ledger.md）。

## 仓库布局

```text
packages/core/mygo-api/        契约层（Cordis-free；definePlugin/类型/PluginError/fake-env）
packages/cordis/mygo/          核心实现（版本选择/还原/生命周期/政策闸/快照/pack/报告/治理视图）
packages/cordis/mygo-cli/      CLI 扩展插件（install/enable/pack/restore/init + 报告渲染）
packages/extensions/mygo-panel/ Web 面板扩展（/api/mygo/* + settings.section）
extension/mygo-rdb/            外部注册表存储扩展（RegistryStore 契约）
patches/                       DSH host 补丁提案 / 依赖补丁契约（官方语义，不 apply）
scripts/publish-mygo.mjs       发布流水线（dry-run 门禁）
docs/                          设计/验证/备忘录（见下）
AGENTS.md                      仓库级规则补充（npm SDK / 包级规范 / 提交纪律）
```

## 文档地图

- `docs/DEV-GUIDE.md` —— 开发者指南：mygo 在 Cordis 之上补充的全部逻辑拆解
  （依赖管理/启停/epoch/打包/报告/治理/持久化/扩展点）。
- `docs/expected-behavior.md` —— 冻结基线（EB-D1..D22）。
- `docs/design-r2.md` / `design-r3.md`（+ `design-r3-backlog.md`）/
  `design-r4.md`（+ `design-r4-backlog.md`）—— 设计定稿与实现任务清单。
- `docs/design-r5-cli.md` —— CLI 用户面设计（命令面/报告渲染/注册机制/init/离线）。
- `docs/two-tier-contract.md` —— 体系内/社区双 tier 契约（含 mygo-api 边界）。
- `docs/community-census.md` / `docs/ecosystem-verification.md` —— 生态普查与验证。
- `docs/assumption-verification.md` —— 假设验证（A1-A11 等）。
- `docs/e2e-verification.md` —— E2E 验证（T21-T31、P-0 离线纪律）。
- `docs/plugin-pack-verification.md` —— pack 体系真实验证轮（T32-T43、RT1-RT5、流程纪律）。
- `docs/cli-verification.md` —— CLI 验证 + Phase C webui spike（§8，含 EXT-3）。
- `docs/round-closeout.md` —— 基线冻结与收尾（含 EB 修订登记）。
- `docs/EXT-CD-index.md` —— EXT 外部依赖 / CD 候选决策索引。
- `docs/next/2026-08-12-mygo-api-surface.md` —— 契约层公开面盘点 + CD-1。
- `docs/next/2026-08-12-cd-2-panel-adoptraw-ledger.md` —— 面板静态账 vs lockfile 账本分叉（CD-2）。
- `docs/next/2026-08-12-live-3080-out-of-box-memo.md` —— 运行环境迁移备忘录。
- `docs/next/2026-08-12-npm-template-normalization.md` —— 官方 plugin-template 对齐的 npm SDK 规范化记录。

## 测试与纪律

- 全量回归 66 文件 / 643 用例（2026-08-13 P4 口径：mygo-api 6 文件 39 +
  mygo 54 文件 577 + mygo-cli 6 文件 27；无网 fetch 拦截；mygo-rdb 关联
  用例依赖本地未提交修正——见备忘录）；
  EB 假设套件 13/13；typecheck 三包通过。
- 确定性断言字节级；故障按 impl-bug / design-gap / fixture-issue 三分类；
  vendor 零补丁（PATCHES.md 登记制度随 install.sh 一并退役，2026-08-13）。

## License

MIT
