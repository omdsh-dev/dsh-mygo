# vendored 修改登记（PATCHES.md）

> 规则：凡对 vendored cordis / loader 的本地修改 MUST 在此逐条登记
> （文件、改动、原因、上游同步注意事项）。登记后修改方可生效。

| # | 文件 | 改动 | 原因 | 上游同步注意事项 | 状态 |
|---|---|---|---|---|---|
| 1 | `cordis/src/fiber.ts` + `cordis/lib/index.js` | Fiber 增加公开 `get epoch()`（读取 `_runner.epoch`） | A9 实验确认 lib 产物中 epoch 仅存于私有 `_runner`，mygo 控制面内省需要公开只读入口 | 上游若在 Fiber 暴露公开 epoch 字段/getter，删除本补丁并以官方实现为准 | 已移除（2026-08-12，守则合规 + 零侵入裁决）：fiber.ts / lib/index.js / fiber.d.ts 三处改动已回滚；细 epoch 由 mygo 自有记账（FineEpochRegistry）维持，原生 epoch 仅诊断用（无公开入口） |
