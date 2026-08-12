/**
 * mygo CLI 最小参数解析器（design-r5 §2；任务书 §0 允许手写最小实现）。
 * 零第三方依赖；确定性输出；用法错误与帮助不触发任何 I/O 之外的副作用。
 * @module @dsh-external/dsh-mygo-cli/args
 */

/** 一条已解析的 mygo 子命令。 */
export type CliCommand =
  | {
    readonly kind: 'pack'
    readonly output: string
    readonly includeCommunityDeps: boolean
    readonly json: boolean
  }
  | {
    readonly kind: 'restore'
    readonly pack: string
    readonly targetProfile?: string
    readonly json: boolean
  }
  | {
    readonly kind: 'init'
    readonly name: string
    readonly id?: string
    readonly dir?: string
    readonly json: boolean
  }

/** 解析结果：一条命令 / 帮助请求 / 用法错误。 */
export type CliParse =
  | { readonly kind: 'command'; readonly command: CliCommand }
  | { readonly kind: 'help'; readonly topic?: 'pack' | 'restore' | 'init' }
  | { readonly kind: 'usage-error'; readonly message: string }

const COMMANDS = new Set(['pack', 'restore', 'init'])

/** npm 包名最小校验（手写；task 允许）：小写、URL 安全、非空段。 */
export function isValidNpmName(name: string): boolean {
  if (name.length === 0 || name.length > 214 || name !== name.toLowerCase()) return false
  if (name.startsWith('.') || name.startsWith('_')) return false
  if (name.includes(' ') || name.includes('\\') || name.includes(':')) return false
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash <= 1 || slash === name.length - 1) return false
    const scope = name.slice(1, slash)
    const pkg = name.slice(slash + 1)
    return /^[a-z0-9][a-z0-9._-]*$/.test(scope) && /^[a-z0-9][a-z0-9._-]*$/.test(pkg)
  }
  return /^[a-z0-9][a-z0-9._-]*$/.test(name)
}

/** 包名末段 → manifest id（dsh-sdk 同款推导：小写 slug）。 */
export function slugId(name: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function takeValue(
  argv: readonly string[],
  index: number,
  inline?: string,
): { readonly ok: true; readonly value: string; readonly next: number } | { readonly ok: false } {
  if (inline !== undefined && inline !== '') return { ok: true, value: inline, next: index + 1 }
  const value = argv[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) return { ok: false }
  return { ok: true, value, next: index + 2 }
}

/**
 * 解析 `mygo` 之后的内层参数。支持 `--flag value`、`--flag=value`、`-o value`、
 * 布尔旗标与 `--` 结束符；未知旗标/缺参/未知子命令 → usage-error。
 */
export function parseCliArgs(argv: readonly string[]): CliParse {
  const [head, ...rest] = argv
  if (head === undefined) return { kind: 'help' }
  if (head === '-h' || head === '--help') return { kind: 'help' }
  if (!COMMANDS.has(head)) {
    return { kind: 'usage-error', message: `未知子命令 ${JSON.stringify(head)}（可用：pack / restore / init）` }
  }
  const command = head as 'pack' | 'restore' | 'init'
  const positional: string[] = []
  let json = false
  let output = ''
  let includeCommunityDeps = true
  let targetProfile: string | undefined
  let id: string | undefined
  let dir: string | undefined
  let index = 0
  let flagsEnded = false
  while (index < rest.length) {
    const token = rest[index]
    if (token === undefined) break
    if (flagsEnded || !token.startsWith('-') || token === '-') {
      positional.push(token)
      index += 1
      continue
    }
    if (token === '--') {
      flagsEnded = true
      index += 1
      continue
    }
    if (token === '-h' || token === '--help') return { kind: 'help', topic: command }
    if (token === '--json') {
      json = true
      index += 1
      continue
    }
    if (token === '--no-community-deps') {
      if (command !== 'pack') {
        return { kind: 'usage-error', message: `--no-community-deps 仅 pack 支持` }
      }
      includeCommunityDeps = false
      index += 1
      continue
    }
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? undefined : token.slice(eq + 1)
    if (command === 'pack' && (flag === '-o' || flag === '--output')) {
      const taken = takeValue(rest, index, inline)
      if (!taken.ok) return { kind: 'usage-error', message: `${flag} 需要一个值` }
      output = taken.value
      index = taken.next
      continue
    }
    if (command === 'restore' && flag === '--profile') {
      const taken = takeValue(rest, index, inline)
      if (!taken.ok) return { kind: 'usage-error', message: `--profile 需要一个值` }
      targetProfile = taken.value
      index = taken.next
      continue
    }
    if (command === 'init' && flag === '--id') {
      const taken = takeValue(rest, index, inline)
      if (!taken.ok) return { kind: 'usage-error', message: `--id 需要一个值` }
      id = taken.value
      index = taken.next
      continue
    }
    if (command === 'init' && flag === '--dir') {
      const taken = takeValue(rest, index, inline)
      if (!taken.ok) return { kind: 'usage-error', message: `--dir 需要一个值` }
      dir = taken.value
      index = taken.next
      continue
    }
    return { kind: 'usage-error', message: `${command} 不支持参数 ${JSON.stringify(token)}` }
  }

  if (command === 'pack') {
    if (positional.length > 0) {
      return { kind: 'usage-error', message: `pack 不接受位置参数：${positional.join(' ')}` }
    }
    return {
      kind: 'command',
      command: {
        kind: 'pack',
        output,
        includeCommunityDeps,
        json,
      },
    }
  }
  if (command === 'restore') {
    const pack = positional.shift()
    if (pack === undefined || pack === '') {
      return { kind: 'usage-error', message: 'restore 需要一个 pack 路径' }
    }
    if (positional.length > 0) {
      return { kind: 'usage-error', message: `restore 只接受一个 pack 路径：${positional.join(' ')}` }
    }
    return {
      kind: 'command',
      command: {
        kind: 'restore',
        pack,
        ...(targetProfile === undefined ? {} : { targetProfile }),
        json,
      },
    }
  }
  const name = positional.shift()
  if (name === undefined || name === '') {
    return { kind: 'usage-error', message: 'init 需要一个 npm 包名' }
  }
  if (positional.length > 0) {
    return { kind: 'usage-error', message: `init 只接受一个包名：${positional.join(' ')}` }
  }
  if (!isValidNpmName(name)) {
    return { kind: 'usage-error', message: `非法 npm 包名：${JSON.stringify(name)}` }
  }
  if (id !== undefined && !/^[a-z][a-z0-9-]*$/.test(id)) {
    return { kind: 'usage-error', message: `非法 manifest id（须匹配 /^[a-z][a-z0-9-]*$/）：${JSON.stringify(id)}` }
  }
  return {
    kind: 'command',
    command: {
      kind: 'init',
      name,
      ...(id === undefined ? {} : { id }),
      ...(dir === undefined ? {} : { dir }),
      json,
    },
  }
}
