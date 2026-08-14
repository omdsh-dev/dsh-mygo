/**
 * B7 结构化报告 → 终端/JSON 的确定性渲染（design-r5 §3）。
 * 所有 human 输出为固定字节序列（快照断言基础）；--json 时 stdout 只含唯一 JSON 文档。
 * @module @r05en1cu/dsh-mygo-cli/render
 */

import type { ResolutionReport, ServiceConflictEntry, ServiceResolutionReport } from '@r05en1cu/dsh-mygo'

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
  if (report.scope !== undefined) {
    lines.push(`  作用域 ${report.scope}`)
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

/** install/uninstall 成功的人类可读输出（含对账后 bundle 层列表）。 */
export function renderInstallSuccess(verb: 'install' | 'uninstall', profile: string, bundles: readonly string[]): string {
  const lines = [`✓ ${verb} 完成 → profile ${profile}`]
  if (bundles.length > 0) lines.push(`  profile bundle 层：${bundles.join(', ')}`)
  return lines.join('\n') + '\n'
}

/** enable/disable 成功的人类可读输出。 */
export function renderSetEnabledSuccess(verb: 'enable' | 'disable', id: string, profile: string): string {
  const action = verb === 'enable' ? '已启用' : '已停用'
  return `✓ ${action} ${id}（profile ${profile} 的 cordis.patch.yml 已更新）\n`
}

/** instances 列表的人类可读输出（当前实例 HOME 标注 *）。 */
export function renderInstances(
  instances: readonly { readonly home: string; readonly dshVersion?: string; readonly lastSeenAt: string }[],
  currentHome: string,
): string {
  if (instances.length === 0) {
    return '没有已登记的实例（mygo adopt --home <path> 登记；服务启动也会自动登记当前实例）\n'
  }
  const lines = [`已登记实例 ${instances.length} 个（* = 当前实例）：`]
  for (const record of instances) {
    const marker = record.home === currentHome ? '*' : ' '
    lines.push(`${marker} ${record.home}`)
    lines.push(`    dsh ${record.dshVersion ?? '未知'} · lastSeenAt ${record.lastSeenAt}`)
  }
  return lines.join('\n') + '\n'
}

/** adopt 成功的人类可读输出（首次对账摘要）。 */
export function renderAdoptSuccess(
  home: string,
  profiles: readonly string[],
  mygoVersion: string | undefined,
  dshVersion: string | undefined,
): string {
  const lines = [`✓ 已登记实例 → ${home}`]
  lines.push(`  对账：profile ${profiles.length === 0 ? '（无）' : profiles.join(', ')}`)
  lines.push(`  mygo ${mygoVersion ?? '未安装'} · dsh ${dshVersion ?? '未知'}`)
  return lines.join('\n') + '\n'
}

/** clone 成功的人类可读输出。 */
export function renderCloneSuccess(
  id: string,
  version: string,
  to: string,
  sha512: string,
  cacheHit: boolean,
  via: 'hardlink' | 'copy',
): string {
  const lines = [`✓ 已克隆 ${id}@${version} → ${to}`]
  lines.push(`  共享缓存 ${sha512.slice(0, 12)}…（${cacheHit ? '命中，零写盘' : '新发布'}；导入经 ${via}）`)
  return lines.join('\n') + '\n'
}

/** 用法文本（mygo 总览 + 可选子命令详情）。 */
export function renderUsage(topic?: 'pack' | 'restore' | 'init' | 'install' | 'uninstall' | 'enable' | 'disable' | 'instances' | 'adopt' | 'clone' | 'hub'): string {
  const common = '  --json     机器可读输出（stdout 只含唯一 JSON 文档）\n'
  const topics: Record<'pack' | 'restore' | 'init' | 'install' | 'uninstall' | 'enable' | 'disable' | 'instances' | 'adopt' | 'clone' | 'hub', string> = {
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
    install: [
      '用法：dsh --profile <profile> mygo install <spec> [--json]',
      '',
      '  <spec>               pnpm 安装 spec（包名[@版本] / tarball / file: 路径）',
      '  语义：目标 profile 目录跑 pnpm add，按 dsh.bundle 声明对账 profile 层',
      common,
    ].join('\n'),
    uninstall: [
      '用法：dsh --profile <profile> mygo uninstall <name> [--json]',
      '',
      '  <name>               包名（pnpm remove + bundle 对账）',
      common,
    ].join('\n'),
    enable: [
      '用法：dsh --profile <profile> mygo enable <id> [--json]',
      '',
      '  <id>                 插件 id（移除 profile patch 层的 disabled 块）',
      common,
    ].join('\n'),
    disable: [
      '用法：dsh --profile <profile> mygo disable <id> [--json]',
      '',
      '  <id>                 插件 id（向 profile patch 层写入 disabled 块）',
      common,
    ].join('\n'),
    instances: [
      '用法：dsh --profile <profile> mygo instances [--json]',
      '',
      '  列出用户级实例登记处（家目录 .dsh-mygo/instances.json）的全部实例',
      '  （实例 = $DSH_HOME；每条仅 home / dshVersion / lastSeenAt）',
      common,
    ].join('\n'),
    adopt: [
      '用法：dsh --profile <profile> mygo adopt --home <path> [--json]',
      '',
      '  --home <path>        目标实例的 $DSH_HOME（登记 + 首次对账；不写对端插件状态）',
      common,
    ].join('\n'),
    clone: [
      '用法：dsh --profile <profile> mygo clone --from <homeA> --to <homeB> <plugin> [--json]',
      '',
      '  --from <homeA>       源实例的 $DSH_HOME（须已登记）',
      '  --to <homeB>         目标实例的 $DSH_HOME（须已登记）',
      '  <plugin>             插件 id（A 侧 pack 导出 → 共享缓存 → B 侧还原安装）',
      common,
    ].join('\n'),
    hub: [
      '用法：dsh --profile <profile> mygo hub <verb> [arg] [--snapshot <path>] [--insecure-no-verify] [--json]',
      '',
      '  search <query>       检索 hub 条目（本地筛选）',
      '  info <id>[@release]  条目详情 + 可安装判定与治理提示',
      '  install <id>[@release]  安装条目（profile-bundle 经 profile 执行面；',
      '                          guided 只展示；repository-plugin 默认拒绝）',
      '                          <id> 命中 collection 时整组原子安装',
      '  collections          列出 collections',
      '  --snapshot <path>    用本地快照（file:// 或路径），不拉远程',
      '  --insecure-no-verify 跳过摘要/验签（仅本地快照生效）',
      common,
    ].join('\n'),
  }
  if (topic !== undefined) return topics[topic]
  return [
    '用法：dsh --profile <profile> mygo <command> [args...]',
    '',
    '子命令：',
    '  pack       从当前 profile 打包（既有 buildPack 翻译）',
    '  restore    还原 pack 到 profile（既有 installPack 翻译）',
    '  init       生成官方模板对齐的新插件骨架（B16 落地）',
    '  install    安装插件到当前 profile（pnpm + dsh.bundle 对账）',
    '  uninstall  从当前 profile 卸载插件',
    '  enable     启用插件（移除 profile patch 层 disabled 块）',
    '  disable    停用插件（写入 profile patch 层 disabled 块）',
    '  instances  列出已登记实例（用户级实例登记处）',
    '  adopt      登记另一个实例 HOME 并首次对账（不写对端插件状态）',
    '  clone      跨实例克隆插件（pack → 共享缓存 → 目标实例还原安装）',
    '  hub        dsh-hub 市场（search / info / install / collections）',
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
