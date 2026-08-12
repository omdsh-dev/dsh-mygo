# DEV-GUIDE：mygo 开发者指南

> 面向要在 mygo 上开发插件、改 mygo 核心或接入生态接口的开发者。
> 本文拆解 mygo 在 Cordis 之上补充的全部逻辑：依赖管理、停用/启用、细 epoch、
> 打包分发、报告、运行期治理、持久化与扩展点。事实以本仓库当前 HEAD 为准；
> 冻结基线见 `expected-behavior.md`（FROZEN，只追加修订）。

## 0. 一句话模型

Cordis 给你 fiber/effect/事件/服务注入/loader 组合；**mygo 在这之上补充了
「受管插件生命周期 + 包治理」**：插件不再简单经过 load/registry 路径自己 import 加载，
而是经过manifest → 求解 → 锁定 → 安装 → 挂载 → 运行 → 替换/停用/卸载 的受管管线，
每一步都有确定性与可审计账目。

## 1. 架构分层

```text
外部工具/插件作者
   │  SHOULD 只依赖
   ▼
@deepseek-ai/dsh-mygo-api（契约层，Cordis-free）
   │  fromCordisPlugin / toCordisPlugin / PluginError / definePlugin
   ▼
@deepseek-ai/dsh-mygo（实现层，Cordis 桥接）
   ├── package/*       包治理：manifest/求解/lockfile/store/扫描/打包
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
| `package/manifest-v2.ts` | manifest v3 解析/校验（B1） | `parsePackageManifest`、`constraintsOf`、`PluginManifestV3` |
| `package/resolver.ts` | 确定性全序求解（B5） | `resolve`、`sortCandidates`、`findDependsCycle` |
| `package/lockfile.ts` | `dsh.lock/v1` 读写/校验（B9） | `readLockfile`、`writeLockfile`、`verifyLockfile` |
| `package/package-store.ts` | 不可变 store 安装（B10 路径安全） | `installPackageToStore`、`readInstalledPackage` |
| `package/package-manager.ts` | 安装编排（registry→求解→store→lock） | `resolveInstall`、`verifyAtBoot`、`buildPack`、`installPack` |
| `package/pack.ts` | `mygo-pack/v1` 打包/还原（B20-B24） | `buildPluginPack`、`installPluginPack` |
| `package/fine-epoch.ts` | 细 epoch 元组与前置门（B13） | `FineEpochRegistry`、`preGate`、`captureExports` |
| `package/requires-gate.ts` | requires 政策闸（B6） | `evaluateRequiresGate`、`requiresGateReport` |
| `package/provider-observations.ts` | 服务提供者观测记录（B19） | `ProviderObservationRegistry` |
| `package/report.ts` | 结构化报告 schema（B7） | `ResolutionReport`、`ServiceResolutionReport` |
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
| `lifecycle.ts` | 引擎：七步替换/恢复/政策闸/提供表/epoch 记账 | `LifecycleEngine`、`wrapProvidedValue` |
| `dispatch.ts` | 事件派发机（模式/分支/否决） | `DispatchMachine` |
| `service.ts` | Cordis 服务面（ctx.pluginManager） | `PluginManagerService` |
| `bom.ts` | `dsh.bom/v1` 导出/对账（P4） | `buildBom`、`checkBom` |
| `capabilities.ts` | 能力面与配额（fs/vars/llm/exec/http/fetch） | `createPluginFs` 等 |
| `session-reader.ts` | jsonl/rdb/sqlite 会话读取 | `JsonlSessionReader` 等 |
| `sqlite-store.ts` / `persistence.ts` / `store.ts` | 注册表持久化与 `RegistryStore` 契约 | `SqliteRegistryStore`、`RegistryStore` |
| `audit.ts` / `snapshots.ts` | 审计日志 / 世代快照 | `AuditLog`、`SnapshotStore` |
| `plan.ts` / `activation.ts` / `order.ts` | 操作计划/激活求解/顺序推导 | `planOperation`、`solveActivation` |
| `event-vocabulary.ts` | 托管事件词汇（模式/分支） | `EVENT_VOCABULARY` |
| `config.ts` | 管理器配置默认值 | `resolvePluginManagerConfig` |

## 2. 插件契约（manifest v3）

插件作者只需在 `package.json` 写 `dsh.mygo` 块（或 legacy
`dsh.mygo.compatibility`），并 import `@deepseek-ai/dsh-mygo-api`：

```jsonc
"dsh": { "mygo": {
  "formatVersion": 1,
  "id": "my-plugin", "version": "0.0.1", "entry": "lib/index.js",
  "depends": { "other-plugin": "^1.0.0" },   // 插件图（安装期硬约束）
  "breaks":  { "legacy": "<2.0.0" },          // 冲突声明（安装期硬约束）
  "requires": { "voice-chat": "^1.0.0" },     // 服务级（运行期政策闸，INACTIVE）
  "core": "^0.0.1-rc.1", "loader": { "id": "standard", "range": "^1.0.0" },
  "provides": ["my-capability"], "grants": { "fs": "..." }
}}
```

运行期 `PluginEnv`（mygo-api `PluginEnv`，types.ts:247）给插件：`on/onHost/emit`、
`effect/hostEffect`、`provide/get`（服务隔离，未声明返回 undefined）、
`fs/vars/llm/exec/http/skills/commands/fetch`、`scope(agentId)`、
受权管理面（`plugins/install/uninstall/updateConfig`）。生命周期钩子
`PluginHooks`：`setup → activate → deactivate/captureState/restoreState/dispose`。

### 2.1 manifest 字段参考（作者向，来自 `package/manifest-v2.ts`）

| 字段 | 语义 | 示例 |
|---|---|---|
| `recommends` | 可选推荐依赖：只校验不选择、只警告不阻断、永不自动安装（design-r3 §2.6） | `"recommends": { "ui-helper": "^1.0.0" }` |
| `bundles` | 内嵌包声明（id + version + 包内路径），参与跨插件去重 | `"bundles": [{ "id": "dep-x", "version": "1.2.0", "path": "vendor/dep-x" }]` |
| `patches` | mixin loader 的 patch 目标声明（module/filePath/symbol/operation） | `"patches": [{ "id": "p1", "target": { "module": "host", "symbol": "run", "operation": "around" }, "file": "patch.js" }]` |
| `symbolAliases` | 符号别名/兼容映射（`b: alias of c`，EB-D19）：改名可经别名解析，未声明别名按破坏性变更走删除路径 | `"symbolAliases": { "oldName": "newName" }` |
| `environment` | 只读环境元数据（如 `{platform:"web"}`）：不设硬门、仅报告展示（design-r3 §2.5） | `"environment": { "platform": "cli" }` |
| `grants` | 能力授权表达式（fs/network/vars/llm/exec/http 等）；默认拒绝 | `"grants": { "fs": "..." }` |
| `provides` / `loader` / `shared` / `entrypoints` | 服务能力声明 / loader 契约（v1: standard/mixin）/ 显式共享状态标记 / 入口贡献表 | — |

## 3. 依赖管理（mygo 在 Cordis 之上补充的核心之一）

Cordis 的组合是「行 + patch 层」；mygo 把行替换成「依赖图 + 求解 + 锁 + 校验」。

### 3.1 求解器（`package/resolver.ts`）

输入：`requests`（id → 可选区间）、`pins`（id → 精确版本，如 pack/lockfile 快照）、
`installed`（当前锁定集）、`candidates`（来源：registry/pack/bundle/locked）、
`coreVersion`。

输出：全序确定解（`ResolveOutcome`）或全量冲突报告。候选排序为确定性全序
（`sortCandidates`）：

```text
root 优先 → id 升序 → 版本降序 → 嵌套浅优先 → parent 升序
→ 来源序（pinned > registry > locked > bundle > 其他）→ manifest sha256 字典序
```

> 实现事实：pack 安装的精确版本经 `pins`（rank 0）生效；pack 候选本身的来源序
> 归入「其他」。与 design-r4 §5 的表述（pack 插在 pinned 之后）有出入，以实现为准。

约束求值顺序：`depends`（字典序）→ `breaks` → `core` → `entry`；`requires` 不进
依赖图（仅运行期政策闸）。环检测为确定性 DFS（`findDependsCycle`）。

### 3.2 lockfile（`package/lockfile.ts`）

`$DSH_HOME/mygo/lockfiles/<profile>.dsh.lock.json`：

```jsonc
{ "format": "dsh.lock/v1", "generated": { "by": "dsh-mygo", "version": "...",
  "profile": "web", "core": "...", "at": "..." },
  "plugins": { "<id>": { "version", "entry", "core", "depends", "breaks",
    "requires", "symbolAliases",           // 修复批次 3（A3）：重启还原闸输入
    "entrySha256", "manifestSha256",
    "entrySha512",                         // 修复批次 3（DG-2）：入口文件哈希（必填）
    "tarballSha512",                       // 修复批次 3（DG-2）：vendored tarball 哈希（可选）
    "entryFileSize", "integrity", "source", "packageName", "provides",
    "bundles", "symbols" } } }
```

- 修复批次 3 起 schema 显式演进：`requires` / `symbolAliases` / `entrySha512`
  为必填字段；旧 schema lockfile 读入 → `lockfile-mismatch` + 重新
  restore/重装指引（MUST NOT 静默补默认值，A12）。
- `verifyAtBoot`：先做形状校验（带字段指针），再只对照 lockfile 校验磁盘
  （版本 + 哈希），**不重新求解**。
- BOM 对账（P4）：entry 文件 sha512（真入口哈希）+ 字节数进入 lockfile，
  `bomCheck` 报告 missing/extra/drift/约束违例链。

### 3.3 不可变 store（`package/package-store.ts`）

`$DSH_HOME/mygo/packages/<id>/<version>/`，安装原子化（staging → rename），
事实文件 `.mygo-package.json`（`dsh.mygo-package/v1`，含 manifest 快照与哈希）。
路径安全（B10）：entry/bundles/patches 禁逃逸，安装期 + 加载期双保险。

### 3.4 扫描与收割

- `bundle-scan`：整包扫描内嵌 `dsh.bundle` 声明 + npm 元数据分类（KF-1 裁决：
  dependencies/peerDependencies/optionalDependencies + 自身包名归一，未声明
  specifier 硬错）。
- `harvester`：`engines.dsh` / `cordis` peer / `@deepseek-ai/dsh-tools` peer →
  core 区间归一；无法映射 → 告警（EXT-1 锚定）。
- `dual-presence`：同一包既是插件又被 npm 嵌套依赖 → 告警不阻断。
- `symbol-verify`：静态收集导入投影，对照目标包运行时 exports；缺失硬阻断、
  不可解析告警放行（B13）。

### 3.5 版本谓词

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
→ GC 孤儿代；恢复顺序用 `mountOrder`（依赖先，lockfile 拓扑序，环 → 启动失败报告）。

## 5. 细 epoch 与反应式 reload

### 5.1 epoch 元组（EB-D10）

`(provider-uid 元组, 版本元组, 符号投影元组, 政策事实元组)`，挂载时在缓存导出
快照上纯内存比较（EB-D20：微秒~亚毫秒预算，reload 路径禁磁盘 I/O）。
原生粗 epoch（uid 拼接串）是其投影：细变粗必变，粗变细不必。

### 5.2 notify 双源与前置门

每次 provide/unprovide 即时 + ACTIVE 状态翻转都触发一次 epoch 重算（一个批次）；
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

清单：`format/formatVersion/name/version/generated/plugins/lockfile/
files（sha512+fileSize+integrity）/communityDeps/manifestSha256`。
`manifestSha256` 对规范键序语义 JSON 计算；`generated.at` 归一 `<t>`。

### 6.2 确定性打包（B21）

`buildPluginPack`：从 store 重打包（`tar --sort=name --mtime=@0 --owner=0
--group=0 --numeric-owner` + `gzip -n` 语义的 Node zlib），排除
`.mygo-package.json`，transform `./` → `package/`；工具能力探测（不支持
`--sort=name` 报错）。

### 6.3 离线还原（B22/B23）

`installPluginPack`：清单自校验 → 自实现 tar 头部预检（精确成员集白名单，
防换行文件名绕过）→ vendored sha512+fileSize 校验 → 内层 tarball 预检 →
既有 `resolve()`（pins source 'pack'）→ store 安装 → lockfile 写入。全程离线
（RT5：fetch 计数 0）；一坏多好 → 整体拒绝、零写盘（T42）。

### 6.4 CLI（扩展插件，`packages/cordis/mygo-cli`）

`dsh --profile <p> mygo pack|restore|init`（L0：`ctx.cmdlineArgs`/`appExit`，
手写最小解析器；`--json` 直通结构化报告；退出码 0/1/2）。`init` 以
plugin-template@2da8230 资产生成骨架，写盘前过 B1 + `checkTemplateAlignment`
双校验（含 7 skills + lockfile，`verify:self-contained` 硬性要求）。

## 7. 报告与错误

两套词汇并存（CD-1 待裁决）：

- **结构化报告**（`package/report.ts`）：`ResolutionReport.code` ∈
  `resolve-failed | dependency-cycle | lockfile-mismatch | manifest-invalid |
  symbol-missing | policy-rejected | dispose-timeout | pack-invalid |
  pack-hash-mismatch`，含 `scope`（package/service/pack）、`generation.from→to`、
  `cycles`、`conflicts`（约束/链路/候选集/建议动作）。
- **PluginError**（mygo-api error.ts，43 码 5 组）：挂载/权限/运行时接线/配额/
  能力拒绝（`fs-denied` 等 7 码）。

建议倾向（未裁决）：挂载期/治理期失败走报告；运行时能力拒绝走 PluginError。

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
- 计数口径：全量 64 文件 / 624 用例（含 mygo-rdb 本地未提交修正；提交态 621，
  见 docs/next 备忘录）。
- 离线：全量回归在 `NODE_OPTIONS=--require block-net.cjs` 下（仅放行
  127.0.0.1/localhost）；确定性断言字节级（T19/T22）。
- 故障分类：impl-bug / design-gap / fixture-issue 三分类，验证文档记录。
- vendor 修改必须登记 `vendor/PATCHES.md`（当前零补丁：PATCHES #1 Fiber
  `get epoch()` 已于 2026-08-12 移除并回滚三文件，vendor 零残留；此后 vendor
  修改仍须先登记再动工，host 补丁提案走 `patches/` 两轨分开）。
- 冻结文档（expected-behavior / design-r3 / two-tier）只追加修订记录。

## 12. 发布与安装形态

- `scripts/publish-mygo.mjs`：构建 + prepack 自检 + dry-run 门禁；发布面
  mygo-api / mygo / panel（CLI 待纳入）。包均为 `publishConfig.access:
  restricted`。
- 源码态依赖用 `workspace:^`（未发布）；npm rc.1 安装用 `file:/link:` 或
  profile patch 预置 mygo（design-r5 §1.3），官方包由 dsh 启动器 heal 回退。
- `install.sh`：复制 mygo/mygo-api/mygo-cli/panel → 接线 tsconfig →
  构建（`DSH_SKIP_PNPM=1` 可跳过全仓 pnpm）→ 回退链接（profile + 包级 +
  checkout 根）→ `mygo-self.json`（`VERSION`，当前 0.0.1-rc.1）。

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
# 安装到 checkout
DSH_CHECKOUT=<dsh-checkout> DSH_SKIP_PNPM=1 ./install.sh
# 打包/还原/初始化
dsh --profile web mygo pack -o out.mygo-pack --json
dsh --profile web mygo restore out.mygo-pack
dsh --profile web mygo init @scope/my-plugin
```
