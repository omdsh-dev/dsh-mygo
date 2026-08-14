/**
 * `mygo config <plugin>`（P7-A2）：patch 不 deep-merge 的补救——读取
 * profile patch 层中目标插件行的整行 config，浅合并修改后写回整行
 * （消除手工重述全字段）。行定位与块切分为文本级（保留注释与行序），
 * config 子块经 js-yaml 解析/重排。
 * @module @r05en1cu/dsh-mygo-cli/config
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { assertInsideHome } from '@r05en1cu/dsh-mygo'

export interface ConfigRowResult {
  readonly ok: boolean
  /** 当前 config（读/写后均为整行最新值）。 */
  readonly config?: Record<string, unknown>
  readonly error?: string | undefined
}

/** patch 层行的文本区间。 */
interface RowSpan {
  readonly start: number
  readonly end: number
  readonly indent: string
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** 定位插件行（`- id: <id>`，可选引号；insert 列表内缩进更深亦覆盖）。 */
function findRow(lines: readonly string[], id: string): RowSpan | undefined {
  const rowRe = new RegExp(`^(\\s*)-\\s+id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`)
  for (const [index, line] of lines.entries()) {
    const match = rowRe.exec(line)
    if (match === null) continue
    const indent = match[1] ?? ''
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? ''
      if (candidate.trim() === '') continue
      const depth = indentOf(candidate)
      if (depth < indent.length) {
        end = cursor
        break
      }
      if (depth === indent.length && candidate.trimStart().startsWith('- ')) {
        end = cursor
        break
      }
    }
    return { start: index, end, indent }
  }
  return undefined
}

/** 行内 config 子块区间（无 config 返回 undefined）。 */
function findConfigBlock(rowLines: readonly string[], rowIndent: string): { readonly start: number; readonly end: number; readonly indent: string; readonly inline?: string } | undefined {
  const configRe = /^(\s*)config:\s*(.*)$/
  for (const [index, line] of rowLines.entries()) {
    const match = configRe.exec(line)
    if (match === null) continue
    const indent = match[1] ?? ''
    if (indent.length <= rowIndent.length) continue
    const inline = (match[2] ?? '').trim()
    if (inline !== '') return { start: index, end: index + 1, indent, inline }
    let end = rowLines.length
    for (let cursor = index + 1; cursor < rowLines.length; cursor += 1) {
      const candidate = rowLines[cursor] ?? ''
      if (candidate.trim() === '') continue
      if (indentOf(candidate) <= indent.length) {
        end = cursor
        break
      }
    }
    return { start: index, end, indent }
  }
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function profilePatchPath(home: string, profile: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(profile)) {
    throw new Error(`目标路径逃出实例 HOME：非法 profile 名 ${JSON.stringify(profile)}（实例 HOME=${home}）`)
  }
  return assertInsideHome(home, join(home, 'profiles', profile, 'cordis.patch.yml'))
}

/** 读目标插件行的整行 config（无行/无 config → undefined）。 */
export function readRowConfig(home: string, profile: string, id: string): ConfigRowResult {
  let path: string
  try {
    path = profilePatchPath(home, profile)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!existsSync(path)) return { ok: false, error: `profile patch 层不存在：${path}` }
  const lines = readFileSync(path, 'utf8').split('\n')
  const row = findRow(lines, id)
  if (row === undefined) return { ok: false, error: `patch 层没有 ${id} 行` }
  const rowLines = lines.slice(row.start, row.end)
  const block = findConfigBlock(rowLines, row.indent)
  if (block === undefined) return { ok: true, config: {} }
  const text = block.inline !== undefined
    ? block.inline
    : rowLines.slice(block.start + 1, block.end).map(line => line.slice(block.indent.length + 2)).join('\n')
  const parsed = (block.inline !== undefined ? yaml.load(text) : yaml.load(text)) as unknown
  if (parsed === undefined || parsed === null) return { ok: true, config: {} }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${id} 行 config 不是对象` }
  }
  return { ok: true, config: parsed as Record<string, unknown> }
}

/** 浅合并写回整行 config（行无 config 则追加子块；行不存在报错）。 */
export function writeRowConfig(home: string, profile: string, id: string, patch: Record<string, unknown>): ConfigRowResult {
  let path: string
  try {
    path = profilePatchPath(home, profile)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!existsSync(path)) return { ok: false, error: `profile patch 层不存在：${path}` }
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const row = findRow(lines, id)
  if (row === undefined) return { ok: false, error: `patch 层没有 ${id} 行` }
  const current = readRowConfig(home, profile, id)
  if (!current.ok) return current
  const merged = { ...current.config, ...patch }
  const dumped = yaml.dump(merged, { lineWidth: -1, noRefs: true }).trimEnd()
  const rowLines = lines.slice(row.start, row.end)
  // 行尾空行不进 config 追加位置（追加必须紧贴行末内容行）。
  while (rowLines.length > 0 && (rowLines[rowLines.length - 1] ?? '').trim() === '') rowLines.pop()
  const block = findConfigBlock(rowLines, row.indent)
  const configLines = dumped.split('\n').map(line => `${row.indent}  ${line}`)
  let nextRow: string[]
  if (block === undefined) {
    nextRow = [...rowLines, `${row.indent}  config:`, ...configLines.map(line => `  ${line}`)]
  } else if (block.inline !== undefined) {
    nextRow = [
      ...rowLines.slice(0, block.start),
      `${block.indent}config:`,
      ...configLines.map(line => `  ${line}`),
      ...rowLines.slice(block.end),
    ]
  } else {
    nextRow = [
      ...rowLines.slice(0, block.start),
      `${block.indent}config:`,
      ...configLines.map(line => `  ${line}`),
      ...rowLines.slice(block.end),
    ]
  }
  const next = [...lines.slice(0, row.start), ...nextRow, ...lines.slice(row.end)].join('\n')
  writeFileSync(path, next, 'utf8')
  return { ok: true, config: merged }
}
