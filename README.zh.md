# dsh-mygo

[English](README.md) | 中文

DeepSeek 受管插件包源码之家：无 Cordis 依赖的插件契约，以及在 DSH 宿主中挂载、校验、排序、派发、持久化与恢复插件的受管插件桥。

## 包

| 包 | 路径 | 职责 |
|---|---|---|
| `@deepseek-ai/dsh-mygo-api` | `packages/core/mygo-api/` | 无 Cordis 依赖的上层插件契约：`definePlugin`、manifest/环境类型、`PluginError` 词表与 fake-env 测试面。插件作者只 import 本包。 |
| `@deepseek-ai/dsh-mygo` | `packages/cordis/mygo/` | 受管插件桥：mount 期校验（§16 组 1/2）、纯函数排序/冲突/plan 推导、容器化 dispatch、生命周期引擎、PluginEnv 能力边界与 sqlite 持久化 + boot 恢复。 |

每个包都带双语 README、源码与测试套件（`packages/cordis/mygo/tests/fixtures/` 下的 `dsh-external` fixtures 是生态兼容性矩阵使用的第三方插件源码，逐字保留并附出处）。

## 文档

- [插件作者指南](docs/plugin-author-guide.md) —— 面向首次接触的插件作者。
- [API 参考](docs/mygo-api-reference.md) —— 由 `@deepseek-ai/dsh-mygo-api/src` 的 JSDoc 生成；重新生成请用 DSH monorepo 的生成器。
- [生态兼容性矩阵](docs/plugin-ecosystem-compat.md) —— 现有 dsh-external Cordis 插件如何经 `fromCordisPlugin` 迁移。
- [为什么不能 0day](docs/why-not-zero-day.md) —— 区分裸 Cordis 插件与受管插件的四层契约差异。
- [插件目录](docs/plugin-catalog.md) 与[原生能力总表](docs/plugin-native-capability-catalog.md) —— 受管能力词表与阶段一透传总规则。

## 仓库范围

本仓库刻意只收纳两个插件包、文档与测试，不包含挂载它们的 DSH monorepo。两包把 `@deepseek-ai/dsh-*` 支撑依赖（invariants、session、paths、storage、storage-domain 等）声明为外部包：构建或运行测试前，请从 DSH monorepo 或已发布版本解析它们。
部分文档交叉链接（Agent Note、harness 包 README）指向 DSH monorepo，可能无法从这份独立快照解析；权威完整上下文在 monorepo 中。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 r05En1cU。
