/**
 * B7 结构化报告 → 终端/JSON 的确定性渲染（design-r5 §3）。
 * 所有 human 输出为固定字节序列（快照断言基础）；--json 时 stdout 只含唯一 JSON 文档。
 * @module @dsh-external/dsh-mygo-cli/render
 */

import type { ResolutionReport, ServiceConflictEntry, ServiceResolutionReport } from '@deepseek-ai/dsh-mygo'

const PACK_CODES = new Set(['pack-invalid', 'pack-hash-mismatch'])

type AnyConflict = ServiceConflictEntry | {
  readonly plugin: string
  readonly constraint: ResolutionReport['conflicts'][number]['constraint']
  readonly chain: readonly string[]
  readonly candidates: readonly {
    readonly version: string
    readonly rejected: readonly string[]
  }[]
  readonly actions: readonly string[]
}

/** 渲染一份结构化失败报告为人类可读文本。 */
export function renderReportHuman(report: ResolutionReport | ServiceResolutionReport): string {
  const lines: string[] = []
  lines.push(`✗ ${report.code}：${report.summary}`)
  if (report.scope !== undefined || report.generation !== undefined) {
    const scope = report.scope === undefined ? '' : `作用域 ${report.scope}`
    const generation = report.generation === undefined
      ? ''
      : `${scope === '' ? '' : '    '}世代 ${report.generation.from} → ${report.generation.to}`
    lines.push(`  ${scope}${generation}`)
  }
  if (report.cycles.length > 0) {
    lines.push(`  依赖循环 ${report.cycles.length} 条：`)
    for (const cycle of report.cycles) lines.push(`  ${cycle.cycle.join(' → ')}`)
  }
  const firstTarget = report.conflicts[0]?.constraint.target
  if (PACK_CODES.has(report.code) && firstTarget !== undefined) {
    lines.push(`  文件 ${firstTarget}`)
  }
  const conflicts = report.conflicts as readonly AnyConflict[]
  if (conflicts.length > 0) lines.push('')
  conflicts.forEach((entry, index) => {
    const isService = 'service' in entry
    const header = isService
      ? `  冲突 ${index + 1}/${conflicts.length} · 服务 ${entry.service}`
      : `  冲突 ${index + 1}/${conflicts.length} · 插件 ${entry.plugin}`
    lines.push(header)
    lines.push(`    约束 ${entry.constraint.kind} ${entry.constraint.target}（${entry.constraint.range}）`)
    lines.push(`    链路 ${entry.chain.join(' → ')}`)
    lines.push('    候选集：')
    for (const candidate of entry.candidates) {
      if (isService) {
        const item = candidate as { readonly plugin: string; readonly version?: string; readonly state?: string }
        lines.push(`      ${item.plugin}${item.version === undefined ? '' : `@${item.version}`}${item.state === undefined ? '' : ` [${item.state}]`}`)
      } else {
        const item = candidate as { readonly version: string; readonly rejected: readonly string[] }
        lines.push(`      ${item.version} — ${item.rejected.join('；')}`)
      }
    }
    lines.push(`    建议 ${entry.actions.join('；')}`)
  })
  return lines.join('\n') + '\n'
}

/** pack 成功的人类可读输出。 */
export function renderPackSuccess(
  packPath: string,
  sha256: string,
  pluginCount: number,
  communityDepCount: number,
): string {
  const lines = [`✓ 已打包 ${pluginCount} 个插件 → ${packPath}`, `  sha256 ${sha256}`]
  if (communityDepCount > 0) lines.push(`  社区依赖声明 ${communityDepCount} 条（--json 查看明细）`)
  return lines.join('\n') + '\n'
}

/** restore 成功的人类可读输出（含告警）。 */
export function renderRestoreSuccess(profile: string, pluginCount: number, warnings: readonly string[]): string {
  const lines = [`✓ 已还原 → profile ${profile}：${pluginCount} 个插件`]
  for (const warning of warnings) lines.push(`  [warn] ${warning}`)
  return lines.join('\n') + '\n'
}

/** init 成功的人类可读输出。 */
export function renderInitSuccess(dir: string, fileCount: number, id: string): string {
  return [
    `✓ 已生成插件骨架 → ${dir}（${fileCount} 个文件）`,
    `  manifest：id=${id} version=0.0.1 entry=lib/index.js（B1 校验通过）`,
    '  下一步：cd ' + dir + ' && pnpm install && pnpm run build（联网由用户自行执行）',
  ].join('\n') + '\n'
}

/** 用法文本（mygo 总览 + 可选子命令详情）。 */
export function renderUsage(topic?: 'pack' | 'restore' | 'init'): string {
  const common = '  --json     机器可读输出（stdout 只含唯一 JSON 文档）\n'
  const topics: Record<'pack' | 'restore' | 'init', string> = {
    pack: [
      '用法：dsh --profile <profile> mygo pack [-o|--output <path>] [--no-community-deps] [--json]',
      '',
      '  -o/--output <path>  产物路径（缺省 ./<profile>-plugins.mygo-pack）',
      '  --no-community-deps  关闭社区依赖收割（B25）',
      common,
    ].join('\n'),
    restore: [
      '用法：dsh --profile <profile> mygo restore <pack> [--profile <target>] [--json]',
      '',
      '  <pack>               本地 .mygo-pack 路径（必填）',
      '  --profile <target>   还原目标 profile（缺省当前 profile）',
      common,
    ].join('\n'),
    init: [
      '用法：dsh --profile <profile> mygo init <name> [--id <id>] [--dir <dir>] [--json]',
      '',
      '  <name>               npm 包名（@scope/pkg 或 pkg；必填）',
      '  --id <id>            manifest id（缺省包名末段 slug）',
      '  --dir <dir>          输出目录（缺省 ./<包名末段>）',
      common,
    ].join('\n'),
  }
  if (topic !== undefined) return topics[topic]
  return [
    '用法：dsh --profile <profile> mygo <command> [args...]',
    '',
    '子命令：',
    '  pack     从当前 profile 打包（既有 buildPack 翻译）',
    '  restore  还原 pack 到 profile（既有 installPack 翻译）',
    '  init     生成官方模板对齐的新插件骨架（B16 落地）',
    '',
    '全局：--json 机器可读；-h/--help 查看子命令用法。',
    '',
  ].join('\n')
}

/** 用法错误附加行（错误详情已由调用方先行输出）。 */
export function renderUsageError(): string {
  return '用 dsh --profile <profile> mygo --help 查看用法\n'
}

/** `--json` 唯一输出文档（stdout 不得出现其他字节）。 */
export function jsonOutput(command: string, payload: unknown): string {
  return JSON.stringify({ ...(payload as object), command }) + '\n'
}
