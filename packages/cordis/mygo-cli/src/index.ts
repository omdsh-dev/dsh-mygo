/**
 * mygo CLI 用户面（design-r5）：dsh app 插件形态的 pack/restore/init。
 * 只把既有 buildPack/installPack/模板对齐翻译为命令面，零新增治理语义。
 *
 * 注册面（L0）：读取官方启动器提供的 `ctx.cmdlineArgs` / `ctx.appExit`
 * （@deepseek-ai/dsh-cmdline 契约，apps/cli/profile-boot 挂载前提供）。
 * 被动语义：内层参数首 token 非 `mygo` 时 MUST 完全无副作用返回。
 * @module @r05en1cu/dsh-mygo-cli
 */

import {
  MYGO_MANAGER_VERSION,
  PluginPackageManager,
  resolveCoreVersion,
  resolveMygoPaths,
} from '@r05en1cu/dsh-mygo'
import { resolve } from 'node:path'
import { parseCliArgs, type CliCommand } from './args.ts'
import { InitError, generatePluginSkeleton } from './init.ts'
import {
  jsonOutput,
  renderInitSuccess,
  renderInstallSuccess,
  renderPackSuccess,
  renderReportHuman,
  renderRestoreSuccess,
  renderSetEnabledSuccess,
  renderUsage,
  renderUsageError,
} from './render.ts'
import { profileInstall, profileSetEnabled, profileUninstall } from './install.ts'

/** Cordis 插件名（稳定；manifest id 同源）。 */
export const name = 'dsh-mygo-cli'

/** 官方 cmdlineArgs 服务的最小结构面。 */
export interface CmdlineArgsLike {
  get(): readonly string[]
}

/** 官方 appExit 服务的最小结构面。 */
export type AppExitLike = (code: number) => void

/** 本插件需要的宿主 ctx 结构面（不 import 宿主包，保持零运行时依赖）。 */
export interface CliHost {
  get<T = unknown>(key: string): T | undefined
}

/** 进程输出面（测试可替换；对齐 dsh-cmdline internals 惯例）。 */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Cordis apply：被动语义 + 派发。`mygo` 之后的参数交给 {@link invokeCli}。
 */
export async function apply(ctx: CliHost): Promise<void> {
  const args = ctx.get<CmdlineArgsLike>('cmdlineArgs')?.get() ?? []
  if (args[0] !== 'mygo') return
  await invokeCli(ctx, args.slice(1))
}

/**
 * 执行一条 mygo 命令并请求进程退出（返回码同时直接给出，便于测试）。
 */
export async function invokeCli(ctx: CliHost, argv: readonly string[]): Promise<number> {
  const exit = ctx.get<AppExitLike>('appExit')
  const parsed = parseCliArgs(argv)
  let code: number
  if (parsed.kind === 'usage-error') {
    internals.stderr.write(`dsh mygo: ${parsed.message}\n`)
    internals.stderr.write(renderUsageError())
    code = 2
  } else if (parsed.kind === 'help') {
    internals.stdout.write(renderUsage(parsed.topic))
    code = 0
  } else {
    code = await runCommand(ctx, parsed.command)
  }
  exit?.(code)
  return code
}

/** 当前 profile：管理器推导值优先，行配置次之（bundle 形态 config 可不携带）。 */
function profileOf(ctx: CliHost): { readonly ok: true; readonly profile: string } | { readonly ok: false; readonly reason: string } {
  const manager = ctx.get<{ readonly profile?: string; readonly config?: { readonly profile?: string } }>('pluginManager')
  const profile = manager?.profile ?? manager?.config?.profile
  if (profile === undefined || profile === '') {
    return {
      ok: false,
      reason: '需要 mygo 管理器（pluginManager 服务缺失或未配置 profile），无法确定当前 profile：'
        + '请确认 mygo 已安装并挂载（dsh-mygo 行）后重试',
    }
  }
  return { ok: true, profile }
}

function coreVersion(): string | undefined {
  return resolveCoreVersion(process.env)
}

function managerFor(profile: string): PluginPackageManager {
  const core = coreVersion()
  return new PluginPackageManager({
    paths: resolveMygoPaths(profile, process.env),
    profile,
    managerVersion: MYGO_MANAGER_VERSION,
    ...(core === undefined ? {} : { coreVersion: core }),
  })
}

/** 操作失败的通用信封（非结构化报告类错误，如 profile 缺失）。 */
function errorEnvelope(command: string, code: string, message: string, json: boolean): number {
  if (json) {
    internals.stdout.write(jsonOutput(command, { ok: false, error: { code, message } }))
  } else {
    internals.stderr.write(`✗ ${code}：${message}\n`)
  }
  return 1
}

async function runCommand(ctx: CliHost, command: CliCommand): Promise<number> {
  switch (command.kind) {
    case 'pack': return runPack(ctx, command)
    case 'restore': return runRestore(ctx, command)
    case 'init': return runInit(command)
    case 'install': return runInstall(ctx, command)
    case 'uninstall': return runUninstall(ctx, command)
    case 'enable':
    case 'disable': return runSetEnabled(ctx, command)
  }
}

/** 安装执行面（P3 原生形态）：目标 profile 目录 pnpm + dsh.bundle 对账。 */
function runInstall(
  ctx: CliHost,
  command: Extract<CliCommand, { readonly kind: 'install' }>,
): number {
  const current = profileOf(ctx)
  if (!current.ok) return errorEnvelope('install', 'no-profile', current.reason, command.json)
  const outcome = profileInstall(command.spec, { profile: current.profile })
  if (!outcome.ok) return errorEnvelope('install', 'install-failed', outcome.error ?? 'pnpm 失败', command.json)
  if (command.json) {
    internals.stdout.write(jsonOutput('install', { ok: true, profile: outcome.profile, bundles: outcome.bundles }))
  } else {
    internals.stdout.write(renderInstallSuccess('install', outcome.profile, outcome.bundles ?? []))
  }
  return 0
}

function runUninstall(
  ctx: CliHost,
  command: Extract<CliCommand, { readonly kind: 'uninstall' }>,
): number {
  const current = profileOf(ctx)
  if (!current.ok) return errorEnvelope('uninstall', 'no-profile', current.reason, command.json)
  const outcome = profileUninstall(command.name, { profile: current.profile })
  if (!outcome.ok) return errorEnvelope('uninstall', 'uninstall-failed', outcome.error ?? 'pnpm 失败', command.json)
  if (command.json) {
    internals.stdout.write(jsonOutput('uninstall', { ok: true, profile: outcome.profile, bundles: outcome.bundles }))
  } else {
    internals.stdout.write(renderInstallSuccess('uninstall', outcome.profile, outcome.bundles ?? []))
  }
  return 0
}

function runSetEnabled(
  ctx: CliHost,
  command: Extract<CliCommand, { readonly kind: 'enable' | 'disable' }>,
): number {
  const current = profileOf(ctx)
  if (!current.ok) return errorEnvelope(command.kind, 'no-profile', current.reason, command.json)
  const outcome = profileSetEnabled(command.id, command.kind === 'enable', { profile: current.profile })
  if (!outcome.ok) return errorEnvelope(command.kind, `${command.kind}-failed`, outcome.error ?? '写入失败', command.json)
  if (command.json) {
    internals.stdout.write(jsonOutput(command.kind, { ok: true, profile: outcome.profile, id: command.id }))
  } else {
    internals.stdout.write(renderSetEnabledSuccess(command.kind, command.id, outcome.profile))
  }
  return 0
}

async function runPack(
  ctx: CliHost,
  command: Extract<CliCommand, { readonly kind: 'pack' }>,
): Promise<number> {
  const current = profileOf(ctx)
  if (!current.ok) return errorEnvelope('pack', 'no-profile', current.reason, command.json)
  const output = resolve(process.cwd(), command.output === '' ? `${current.profile}-plugins.mygo-pack` : command.output)
  const outcome = await managerFor(current.profile).buildPack({
    output,
    includeCommunityDeps: command.includeCommunityDeps,
  })
  if (outcome.ok) {
    if (command.json) {
      internals.stdout.write(jsonOutput('pack', {
        ok: true,
        packPath: output,
        sha256: outcome.sha256,
        plugins: outcome.manifest.plugins,
        communityDeps: outcome.manifest.communityDeps,
      }))
    } else {
      internals.stdout.write(renderPackSuccess(
        output,
        outcome.sha256,
        outcome.manifest.plugins.length,
        outcome.manifest.communityDeps.length,
      ))
    }
    return 0
  }
  if (command.json) {
    internals.stdout.write(jsonOutput('pack', { ok: false, report: outcome.report }))
  } else {
    internals.stdout.write(renderReportHuman(outcome.report))
  }
  return 1
}

async function runRestore(
  ctx: CliHost,
  command: Extract<CliCommand, { readonly kind: 'restore' }>,
): Promise<number> {
  const current = profileOf(ctx)
  const target = command.targetProfile ?? (current.ok ? current.profile : undefined)
  if (target === undefined) {
    const reason = current.ok ? '未知目标 profile' : current.reason
    return errorEnvelope('restore', 'no-profile', reason, command.json)
  }
  const packPath = resolve(process.cwd(), command.pack)
  const core = coreVersion()
  const outcome = await managerFor(target).installPack(packPath, core === undefined ? {} : { coreVersion: core })
  if (outcome.ok) {
    const pluginCount = outcome.restored.length
    if (command.json) {
      internals.stdout.write(jsonOutput('restore', {
        ok: true,
        profile: target,
        plugins: pluginCount,
        warnings: outcome.warnings,
      }))
    } else {
      internals.stdout.write(renderRestoreSuccess(target, pluginCount, outcome.warnings))
    }
    return 0
  }
  if (command.json) {
    internals.stdout.write(jsonOutput('restore', { ok: false, report: outcome.report }))
  } else {
    internals.stdout.write(renderReportHuman(outcome.report))
  }
  return 1
}

async function runInit(command: Extract<CliCommand, { readonly kind: 'init' }>): Promise<number> {
  try {
    const result = await generatePluginSkeleton(command.name, {
      ...(command.id === undefined ? {} : { id: command.id }),
      ...(command.dir === undefined ? {} : { dir: command.dir }),
      cwd: process.cwd(),
    })
    if (command.json) {
      internals.stdout.write(jsonOutput('init', {
        ok: true,
        dir: result.dir,
        id: result.id,
        manifest: result.manifest,
      }))
    } else {
      internals.stdout.write(renderInitSuccess(result.dir, result.files.length, result.id))
    }
    return 0
  } catch (error) {
    const message = error instanceof InitError
      ? error.message
      : error instanceof Error ? error.message : String(error)
    return errorEnvelope('init', 'init-failed', message, command.json)
  }
}

/** 供包级 invariant 伴生与测试引用的稳定标识。 */
export const CLI_PACKAGE_NAME = '@r05en1cu/dsh-mygo-cli'
