# dsh-mygo

> DSH 的受管插件层：**轻量核心 + 一切皆扩展**。
> 名字致敬《BanG Dream! It's MyGO!!!!!》——插件们各怀心思，但总有一个地方
> 会把它们聚在一起。

**版本：0.0.1-rc.1（2026-08-12）** · 与 `@deepseek-ai/dsh` rc.1 同版本线。
上一线：0.2.x（HMR 受管插件 + 外部应用 + 远程更新，面板中心）。

## 这是什么

mygo 把 DSH 的插件从「裸 Cordis 行」升级为「受管对象」：安装/求解/锁定/启停/
替换/恢复语义、依赖图与符号级校验、打包分发、结构化失败报告，以及运行期政策
闸（requires）与细粒度 epoch 反应式重载。**核心不做产品功能**——CLI、web 面板、
外部存储、未来的 loader 都是插件/扩展。

### 核心功能定位（本次变更）

| 维度 | 0.2.x（旧） | 0.0.1-rc.1（当前） |
|---|---|---|
| 核心 | 面板中心的 HMR 生命周期 + 外部应用 + 远程更新 | 包治理核心：求解器 / lockfile / 不可变 store / 政策闸 / 细 epoch / 报告 |
| 分发 | GitHub/文件夹/压缩包/官方 bundle tgz（面板装） | `mygo-pack/v1` 确定性打包 + CLI `pack/restore`（离线、原子、可审计） |
| 依赖管理 | 兼容性告警为主 | manifest v3 插件图 + 确定性全序求解 + 符号前置门 + 双存在告警 |
| 运行期 | HMR 替换 | 七步替换协议 + swapPolicy + dispose 超时放弃等待（dispose-abandoned，不阻塞回滚） + requires 政策闸（INACTIVE/自动激活） |
| 用户面 | 设置页「My 插件」面板 | 面板（扩展）+ `dsh --profile <p> mygo pack|restore|init`（扩展插件） |
| 生态接口 | 直触 manager | `@deepseek-ai/dsh-mygo-api` 契约层（Cordis-free），外部工具 SHOULD 只依赖它 |

## 设计：轻量核心 + 一切皆扩展

- **核心**（`packages/cordis/mygo`）：manifest/求解/锁定/存储/校验/政策闸/报告/
  生命周期引擎。零产品 UI，零宿主耦合（通过 `mygo-api` 契约与 Cordis 桥接）。
- **契约层**（`packages/core/mygo-api`）：Cordis-free 的插件作者面
  （`definePlugin`、manifest/environment 类型、`PluginError` 43 码、fake-env）。
- **扩展**：
  - `packages/cordis/mygo-cli` —— 用户命令面（pack/restore/init），本身是 mygo 受管插件；
  - `vendor/dsh-mygo-panel` —— web 设置页「My 插件」面板（`settings.section` 槽 + `/api/mygo/*`）；
  - `extension/mygo-rdb` —— 外部注册表存储（sqlite/postgres，`RegistryStore` 契约）；
  - loader 契约（v1 内置 standard/mixin）—— 未来 loader 插件化。

## 版本号与 npm 迁移

- **改版本号**：`VERSION` 与各包 `package.json` 从 0.2.x 迁到 **0.0.1-rc.1**
  （panel 0.1.0-rc.1），与 `@deepseek-ai/dsh@0.0.1-rc.1`、`@deepseek-ai/cordis@4.0.1-rc.1`
  同线；`install.sh` 写入 `~/.dsh/mygo-self.json`。
- **转 npm**：
  - 依赖与 peer 全部改用 `@deepseek-ai/cordis`（rc.1）+ rc peer 区间；
  - `publishConfig.access: restricted`；发布流水线 `scripts/publish-mygo.mjs`
    （mygo-api / mygo / panel；CLI 待纳入）；
  - 未发布的内部依赖在源码态用 `workspace:^`，发布后切换为 registry 区间；
  - 安装形态：源码 checkout 用 `install.sh`（复制 + 构建 + 回退链接 +
    `DSH_SKIP_PNPM=1` 可选）；npm rc.1 profile 用 `file:/link:` 或 profile patch
    预置（design-r5 §1.3 口径）。

## 快速开始

### 源码 checkout（0811+）

```sh
cd <dsh-checkout>                 # 0811 快照（如 test-r05En1cU-0811）
cd dsh-mygo
DSH_CHECKOUT=<dsh-checkout> ./install.sh          # 复制/接线/构建 mygo 四包
cd <dsh-checkout> && npm run build                # host + client + web 全量构建
dsh web --port 3080                               # lib 生产模式启动
```

> 0811 源码经 tsx 直跑不兼容（`FiberState` const enum），请使用构建产物
> （`apps/cli/lib/bin.js` 或仓库 `bin/dsh`）。

### 命令面（CLI 扩展插件）

```sh
dsh --profile web mygo pack [-o out.mygo-pack] [--json]
dsh --profile web mygo restore <pack> [--profile <target>] [--json]
dsh --profile web mygo init <name> [--id <id>] [--dir <dir>] [--json]
```

CLI 本身是 mygo 受管插件：可经面板 folder 安装激活，也可出现在打包产物中
（自举：还原后 store 入口与源码逐字节一致）。

### Web 面板

设置页「My 插件」：安装（GitHub/文件夹/压缩包）、启停/卸载、配置编辑、
BOM 导出、远程更新（外部应用面为旧扩展，按需保留）。

> 治理差异提示：面板 folder 安装走静态装载（adoptRaw），账目 = 桥接行 + 安装
> 目录 + 静态记录，不写 pack 期 `dsh.lock/v1`；npm/pack 安装路径才写 lockfile。
> 该账本分叉已登记为候选决策 CD-2（docs/next/2026-08-12-cd-2-panel-adoptraw-ledger.md）。

## 仓库布局

```text
packages/core/mygo-api/      契约层（Cordis-free；definePlugin/类型/PluginError/fake-env）
packages/cordis/mygo/        核心实现（求解/lockfile/store/生命周期/政策闸/epoch/pack/报告）
packages/cordis/mygo-cli/    CLI 扩展插件（pack/restore/init + 报告渲染）
vendor/dsh-mygo-panel/       Web 面板扩展（/api/mygo/* + settings.section）
vendor/cordis-alias/         开发态 @deepseek-ai/cordis 别名（0810 checkout 用）
extension/mygo-rdb/          外部注册表存储扩展（RegistryStore 契约）
patches/                     DSH host 补丁提案 / 依赖补丁契约（官方语义，不 apply）
scripts/publish-mygo.mjs     发布流水线（dry-run 门禁）
install.sh                   源码 checkout 安装器
docs/                        设计/验证/备忘录（见下）
AGENTS.md                    仓库级规则补充（npm SDK / 包级规范 / 提交纪律）
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

- 全量回归 64 文件 / 625 用例（无网 fetch 拦截；CLI 19 项含 T50/T51 spike；
  其中 3 个 mygo-rdb 用例依赖本地未提交修正，提交态为 621——见备忘录）；
  EB 假设套件 13/13；typecheck 三包通过。
- 确定性断言字节级；故障按 impl-bug / design-gap / fixture-issue 三分类；
  vendor 修改登记 `vendor/PATCHES.md`（当前 vendor 零补丁；#1 已按守则移除）。

## License

MIT
