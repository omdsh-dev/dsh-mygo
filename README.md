# dsh-mygo

English | [中文](README.zh.md)

The source home of the DeepSeek managed-plugin packages: the Cordis-free
plugin contract and the managed-plugin bridge that mounts, validates, orders,
dispatches, persists, and recovers plugins in the DSH harness.

## Packages

| Package | Path | Role |
|---|---|---|
| `@deepseek-ai/dsh-mygo-api` | `packages/core/mygo-api/` | Cordis-free upper-level plugin contract: `definePlugin`, manifest/environment types, the `PluginError` vocabulary, and a fake-env test surface. Plugin authors import only this package. |
| `@deepseek-ai/dsh-mygo` | `packages/cordis/mygo/` | The managed-plugin bridge: mount-time validation (§16 group 1/2), pure ordering/conflict/plan derivations, containerized dispatch, the lifecycle engine, PluginEnv capability boundaries, and sqlite persistence + boot recovery. |

Each package carries its own bilingual README, source, and test suite (the
`dsh-external` fixtures under `packages/cordis/mygo/tests/fixtures/` are the
third-party plugin sources of the ecosystem compatibility matrix, preserved
verbatim with provenance).

## Documentation

- [Plugin author guide](docs/plugin-author-guide.md) — first-time plugin authors.
- [API reference](docs/mygo-api-reference.md) — generated from the JSDoc in
  `@deepseek-ai/dsh-mygo-api/src`; regenerate with the DSH monorepo generator.
- [Ecosystem compatibility matrix](docs/plugin-ecosystem-compat.md) — how
  existing dsh-external Cordis plugins migrate through `fromCordisPlugin`.
- [Why not zero-day](docs/why-not-zero-day.md) — the four contract layers that
  separate raw Cordis plugins from managed plugins.
- [Plugin catalog](docs/plugin-catalog.md) and the
  [native capability catalog](docs/plugin-native-capability-catalog.md) — the
  managed capability vocabulary and the stage-one pass-through rules.

## Repository scope

This repository intentionally contains only the two plugin packages, their
docs, and their tests — not the DSH monorepo that mounts them. The packages
declare their `@deepseek-ai/dsh-*` support dependencies (invariants, session,
paths, storage, storage-domain, and friends) as external packages: resolve
them from the DSH monorepo or from their published releases before building
or running the test suites. Some doc cross-links (Agent Notes, harness package
READMEs) point into the DSH monorepo and may not resolve from this standalone
snapshot; the authoritative full context lives in the monorepo.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 r05En1cU.
