# Changelog

## Unreleased · next 分支 P3（2026-08-13）— 自包含 workspace + 安装执行面切原生

### 自包含 workspace 化

- 新建根 package.json（private）+ pnpm-workspace.yaml + 仓内
  tsconfig.base.json；`@deepseek-ai/*` 依赖全部改走公开 registry
  （cordis ^4.0.1 / cordis-plugin-loader ^1.0.2 / dsh-* 0.0.1-rc.1 线 /
  dsh-home-paths 0.1.0-rc.x，dsh-paths 更名迁移）；tsconfig 不再引用任何
  checkout 路径（守则例外 #5 收口）。
- 验证回路改为仓内 `pnpm -r run verify:self-contained && pnpm -r run
  typecheck && pnpm -r test && pnpm -r run build`，不再同步 checkout。
- 坑位记录：schemastery 需对齐 @deepseek-ai/schemastery@3.18.1-rc.1
  （dsh-* 行内精确钉版，类型可移植性）；js-yaml/@types/js-yaml 显式声明；
  exports 探针容错（无 main 的包不再假定 lib/index.js）；dsh-tool-cordis
  公开包不再导出 sandbox 助手，real-composition F2(b) 改用裸注册等价验证。

### bundle 化 + 安装执行面

- mygo / mygo-cli 携带 `dsh.bundle.patch` + 包内 cordis.patch.yml（insert
  行按包名引用）；`config.profile` 缺省时从 loader baseUrl 推导 profile 名
  （bundle patch 层无静态 profile 值）。
- 安装执行面：`mygo install/uninstall`（profile 目录 pnpm + dsh.bundle
  对账 dsh.profile.bundles，直接复用 @deepseek-ai/dsh-app-boot profile
  API）与 `mygo enable/disable`（profile cordis.patch.yml 的 id 定向
  disabled 块）。
- GovernanceView 落地（src/governance.ts）：启动时从 profile 实际安装状态
  （dependencies + dsh.profile.bundles + patch 层 disabled 行）重建治理
  视图；RegistryStore 降级为运行时缓存；`pluginManager.governanceView()`
  只读查询面。
- mygo-self.json 写入者补位：服务启动时从本包 package.json 事实写入
  （writeMygoSelfInstallation；install.sh 退役后的承接）。

### 面板迁入

- vendor/dsh-mygo-panel → packages/extensions/mygo-panel，包名
  `@r05en1cu/dsh-mygo-ext-panel`；适配 P1/P2 新 API（plan.actions /
  autoResolve 消费点全部移除，预检改纯求值预览）；桥接包命名
  `@dsh-external/*-mygo` → `@r05en1cu/*-mygo`；安装目录依赖链接改为从
  面板自身解析链推导（不再假设 checkout）；构建自包含（仓内 tsc +
  tsdown，clientBundle 预设最小面移植）。
- publish-mygo.mjs 改仓内构建，发布面纳入 CLI 与面板（只改造不执行）。

## Unreleased · next 分支 P2（2026-08-13）— 契约层重写 + scope 迁移

### 契约层（packages/core/mygo-api）

- types.ts 995 → 343 行：只留契约面（PluginDefinition / PluginHooks /
  PluginEnv / compatibility 只读声明 / 事件词汇 / 管理面句柄）；能力载荷
  形状拆到 env.ts；逐字段 JSDoc 收敛为分组单行注释。
- `definePlugin` 产出可直接 `ctx.plugin()` 消费：挂载面（name/inject/
  Config/apply→adopt）以非枚举属性承载，strict zod 只见 manifest 字段；
  `toCordisPlugin` 语义重复，删除。`fromCordisPlugin` 保留（零侵入桥接
  真实语义，模块头注明不可替代性）。
- 新增 LoaderAdapter 契约（loader.ts：InstallIntent 三态 pnpm/pack/
  display + InstallReceipt/InstallTarget/RegistryEntry），为 P5 loader
  扩展体系铺路。
- 错误闭表维持 P1 裁决 39 码不动。

### scope 迁移与版本线

- 三包改名 `@r05en1cu/dsh-mygo-api` / `@r05en1cu/dsh-mygo` /
  `@r05en1cu/dsh-mygo-cli`（原 `@deepseek-ai/dsh-mygo-api` /
  `@deepseek-ai/dsh-mygo` / `@dsh-external/dsh-mygo-cli`），全部 imports /
  内部依赖 / 脚本 / 配置同步；`author`/`maintainers` 声明 `r05En1cU`。
- 版本线：VERSION 单源 0.0.1-rc.1 → 0.2.0-rc.0，三包同步；init 模板
  生成物 author 默认值 `r05En1cU`。
- checkout 侧（test-r05En1cU-0811）：tsconfig.base.json 增加 @r05en1cu
  paths 映射；node_modules 增加 @r05en1cu 链接（root / 包级 / profile
  fallback）；profile cordis.patch.yml 受管块 dsh-mygo 行改名；vendor
  面板 package.json 依赖名同步 + prepare 暂跳（面板源码仍消费 P1 已删
  的 plan.actions，列为 P3 阻塞项）。

## Unreleased · next 分支 P1（2026-08-13）— 核心瘦身：求解/lockfile 体系退役

> 重做线第一阶段：pnpm 安装状态为唯一真相源，mygo 账本降级为治理视图
> （P3 落地）。旧体系存档见 main `43bb296`。

### 删除

- `dsh.lock/v1` lockfile 全族：`package/lockfile.ts`（readLockfile /
  writeLockfile / verifyLockfile / 形状校验链）及 package-manager / pack /
  service / 测试的全部引用；`paths.lockfileDir` / `lockfilePath` 同步移除。
- 跨插件约束求解残余：`src/activation.ts`（solveActivation：depends 闭包
  连带启用 + breaks 最小停用消解）；`plan.ts` 改为纯求值预览（兼容预检 +
  关系冲突 + requires 级 dependent-exists + displaced 推导），不再产出
  级联动作；`InstallOptions.autoResolve` / `ActivationPlan` /
  `ActivationAction` / `PluginOperationPlan.actions` 一并删除。
- 报告死码与字段：`dispose-timeout`（零生产者）、`lockfile-mismatch`、
  `dependency-cycle`（生产者随 lockfile/求解器删除）、`ResolutionReport.generation`
  （零调用方）；report 侧 `manifest-invalid` 改名 `bundle-invalid` 消歧。
- 加载期校验环节：`verifyAtBoot` / `readLock` / `mountOrder` / `loadEntry`
  （lockfile 依赖）；BOM 的 entry sha512/fileSize 对账字段（lockfile 供给）。
- install.sh、vendor/cordis-alias、vendor/PATCHES.md（安装形态 P3 重做，
  走 dsh 0812 原生 profile bundle / pnpm 机制）。

### 变更

- CD-1 错误词汇统一：`ResolutionReport.code` 直接取自 PluginError 闭表；
  报告侧有用码并入（组 7：`resolve-failed / bundle-invalid / symbol-missing /
  policy-rejected / pack-invalid / pack-hash-mismatch`）；PluginError 删除
  10 个零生产者死码（grant-missing / install-denied / ceiling-exceeded /
  source-not-allowed / provenance-rejected / fs-denied / network-denied /
  vars-denied / http-denied / emit-denied），闭表 43 → 39 码七组。
- `package-store.ts` → `package-restore.ts`：restorePackage 还原到调用方
  指定目录（普通落盘，无「store 唯一真相」语义），事实文件保留供幂等复用。
- `mygo-pack/v1` 保留 GNU tar 确定性打包；清单不再内嵌 lockfile，版本钉死
  在 plugins[]/files[]（id+version）；sha512+fileSize 成员级校验保留
  （pack 自身完整性）；安装无求解、原子可回滚。
- `fine-epoch.ts`：独立细 epoch 指纹函数删除（零生产消费者）；
  FineEpochRegistry/preGate/captureExports 保留（requires 政策闸消费，
  见模块 TODO）。
- 测试计数：全量 62 文件 / 623 用例（-4 文件 / -36 用例：lockfile×2 +
  resolver + activation 套件删除，pack/pins/paths/manifest/兼容性等套件
  按新语义改写）；EB 套件 13/13 不变。

## 0.2.1 · 2026-08-10 — 0810 分支适配 + 客户端兼容 + 测试类型债清理

### 0810 分支支持

- 支持 dsh `snapshots/20260810T155924Z-8ec407cd64`：storage-domain /
  storage-sqlite / cordis fiber / settings.register 接口兼容确认，hmr /
  include 只是写文件容错增强；构建、启动、安装、BOM、配置 HMR 在 0810
  实测通过；
- 清理 43 个测试类型错误（0.2.0 之后从未通过 checkout 全量 host tsc，
  0809 同样存在）：`requires/provides/permissions` 改 readonly、
  `resolveSource` 可选（缺省 fail-loud）、vocabulary 字段可选、
  `InMemoryRegistryStore.check` 补上、host-event 测试适配 0810 更严格的
  `ctx.emit` 泛型；
- **3080 已切换 0810**（`source/current` → 0810 检出），rdb 注册表/PG、
  bundle rail、BOM、面板全部在 0810 下验证。

### 客户端（浏览器 half）兼容

- 面板安装链路读 `dsh.client`（0810）并回退旧 `dshClient`（0809）；桥接包
  双写两个字段，存量桥接启动时自动补 `dsh.client`；
- 桥接 client gate 的 rawId 按 bundle 真实注册 id 提取（0810 为绝对路径，
  0809 为包名，回退包名）；
- 官方 bundle 安装自动注入顶层 `dshClient`（0809 roster 需要，0810 忽略，
  无害），带 `dsh.mygo.legacyClientInjected` 标记、卸载还原；
- 面板自身 client half 也补齐 `dsh.client`（否则 0810 设置页看不到
  “My 插件”）。

### 其他

- UI：设置页“受管插件”改名为 **“My 插件”**；
- 已知边界（实测确认，宿主设计）：运行时新增带 client half 的包（桥接或
  官方 bundle）需**重启**才进 roster；无 `dsh.client` 语义的旧插件暂不
  支持（0809 时代插件请作者升级，3080 已移除这类插件）。

## 0.2.0 · 2026-08-10 — 重构：HMR 语义、依赖体系、持久化、BOM

> 0.2.0 在 0.1.1 的基础上几乎重构了一切：HMR 从自建七步的 stage-first
> 改为对齐宿主 `fiber.update` 的 dispose-first（unload → load），取消了两轮
> 逐面特判补丁；把"权限核心删除后"的兼容性检查与插件间依赖从设计落成实现
> （Fabric 五级词汇、激活求解器、bundle 轨）；持久化后端无关化
> （mygo-rdb / store-provider / session 读取器）；安装器/面板大幅补全；
> 并新增 P4 BOM 依赖参考物。

### 核心：HMR 重写

- replace / adoptStatic 改为 **dispose-first**（先完整释放旧代，再应用新代），
  对齐 Cordis `fiber.update` 语义；settings namespace、webserver
  upgrade/fallback 这类全局 seat 注册不再需要 deferred 特判；
- 删除整套 deferred host-registration 机制（`StagedHostRegistration` /
  `registerHostRegistration` / `commitHostRegistrations` /
  `DEFERRED_HOST_REGISTRATION_METHODS`）；
- 失败回滚 `restoreIncumbent`（重新挂载旧代），配置预检前移，release 等待
  in-flight 事件结束后才放行；
- `adoptStatic` config-diff：同版本配置变化走热替换；面板配置保存写回桥接行，
  重启后配置不再回退；
- **行为变化**：replace 变成 unload → load；`immediate` 策略在存在 in-flight
  事件时会阻塞配置保存（无超时），`drain` 保持 30s 超时（超时在 unload 前，
  旧代安全）。

### 兼容性 / 插件依赖（0.2.0 方向 P1–P3）

- Fabric 五级依赖词汇 `depends / recommends / suggests / conflicts / breaks`
  + 传递闭包 + 约束链报告（P1 v2）；
- 激活求解器 `solveActivation`：required-by 连带启用、capability provider
  确定性选择、breaks 最小变更消解、plan 确认 UI（P2）；
- bundle 轨 `BundleRail`：profile manifest 原子读写、`dsh plugin` CLI 转发、
  companion 块、跨轨统一依赖图（P3）；
- 声明式 manifest v1：package.json `dsh.mygo` 段（entrypoints +
  compatibility）、`ctx.entrypoints` 聚合服务（按代撤回）、零依赖 semver
  匹配器（支持 `1.x` / `1.2.x` 通配）。

### 持久化

- **mygo-rdb** extension（基于 mygo 本体）：rdb（sqlite/postgres）注册表
  store + store-provider 组合行接管 + sqlite→rdb 自动迁移 + audit 迁入；
- session 读取器三层格式：jsonl（zstd 多帧）/ sqlite / rdb-postgres，
  字段投影 `extractFields`；
- 卸载自动接管（tombstone 落 rdb）、卸载 extension 自动回退内置 sqlite。

### 安装器 / 面板

- 官方 `.dsh-plugin` 仓库格式支持（入口定位 + 依赖安装 + 构建）；
- 配置模板与可读化校验（schemastery schema 描述 + 自动模板，解决
  "缺 config 死循环"）；
- 安装链路修复：`link:`/`workspace:` 剥离、pnpm 兜底、ESM 缓存绕过
  （`?mygo=<ts>`）、per-id 串行化；
- 卸载 tombstone 持久化、停用/卸载二次确认（卡片内展开）、host 副作用
  热撤销（WebUI 实时更新）；
- 配置助手：正经临时对话（continuable child session）、helper-only skill /
  工具面、排队 + 5min 超时自愈；
- 外部应用模式：独立 `mygo-apps` 根、进程组启停、`syncUninstall:false`、
  操作审计。

### facade 兼容面（生态实测驱动）

- 宿主事件桥：词汇外事件挂宿主 `on`/`once`、`prepend` 生效，随代撤销；
- HTTP 桥重写：`res.pipe`、`flushHeaders`、SSE 流式转发、req 异步迭代；
- 工具字段透传（`timeoutMs` / `isConcurrencySafe` / `finalizeContent`）、
  skills/commands 发布视图保留插件声明。

### P4 BOM（依赖参考物）

- `dsh.bom/v1` 导出：intent（版本区间）+ lock（精确版本/commit）双段，
  self/bridge/bundle/app 全轨，mygo 自身作为一等成员；
- 只读 `bom check`：missing / extra / drift / 约束违例链，零修改；
  `--target` 校验新插件声明是否落在生态带内；
- 极薄壳脚手架 `scripts/bom-scaffold.mjs`：离线生成新插件三文件骨架，
  `depends service:mygo-core` 自动取 BOM self 带；
- 版本事实动态化：`VERSION` 单源 + `mygo-self.json#version`，
  `MYGO_MANAGER_VERSION` 不再硬编码。

### 其他

- 远程更新/自更新（插件走 `updateRaw` HMR；mygo 自身 clone → 替换 → Loader
  热重载 → recover）；
- 显式不支持清单：旧工作区插件、依赖渲染器能力补丁的插件、apply 内
  `ctx.plugin` 组合子插件（dsh-rewind 等），给出明确错误而非拖崩后端；
- 开发备忘录与文档重写（旧受管权限 API 文档删除，README/memo/handoff 重写）。

### 升级注意（破坏性 / 行为变化）

- **HMR 语义**：replace 改为 unload → load；`immediate` 策略在 in-flight
  事件存在时会阻塞配置保存（无超时，建议升级前确认插件无长驻事件监听）；
- 每次重启后**第一次**配置保存会有一轮 Loader 重放收敛（旧版本遗留的
  `source:{type:'static'}` 注册表行被 quarantine，无害自愈）；
- mygo 版本事实来自 `mygo-self.json#version`：升级后需重跑 `install.sh`
  （或手动补 version 字段），否则依赖图/BOM 的 self 版本停留在回退值；
- 运行实例的 rdb 注册表依赖 PostgreSQL（mygo-pg / Docker Desktop），
  PG 不可用会 fail-loud（`registry backend self-check failed`）；
- 面板安装的静态插件配置现在写回桥接行；旧版本遗留的 static-source gens
  行会在恢复时 quarantine。

## 0.1.1 · 2026-08-09

- install.sh 修复：空 profile 占位覆盖、`set -e` 兜底、模块回退链接。

## 0.1.0 · 2026-08-09

- HMR 插件管理器：generation / swap / staging / dispatch，安装 / 启停 /
  卸载 / 替换 / 恢复；
- 外部应用模式、远程更新、首次安装脚本 install.sh。
