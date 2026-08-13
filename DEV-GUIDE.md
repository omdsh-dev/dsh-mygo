# DEV-GUIDE：mygo 开发者指南

> 面向要在 mygo 上开发插件、改 mygo 核心或接入生态接口的开发者。
> 本文拆解 mygo 在 Cordis 之上补充的全部逻辑：依赖管理、停用/启用、符号快照、
> 打包分发、报告、运行期治理、持久化与扩展点。事实以本仓库当前 HEAD 为准；
> 冻结基线见 `expected-behavior.md`（FROZEN，只追加修订）。

> **next 分支（2026-08-13 范围重塑）**：强耦合依赖分析体系已退役——
> resolver（跨插件约束求解）、dsh.lock/v1 lockfile、不可变 package-store、
> 激活求解器（solveActivation 级联启停）均已删除；pnpm 安装状态是唯一真相源，
> mygo 账本降级为治理视图（P3 落地）。本文 §3/§6 已按新口径改写；
> 旧体系存档见 main 分支 `43bb296`。

## 0. 一句话模型

Cordis 给你 fiber/effect/事件/服务注入/loader 组合；**mygo 在这之上补充了
「受管插件生命周期 + 包治理」**：插件不再简单经过 load/registry 路径自己 import 加载，
而是经过 manifest → 版本选择 → 落盘还原 → 挂载 → 运行 → 替换/停用/卸载 的受管管线，
每一步都有确定性与可审计账目。

## 1. 架构分层

```text
外部工具/插件作者
   │  SHOULD 只依赖
   ▼
@r05en1cu/dsh-mygo-api（契约层，Cordis-free）
   │  fromCordisPlugin / toCordisPlugin / PluginError / definePlugin
   ▼
@r05en1cu/dsh-mygo（实现层，Cordis 桥接）
   ├── package/*       包治理：manifest/版本选择/还原/扫描/打包
   ├── lifecycle.ts    生命周期引擎（七步替换、恢复、政策闸、提供表）
   ├── dispatch.ts     事件派发机（emit/waterfall/parallel/serial）
   ├── service.ts      PluginManagerService（ctx.pluginManager）
   └── bom/session-reader/capabilities/audit/persistence/...
   ▲                        ▲
扩展：mygo-cli（命令面）   扩展：dsh-mygo-panel（web 面板）、
                             extension/mygo-rdb（外部存储）
```

### 1.1 模块地图

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `package/manifest-v2.ts` | manifest v3 解析/校验（B1） | `parsePackageManifest`、`PluginManifestV3` |
| `package/version-select.ts` | 单插件确定性版本选择（钉定/区间/最高版） | `selectVersion` |
| `package/hash.ts` | 内容哈希工具（sha256/sha512/integrity 解析） | `sha256File`、`sha512File`、`integritySha512Hex` |
| `package/package-restore.ts` | 普通落盘还原（B10 路径安全；调用方指定目录） | `restorePackage`、`readRestoredPackage` |
| `package/package-manager.ts` | 安装编排（registry→版本选择→还原） | `resolveInstall`、`preview`、`buildPack`、`installPack` |
| `package/pack.ts` | `mygo-pack/v1` 打包/还原（B20-B24） | `buildPluginPack`、`installPluginPack` |
| `package/fine-epoch.ts` | 挂载时符号快照注册表与前置门（B13） | `FineEpochRegistry`、`preGate`、`captureExports` |
| `package/requires-gate.ts` | requires 政策闸（B6） | `evaluateRequiresGate`、`requiresGateReport` |
| `package/provider-observations.ts` | 服务提供者观测记录（B19） | `ProviderObservationRegistry` |
| `package/report.ts` | 结构化报告 schema（B7；code 取自 PluginError 闭表） | `ResolutionReport`、`ServiceResolutionReport` |
| `package/bundle-scan.ts` | 内嵌包扫描 + KF-1 分类（B26） | `detectUndeclaredBundles` |
| `package/symbol-verify.ts` | 符号级校验（导入投影 vs 运行时 exports） | `verifyPluginSymbols` |
| `package/harvester.ts` | npm 元数据信号归一（B11） | `harvestPackageMetadata` |
| `package/dual-presence.ts` | 双存在告警（B12） | `detectDualPresence` |
| `package/legacy-mapping.ts` | `dsh.plugin.json` 只读映射（B15） | `mapLegacyPluginFile` |
| `package/template-align.ts` | 官方模板对齐检查（B16） | `checkTemplateAlignment` |
| `package/bundle-expand.ts` | `dsh.bundle.patch` 展开（B14） | `expandBundlePatch` |
| `package/loader-registry.ts` | loader 契约注册表（v1: standard/mixin） | `BUILTIN_LOADERS` |
| `package/mount-orchestrator.ts` | 挂载相位（patch/mixin 顺序） | `MountOrchestrator` |
| `package/patch-table.ts` | patch 冲突检测/确定性排序 | `detectPatchConflicts` |
| `package/mixin-engine.ts` | mixin loader 的 AST 改写管线 | — |
| `package/paths.ts` | `$DSH_HOME/mygo` 路径（不变量 6/7） | `resolveMygoPaths` |
| `lifecycle.ts` | 引擎：七步替换/恢复/政策闸/提供表/快照记账 | `LifecycleEngine`、`wrapProvidedValue` |
| `dispatch.ts` | 事件派发机（模式/分支/否决） | `DispatchMachine` |
| `service.ts` | Cordis 服务面（ctx.pluginManager） | `PluginManagerService` |
| `bom.ts` | `dsh.bom/v1` 导出/对账（P4） | `buildBom`、`checkBom` |
| `capabilities.ts` | 能力面与配额（fs/vars/llm/exec/http/fetch） | `createPluginFs` 等 |
| `session-reader.ts` | jsonl/rdb/sqlite 会话读取 | `JsonlSessionReader` 等 |
| `sqlite-store.ts` / `persistence.ts` / `store.ts` | 注册表持久化与 `RegistryStore` 契约 | `SqliteRegistryStore`、`RegistryStore` |
| `audit.ts` / `snapshots.ts` | 审计日志 / 世代快照 | `AuditLog`、`SnapshotStore` |
| `plan.ts` / `order.ts` | 操作计划（纯求值预览）/ 派发顺序推导 | `planOperation`、`deriveOrders` |
| `event-vocabulary.ts` | 托管事件词汇（模式/分支） | `EVENT_VOCABULARY` |
| `config.ts` | 管理器配置默认值 | `resolvePluginManagerConfig` |

## 2. 插件契约（manifest v3）

插件作者只需在 `package.json` 写 `dsh.mygo` 块（或 legacy
`dsh.mygo.compatibility`），并 import `@r05en1cu/dsh-mygo-api`：

```jsonc
"dsh": { "mygo": {
  "formatVersion": 1,
  "id": "my-plugin", "version": "0.0.1", "entry": "lib/index.js",
  // 插件级兼容词汇（2026-08-13 起只读直通：告警/预检面，不参与安装求解）
  "compatibility": { "depends": { "other-plugin": "^1.0.0" }, "breaks": { "legacy": "<2.0.0" } },
  "requires": { "voice-chat": "^1.0.0" },     // 服务级（运行期政策闸，INACTIVE）
  "core": "^0.0.1-rc.1", "loader": { "id": "standard", "range": "^1.0.0" },
  "provides": ["my-capability"], "grants": { "fs": "..." }
}}
```

顶层 `depends` / `breaks` 已从 manifest v3 移除（安装期约束求解已删除）：
存量声明会被显式拒绝（`dsh.mygo.depends` / `dsh.mygo.breaks` 问题项），
请改写为 `compatibility` 块或删除。

运行期 `PluginEnv`（mygo-api `PluginEnv`，types.ts:247）给插件：`on/onHost/emit`、
`effect/hostEffect`、`provide/get`（服务隔离，未声明返回 undefined）、
`fs/vars/llm/exec/http/skills/commands/fetch`、`scope(agentId)`、
受权管理面（`plugins/install/uninstall/updateConfig`）。生命周期钩子
`PluginHooks`：`setup → activate → deactivate/captureState/restoreState/dispose`。

### 2.1 manifest 字段参考（作者向，来自 `package/manifest-v2.ts`）

| 字段 | 语义 | 示例 |
|---|---|---|
| `recommends` | 可选推荐依赖：只校验不选择、只警告不阻断、永不自动安装（design-r3 §2.6） | `"recommends": { "ui-helper": "^1.0.0" }` |
| `bundles` | 内嵌包声明（id + version + 包内路径），扫描校验对象 | `"bundles": [{ "id": "dep-x", "version": "1.2.0", "path": "vendor/dep-x" }]` |
| `patches` | mixin loader 的 patch 目标声明（module/filePath/symbol/operation） | `"patches": [{ "id": "p1", "target": { "module": "host", "symbol": "run", "operation": "around" }, "file": "patch.js" }]` |
| `symbolAliases` | 符号别名/兼容映射（`b: alias of c`，EB-D19）：改名可经别名解析，未声明别名按破坏性变更走删除路径 | `"symbolAliases": { "oldName": "newName" }` |
| `environment` | 只读环境元数据（如 `{platform:"web"}`）：不设硬门、仅报告展示（design-r3 §2.5） | `"environment": { "platform": "cli" }` |
| `grants` | 能力授权表达式（fs/network/vars/llm/exec/http 等）；默认拒绝 | `"grants": { "fs": "..." }` |
| `provides` / `loader` / `shared` / `entrypoints` | 服务能力声明 / loader 契约（v1: standard/mixin）/ 显式共享状态标记 / 入口贡献表 | — |

## 3. 依赖管理（mygo 在 Cordis 之上补充的核心之一）

Cordis 的组合是「行 + patch 层」；mygo 在其上补充「manifest 校验 + 确定性
版本选择 + 落盘还原 + 扫描/符号校验」。**pnpm 安装状态是唯一真相源**
（2026-08-13 范围重塑）：mygo 不再做跨插件约束求解、不写 lockfile。

### 3.1 单插件版本选择（`package/version-select.ts`）

输入：带有效 manifest 的候选版本集 + 可选请求区间 + profile 钉定（精确版本）
+ core 版本。输出：确定性全序（semver 降序 + 字典序兜底）的最高匹配版本；
钉定为硬选择（不在候选集 → 失败）；`core` 区间不满足只告警不阻断。
同输入必同输出。

### 3.2 落盘还原（`package/package-restore.ts`）

`$DSH_HOME/mygo/packages/<id>/<version>/`（普通目录语义，调用方指定目标），
还原原子化（staging → rename），事实文件 `.mygo-package.json`
（`dsh.mygo-package/v1`，含 manifest 快照与内容哈希）供幂等复用与 BOM/治理
视图消费。路径安全（B10）：entry/bundles/patches 禁逃逸，安装期校验。
已无「store 唯一真相」语义（目录生命周期归调用方）。

### 3.3 扫描与收割

- `bundle-scan`：整包扫描内嵌 `dsh.bundle` 声明 + npm 元数据分类（KF-1 裁决：
  dependencies/peerDependencies/optionalDependencies + 自身包名归一，未声明
  specifier 硬错）。
- `harvester`：`engines.dsh` / `cordis` peer / `@deepseek-ai/dsh-tools` peer →
  core 区间归一；无法映射 → 告警（EXT-1 锚定）。
- `dual-presence`：同一包既是插件又被 npm 嵌套依赖 → 告警不阻断。
- `symbol-verify`：静态收集导入投影，对照目标包运行时 exports；缺失硬阻断、
  不可解析告警放行（B13）。

### 3.4 版本谓词

`semver-range.ts` 是零依赖最小实现：`*`、精确、`= > >= < <= ^ ~`、空格 AND、
`||` OR；预发布按 npm 规则（区间必须对同一 tuple 显式带预发布比较符才匹配）。

## 4. 生命周期与启停（mygo 补充的第二块核心）

### 4.1 状态模型

两个正交维度：

- `status`（持久化指针）：`enabled | disabled | quarantined | shadowed | uninstalled`
- `policyStatus`（运行期政策，requires 闸求值）：`active | inactive | policy-rejected`

优先级：**disabled（用户显式关闭）> policy-rejected（政策拒绝）> INACTIVE
（依赖缺失）**——三态分立（EB-D16；expected-behavior §6 矛盾 2 裁决），三种停用都记账。

### 4.2 操作与七步替换协议（`lifecycle.ts` §14）

`install/enable/disable/uninstall/updateConfig` 都走 replace 协议（HMR 语义，
不重启宿主）。核心不变量：

1. 先持久化、后运行态生效（T3 规则：status 指针写在 generation 之后）；
2. 新一代 staging 全部成功才提交，失败整体回滚；
3. `swapPolicy`：`immediate`（直接换）/ `drain`（事件排空）/ `next-idle`
   （Agent 空闲）——有界等待；
4. dispose 有界（`disposeTimeoutMs` 默认 5000ms，0..30000 可配，EB-D21 /
   design-r3 §1.7）：超时 = **停止等待并放弃所有权**（JS 无法中止运行中的
   异步生成器，诚实声明）——不再 await 剩余 disposables，计入
   `dispose-abandoned` 报告（显式警告可能资源泄漏），释放过渡队列，
   后续过渡（含 P1-global 回滚与 P2 停用）不被阻塞。

`updateConfig` 只允许改配置（EB-D22：任何代码/exports 变更必须 remove+create，
物理不能换模块）。

### 4.3 requires 政策闸（`package/requires-gate.ts` + `lifecycle.reconcileRequiresGates`）

`requires` 不进依赖图；运行期求值三种违例：

- `service-missing`：当前无提供者 → INACTIVE；
- `provider-version-mismatch`：提供者版本不满足区间；
- `symbol-missing`：消费方被用符号不在提供者挂载时快照中。

提供者出现/消失时自动重算（EB-D16：INACTIVE 在提供者出现后自动激活）；
候选集来自 `ProviderObservationRegistry`（B19：谁在何时 provide 过什么，
随 fiber 清理，只读不阻断）。

> 已知边界：政策闸无法表达「要求管理器自身」（管理器 provides 仅
> `service:mygo-core`，requires 键禁 `service:` 前缀）——CLI 因此 requires 置空 +
> `ctx.get('pluginManager')` 惰性解析（design-r5 C5，用户追认）。

### 4.4 恢复（T4）

启动 `recover()`：读注册表行 → 校验 → `restored` / `quarantined`（损坏/不可解析）
→ GC 孤儿代；恢复顺序按注册表行序（lockfile 拓扑序已随 dsh.lock/v1 删除）。

## 5. 挂载时符号快照与反应式 reload

### 5.1 快照注册表（`package/fine-epoch.ts`）

`FineEpochRegistry`：能力 → 提供者符号投影快照（挂载时缓存导出键集 +
`symbolAliases`），纯内存比较（EB-D20：微秒~亚毫秒预算，reload 路径禁磁盘
I/O）。独立细 epoch 指纹函数已删除（无生产消费者，2026-08-13）。

### 5.2 notify 双源与前置门

每次 provide/unprovide 即时 + ACTIVE 状态翻转都触发一次政策闸重算（一个批次）；
`preGate` 用消费方导入投影对照提供者快照（含 `symbolAliases`）。动态访问
`core[name]()` 静态投影扫不到 → 运行时代理记录 `ProvidedAccessRegistry` 兜底
（A11）。

### 5.3 Proxy 桥接与 exports 冻结（EB-D8）

- 桥接路径：provide/ctx.get 处 Proxy 包装（原始对象不逃逸），
  `set/deleteProperty` 拒绝（exports 冻结）；
- 直连路径：契约外行为（后果自负），定期快照传感器为后续候选（本轮不实现）。

### 5.4 失败策略（P1/P2）

失败策略为两档：**P1-global 默认**（回滚 MUST 产与 P2 同规格结构化报告：
失败过渡、原因、回到哪一代）、**P2 硬约束**（不可回滚的强约束）。P1-local
已按裁决删除（正确性依赖内存管理行为，悬空风险堵不死）。

## 6. 打包与分发（pack 体系）

### 6.1 `mygo-pack/v1`

```text
<name>.mygo-pack (tar.gz)
├── mygo-pack.json   # 唯一清单（成员序固定第一位）
└── files/<i>.tgz    # vendored 插件 tarball（i = files[] 下标）
```

清单：`format/formatVersion/name/version/generated/plugins（id+version+
packageName）/files（pluginId+version+sha512+fileSize+integrity）/
communityDeps/manifestSha256`（2026-08-13 起不再内嵌 dsh.lock/v1 载荷，
版本钉死在 plugins[]/files[] 上）。
`manifestSha256` 对规范键序语义 JSON 计算；`generated.at` 归一 `<t>`。

### 6.2 确定性打包（B21）

`buildPluginPack`：枚举还原根（`<installRoot>/<id>/<version>/`）重打包
（`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner` +
`gzip -n` 语义的 Node zlib），排除 `.mygo-package.json`，transform `./` →
`package/`；工具能力探测（不支持 `--sort=name` 报错）。

### 6.3 离线还原（B22/B23）

`installPluginPack`：清单自校验 → 自实现 tar 头部预检（精确成员集白名单，
防换行文件名绕过）→ vendored sha512+fileSize 校验 → 内层 tarball 预检 →
普通落盘还原（原子、可回滚）。全程离线（RT5：fetch 计数 0）；一坏多好 →
整体拒绝、零写盘（T42）。无求解、无 lockfile 读写。

### 6.4 CLI（扩展插件，`packages/cordis/mygo-cli`）

`dsh --profile <p> mygo pack|restore|init`（L0：`ctx.cmdlineArgs`/`appExit`，
手写最小解析器；`--json` 直通结构化报告；退出码 0/1/2）。`init` 以
plugin-template@2da8230 资产生成骨架，写盘前过 B1 + `checkTemplateAlignment`
双校验（含 7 skills + lockfile，`verify:self-contained` 硬性要求）。

## 7. 报告与错误

CD-1 已裁决统一（2026-08-13）：**一套词汇**——mygo-api `PluginError` 闭表
39 码七组；结构化报告（`package/report.ts`）的 `code` 直接取自该表
（组 7 报告码：`resolve-failed / bundle-invalid / symbol-missing /
policy-rejected / pack-invalid / pack-hash-mismatch`），`manifest-invalid`
特指 mount 期 schema 校验（安装期 bundles 声明问题改名 `bundle-invalid` 消歧）。

- **结构化报告**（`package/report.ts`）：`ResolutionReport` 含 `scope`
  （package/service/pack）、`cycles`、`conflicts`（约束/链路/候选集/建议动作）；
  `generation` 字段与 `lockfile-mismatch / dependency-cycle / dispose-timeout`
  三码随求解/lockfile 体系删除。
- **PluginError**（mygo-api error.ts）：挂载/权限/运行时接线/配额/能力拒绝 +
  组 7 报告码；零生产者死码（grant-missing / install-denied / ceiling-exceeded /
  source-not-allowed / provenance-rejected / fs-denied / network-denied /
  vars-denied / http-denied / emit-denied）已删除。

## 8. 运行期治理

- **能力面**（`capabilities.ts`）：fs/vars/llm/exec/http/fetch 都由
  `grants` 授权表达式把关，拒绝 → 对应 `*-denied`；配额：cpuBudgetMs
  （服务配置默认 100ms，超限自动禁用）、限流日志 1000 行/分钟、code/registry
  字节上限（config.ts 默认）。
- **事件派发**（`dispatch.ts` + `event-vocabulary.ts`）：`emit | waterfall |
  parallel | serial` 四模式；`@mode` 上限（`mode-ceiling-exceeded`）、分支
  （`undeclared-branch`）与否决（`undeclared-veto`）由词汇表管辖。
- **BOM**（P4）：`dsh.bom/v1` intent+lock 导出/对账；管理器自身作为
  `dsh-mygo` 成员提供 `service:mygo-core`。
- **审计**：`AuditLog` 追加式，容量/保留可配（50MB / 5 文件），面板可读
  `auditSince/auditByPlugin/auditTail`。

## 9. 持久化与外部存储

- `RegistryStore` 契约（store.ts）：`listIds/readGenerations/writeGeneration/
  deleteGeneration/readStatus/writeStatus/deletePlugin/usage/check?`。
- 内置：storage-domain sqlite（unit `plugin_registry_<profile>`，表
  `u_plugin_registry_web_gens/status`）。
- 外部：`extension/mygo-rdb` 经 `mygoRegistryStore` 宿主服务注入（根上下文），
  支持 sqlite/postgres；`check()` 启动自检。
- 迁移：外部 store 提供 `migrated_from_sqlite` 标记，manager init 做一次性
  sqlite→rdb 迁移（面板/扩展约定）。

## 10. 扩展点

| 扩展面 | 契约 | 现有实现 |
|---|---|---|
| loader | `LoaderDeclaration {id, range}`（v1: standard/mixin） | mixin-engine |
| 存储 | `RegistryStore` | sqlite 内置 / mygo-rdb |
| CLI 命令 | `ctx.cmdlineArgs`/`appExit`（L0） | mygo-cli |
| web 面板 | `ctx.httpServer` 路由 + `settings.section` 客户端槽 | dsh-mygo-panel |
| 配置卡片 | 官方 `settings.plugin.item` 槽 + settings 命名空间 | **受限**：settings 网关显式 allowlist（api-proxy.ts:120-127），插件自建命名空间 `settings-not-exposed`；需官方开放 per-plugin 暴露（EXT-3 需求 2） |

## 11. 测试与开发纪律

- 套件：`tests/`（T1-T51，含 e2e 真实语料 + T50/T51 webui spike）、
  `test/eb/`（EB 假设 13 项，独立 vitest config）。
- 计数口径（2026-08-13 P1 后）：全量 62 文件 / 623 用例（含 mygo-rdb 本地
  未提交修正，见 docs/next 备忘录）；EB 套件 11 文件 / 13 用例。
- 离线：全量回归在 `NODE_OPTIONS=--require block-net.cjs` 下（仅放行
  127.0.0.1/localhost）；确定性断言字节级（T19/T22）。
- 故障分类：impl-bug / design-gap / fixture-issue 三分类，验证文档记录。
- vendor 零补丁（PATCHES.md 登记制度随 install.sh 一并退役，2026-08-13；
  host 补丁提案仍走 `patches/`）。
- 冻结文档（expected-behavior / design-r3 / two-tier）只追加修订记录。

## 12. 发布与安装形态

- `scripts/publish-mygo.mjs`：构建 + prepack 自检 + dry-run 门禁；发布面
  mygo-api / mygo / panel（CLI 待纳入）。包均为 `publishConfig.access:
  restricted`。
- 源码态依赖用 `workspace:^`（未发布）；npm rc.1 安装用 `file:/link:` 或
  profile patch 预置 mygo（design-r5 §1.3），官方包由 dsh 启动器 heal 回退。
- 安装形态（next 分支）：install.sh 已退役（2026-08-13）；新安装形态走
  dsh 0812 原生 profile bundle / pnpm 机制，随 P3 落地。开发态验证改为直接
  同步三个包目录到 checkout（packages/core/mygo-api、packages/cordis/mygo、
  packages/cordis/mygo-cli）。

## 13. 常见任务速查

```sh
# 全量测试（无网拦截）
NODE_OPTIONS="--require /tmp/block-net.cjs" npx vitest run packages/core/mygo-api packages/cordis/mygo --maxWorkers=2
# CLI 套件
NODE_OPTIONS="--require /tmp/block-net.cjs" npx vitest run --config packages/cordis/mygo-cli/vitest.config.ts --maxWorkers=2
# EB
NODE_OPTIONS="--require /tmp/block-net.cjs" npx vitest run --config packages/cordis/mygo/test/eb/vitest.config.ts --maxWorkers=2
# typecheck
npx tsc -b packages/core/mygo-api/tsconfig.json packages/cordis/mygo/tsconfig.json packages/cordis/mygo-cli/tsconfig.json
# 同步到 checkout（install.sh 已退役；手动复制三包目录即可）
rsync -a --delete --exclude=node_modules --exclude=lib --exclude='*.tsbuildinfo' \
  packages/cordis/mygo/ <dsh-checkout>/packages/cordis/mygo/
# 打包/还原/初始化
dsh --profile web mygo pack -o out.mygo-pack --json
dsh --profile web mygo restore out.mygo-pack
dsh --profile web mygo init @scope/my-plugin
```
