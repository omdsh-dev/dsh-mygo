# dsh-mygo

> DSH 的受管插件层：**轻量核心 + 一切皆扩展**。
> 名字致敬《BanG Dream! It's MyGO!!!!!》——插件们各怀心思，但总有一个地方
> 会把它们聚在一起。

**版本：0.2.0-rc.2（next 线）** · 包名统一 `@r05en1cu/dsh-*` · author `r05En1cU` ·
发布 tag `next`

## 这是什么

mygo 把 DSH 插件从「裸 Cordis 行」升级为「受管对象」：安装/启停/替换/恢复
语义、符号级校验、结构化失败报告、运行期政策闸。核心不做产品功能——CLI、
web 面板、loader、存储都是扩展。

## 核心功能

### 整合包（mygo-pack/v1）—— 主推

把一组插件打成一个**确定性、可审计、可离线还原**的整合包：

- GNU tar 确定性打包（`--sort=name --mtime=@0`），成员级 sha512 + fileSize
  校验，256MiB / 10000 成员上限
- **成员二态**（P8）：默认全内嵌；`mygo pack --ref <id>`（可多次）或
  `--ref=all` 把成员标记为 **npm 引用式**——包体不进 pack，打包时从
  registry 元数据固化 `spec`（钉死 name@version）+ `integrity` +
  `tarball` URL（可审计、防漂移）；restore 时在线拉取、integrity 硬校验，
  离线环境点名缺失成员并整体拒绝。内嵌与引用可混合共存；无 `references`
  键的旧 pack 照常还原
- **离线原子还原**：内嵌成员不触网，失败回滚不留半成品
- **restore 自动注册**（P8）：还原进 store 后自动注册进目标 profile
  （等价 `dsh plugin add`——dependencies 落账 + `dsh.bundle` 对账进
  bundles 层；无 bundle 声明的包仅进 dependencies 并提示）；幂等，
  与手工 `dsh plugin add` 混装不撞行；`--no-register` 保持纯还原语义
- 依赖与兼容性检查：安装前置校验（符号级、版本兼容域、hub risk/listing
  分级提示）——建议式报告，不做隐式求解
- 跨实例搬运：`mygo clone --from <homeA> --to <homeB> <plugin>` 经内容寻址
  共享缓存（`~/.dsh-mygo/cache/packs/`，hardlink 优先）迁移，多实例不重复
  下载

### 多实例接管

以 `$DSH_HOME` 为实例边界：`mygo instances` 列出全部实例、`mygo adopt` 接管
既有实例；每个实例的治理数据自包含于 `$DSH_HOME/mygo/`，跨 HOME 写入被硬
闸拒绝——多版本 dsh 并存互不污染。

### loader 扩展体系

- **默认 loader**（`dsh-mygo-loader-profile`）：dsh 原生 profile bundle /
  pnpm 机制，npm 包名 / git spec / tarball / 本地目录四种 spec；git 安装的
  allowBuilds 双门槛一键放行
- **hub loader**（`dsh-mygo-loader-hub`）：dsh-hub 社区市场——`mygo hub
  search / info / install / collections`，registry 快照验签（Ed25519 +
  sha256 snapshotId），集合原子安装（失败整组回滚）

### 治理与生命周期

- 治理视图：pnpm 安装状态为唯一真相源，每次操作后与 profile 实际状态对账
- 启停 = profile patch 层受管块（幂等写/移除）；`mygo config` 读取-修改-
  写回整行配置，免去手工重述
- 七步替换协议 + dispose 超时放弃 + 失败回滚；热重载跨重启状态保持
  （capture/restore）
- 启动预检：entry 名解析失败在治理面响亮报错，不等挂载后静默

## 安装

需要 dsh 0.1.0-rc.x（npm 公开版，`npm i -g @deepseek-ai/dsh`）。

```sh
# 核心（必装）：治理服务 + bundle 层
dsh plugin --profile web add @r05en1cu/dsh-mygo@next

# 命令面（推荐）：mygo install/pack/hub/instances 等
dsh plugin --profile web add @r05en1cu/dsh-mygo-cli@next

# 可选扩展：web 设置页面板
dsh plugin --profile web add @r05en1cu/dsh-mygo-ext-panel@next

dsh web   # profile 组合自动挂载
```

> 注意：web profile 的严格参数解析会挡住 `dsh --profile web mygo ...` 的
> 内层参数（宿主缝隙，host 补丁提案候选）；CLI 命令面在 headless profile
> 下完整可用。

## 命令面速查

```sh
mygo install <spec> | uninstall <name> | enable|disable <id>
mygo pack [-o out.mygo-pack] [--ref <id>|--ref=all] | restore <pack> [--no-register] | init <name>
mygo instances | adopt --home <path> | clone --from <A> --to <B> <plugin>
mygo hub search|info|install|collections
mygo config <id> [--set '<json>']
```

（经 dsh 调用为 `dsh --profile <p> mygo <cmd>`；以上省略前缀。）

## 扩展生态

| 包 | 作用 |
|---|---|
| `@r05en1cu/dsh-mygo-api` | 契约层（Cordis-free）：`definePlugin`、`PluginHooks`、`PluginError` 39 码、`LoaderAdapter` 契约——插件作者 SHOULD 只依赖它 |
| `@r05en1cu/dsh-mygo-cli` | 命令面（本身是受管插件） |
| `@r05en1cu/dsh-mygo-ext-panel` | web 设置页面板（`settings.section` 槽 + `/api/mygo/*`） |
| `@r05en1cu/dsh-mygo-loader-profile` | 默认 loader（dsh 原生 profile 体系） |
| `@r05en1cu/dsh-mygo-loader-hub` | dsh-hub 市场 loader |
| `@r05en1cu/dsh-mygo-ext-fabric` | fabric（mixin/加载时变换）治理壳 |

## 开发

仓内自包含回路（pnpm workspace + 公开 registry 依赖）：

```sh
pnpm install
pnpm -r run verify:self-contained && pnpm -r run typecheck && pnpm -r run build
# vitest 串行分包（禁止并行多包）：
pnpm --filter @r05en1cu/dsh-mygo exec vitest run --maxWorkers=2 --pool=threads
```

测试口径：79 文件 / 716 用例 + EB 13/13（无网拦截、确定性断言字节级）。

## 仓库布局

```text
packages/core/mygo-api/          契约层（Cordis-free）
packages/cordis/mygo/            核心治理服务
packages/cordis/mygo-cli/        CLI 扩展插件
packages/loaders/                loader：profile（默认）+ hub（dsh-hub 市场）
packages/extensions/             扩展：mygo-panel（面板）、mygo-fabric（mixin 治理壳）
extension/mygo-rdb/              外部注册表存储扩展（本地演进线，不发布）
patches/                         DSH host 补丁提案（不 apply）
scripts/publish-mygo.mjs         发布流水线（--dry-run 门禁）
docs/                            设计/验证文档（DEV-GUIDE.md 为开发者入口）
```

## License

MIT
