import { useCallback, useEffect, useRef, useState } from 'react'
import css from './Panel.module.css'

export interface MygoPluginRow {
  readonly id: string
  readonly version: string
  readonly status: string
  readonly origin: string
  readonly generation: number
  readonly rail?: 'bridge' | 'bundle'
  readonly hostConflicts?: readonly string[]
}

export interface MygoAppRow {
  readonly id: string
  readonly kind: 'external-app'
  readonly startCommand: string
  readonly sandbox: 'none' | 'workspace'
  readonly syncUninstall: false
  readonly running: boolean
  readonly processOwned: boolean
}

export interface RemoteUpdateRow {
  readonly id: string
  readonly kind: 'plugin' | 'app' | 'mygo'
  readonly url: string
  readonly ref: string
  readonly currentCommit: string
  readonly latestCommit?: string
  readonly upToDate?: boolean
  readonly error?: string
}

/** One configurable field surfaced by the panel (mirrors the server shape). */
export interface ConfigFieldShape {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description?: string
  readonly role?: string
  readonly extra?: unknown
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly pattern?: string
  readonly default?: unknown
  readonly literal?: unknown
  readonly enumValues?: readonly unknown[]
  readonly children?: readonly ConfigFieldShape[]
}

interface ApiResult {
  readonly ok: boolean
  readonly error?: string
  readonly details?: Readonly<Record<string, unknown>>
  readonly message?: string
  readonly plugins?: readonly MygoPluginRow[]
  readonly apps?: readonly MygoAppRow[]
  readonly updates?: readonly RemoteUpdateRow[]
  readonly plan?: PlanShape
  readonly id?: string
  readonly configTemplate?: unknown
  readonly configSchema?: {
    readonly description?: string
    readonly fields?: readonly ConfigFieldShape[]
  }
  readonly current?: unknown
  readonly schema?: {
    readonly description?: string
    readonly fields?: readonly ConfigFieldShape[]
  }
  readonly template?: unknown
  readonly status?: string
  readonly startedAt?: number
  readonly runId?: string
  readonly result?: { readonly recommendedConfig?: unknown; readonly notes?: string }
  readonly output?: string
  readonly messages?: readonly HelperMessage[]
}

interface PlanShape {
  readonly accepted: boolean
  readonly error?: { readonly code: string; readonly message: string }
  readonly warnings?: readonly string[]
}

interface PendingAction {
  readonly id: string
  readonly action: 'enable' | 'disable' | 'uninstall'
  readonly plan?: PlanShape
}

interface InstallPending {
  readonly id: string
  readonly plan: PlanShape
  readonly payload: Record<string, unknown>
  readonly hostConflicts?: readonly string[]
}

/** Expandable config editor state for one plugin. */
interface ConfigPanelState {
  readonly id: string
  readonly current: unknown
  readonly schema?: { readonly description?: string; readonly fields?: readonly ConfigFieldShape[] }
  readonly template?: unknown
  readonly editable: Record<string, unknown>
  readonly mode: 'form' | 'json'
  readonly text: string
  readonly busy: boolean
  readonly error?: string
  readonly notice?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Starter value for one field (schema default first, then type placeholder). */
function defaultValueOf(field: ConfigFieldShape): unknown {
  if (field.default !== undefined) return field.default
  switch (field.type) {
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'const':
      return field.literal
    case 'union':
      return field.enumValues?.[0]
    case 'array':
      return []
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const child of field.children ?? []) out[child.name] = defaultValueOf(child)
      return out
    }
    default:
      return undefined
  }
}

/** Current value merged with schema defaults, one level per field. */
function editableOf(field: ConfigFieldShape, current: unknown): unknown {
  if (field.type === 'object') {
    const base = isPlainObject(current) ? current : {}
    const out: Record<string, unknown> = {}
    for (const child of field.children ?? []) out[child.name] = editableOf(child, base[child.name])
    return out
  }
  return current === undefined ? defaultValueOf(field) : current
}

/** One config-helper chat message. */
interface HelperMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Page-level subagent config-helper section state. */
interface HelperPanelState {
  readonly status?: 'running' | 'done' | 'error' | 'stopped'
  readonly startedAt?: number
  readonly runId?: string
  readonly messages: readonly HelperMessage[]
  readonly error?: string
}

const HELPER_EXAMPLES = [
  '帮我看看 dsh-stickers 有哪些可配置项',
  '安装 https://github.com/dsh-external/dsh-browser-panel.git',
]

class ApiError extends Error {
  constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

async function api<T extends ApiResult>(
  path: string,
  methodOrInit?: string | { readonly method?: string; readonly body?: unknown },
): Promise<T> {
  const init = typeof methodOrInit === 'string' ? { method: methodOrInit } : (methodOrInit ?? {})
  const res = await fetch('/api/mygo' + path, {
    method: init.method ?? 'GET',
    ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  const data = (await res.json()) as T
  if (!data.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.details)
  return data
}

const STATUS_LABEL: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  quarantined: '隔离',
  shadowed: '遮蔽',
}

/** Schemastery-style field editor: scalar controls + nested object groups. */
function ConfigFieldEditor(props: {
  readonly field: ConfigFieldShape
  readonly value: unknown
  readonly onChange: (value: unknown) => void
}): JSX.Element {
  const { field, value, onChange } = props
  const setRaw = (raw: string): void => {
    if (field.type === 'number' || field.type === 'integer') {
      const parsed = raw === '' ? 0 : Number(raw)
      onChange(Number.isFinite(parsed) ? parsed : 0)
    } else if (field.type === 'boolean') {
      onChange(raw === 'true')
    } else {
      onChange(raw)
    }
  }
  let control: JSX.Element
  if (field.type === 'object') {
    control = (
      <div className={css.configFields}>
        {(field.children ?? []).map(child => (
          <ConfigFieldEditor
            key={child.name}
            field={child}
            value={isPlainObject(value) ? value[child.name] : defaultValueOf(child)}
            onChange={(next) => {
              const base = isPlainObject(value) ? { ...value } : {}
              onChange({ ...base, [child.name]: next })
            }}
          />
        ))}
      </div>
    )
  } else if (field.type === 'boolean') {
    control = (
      <input
        className={css.input}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  } else if (field.type === 'number' || field.type === 'integer') {
    control = (
      <input
        className={css.input}
        type="number"
        value={typeof value === 'number' ? value : 0}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(event) => setRaw(event.target.value)}
      />
    )
  } else if (field.type === 'const') {
    control = <span className={css.configFieldType}>{String(field.literal ?? '')}</span>
  } else if (field.role === 'select' || (field.type === 'union' && (field.enumValues ?? []).length > 0)) {
    const extraOptions = (field.extra as { readonly options?: readonly unknown[] } | undefined)?.options
    const options = extraOptions ?? field.enumValues ?? []
    control = (
      <select
        className={css.input}
        value={typeof value === 'string' ? value : String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option, index) => (
          <option key={index} value={String(option)}>{String(option)}</option>
        ))}
      </select>
    )
  } else if (field.role === 'textarea' || field.type === 'array' || field.type === 'dict') {
    control = (
      <textarea
        className={css.configTextarea}
        rows={3}
        spellCheck={false}
        defaultValue={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
        onBlur={(event) => {
          const raw = event.target.value
          try {
            onChange(field.type === 'string' ? raw : JSON.parse(raw))
          } catch {
            onChange(field.type === 'string' ? raw : (value ?? ''))
          }
        }}
      />
    )
  } else {
    control = (
      <input
        className={css.input}
        type={field.role === 'color' ? 'color' : 'text'}
        value={typeof value === 'string' ? value : String(value ?? '')}
        pattern={field.pattern}
        onChange={(event) => setRaw(event.target.value)}
      />
    )
  }
  return (
    <div className={css.configField}>
      <div className={css.row}>
        <span className={css.configFieldName}>{field.name}</span>
        <span className={css.configFieldType}>
          {field.type}{field.required ? ' · 必填' : ' · 可选'}
          {field.literal !== undefined ? ` · ${String(field.literal)}` : ''}
        </span>
        {field.default !== undefined && (
          <span className={css.configFieldDefault}>默认 {JSON.stringify(field.default)}</span>
        )}
      </div>
      {field.description !== undefined && <div className={css.inlineText}>{field.description}</div>}
      {control}
    </div>
  )
}

export function Panel(): JSX.Element {
  const [plugins, setPlugins] = useState<readonly MygoPluginRow[] | null>(null)
  const [apps, setApps] = useState<readonly MygoAppRow[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [errorDetails, setErrorDetails] = useState<Readonly<Record<string, unknown>> | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [appError, setAppError] = useState<string | undefined>()
  const [appNotice, setAppNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [appBusy, setAppBusy] = useState(false)
  const [updates, setUpdates] = useState<readonly RemoteUpdateRow[] | null>(null)
  const [updatesBusy, setUpdatesBusy] = useState(false)
  const [updatesMessage, setUpdatesMessage] = useState<string | undefined>()
  const [method, setMethod] = useState<'github' | 'folder' | 'archive' | 'bundle'>('github')
  const [url, setUrl] = useState('')
  const [spec, setSpec] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [configText, setConfigText] = useState('')
  const [installDeps, setInstallDeps] = useState(false)
  const [installAsApp, setInstallAsApp] = useState(false)
  const [appSandbox, setAppSandbox] = useState<'none' | 'workspace'>('none')
  const [setupText, setSetupText] = useState('')
  const [startCommandText, setStartCommandText] = useState('')
  const [skipBuild, setSkipBuild] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [pending, setPending] = useState<PendingAction | undefined>()
  const [configPanel, setConfigPanel] = useState<ConfigPanelState | undefined>()
  const [helperOpen, setHelperOpen] = useState(false)
  const [helper, setHelper] = useState<HelperPanelState | undefined>()
  const [helperBusy, setHelperBusy] = useState(false)
  const [helperInput, setHelperInput] = useState('')
  const helperChatRef = useRef<HTMLDivElement | null>(null)
  const helperTimer = useRef<ReturnType<typeof setInterval> | undefined>()
  useEffect(() => () => { if (helperTimer.current !== undefined) clearInterval(helperTimer.current) }, [])
  useEffect(() => {
    const node = helperChatRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [helper?.messages, helper?.status])
  const [installPending, setInstallPending] = useState<InstallPending | undefined>()
  const errorRef = useRef<HTMLDivElement>(null)
  const highlighted = new Set<string>(
    Array.isArray(errorDetails?.dependents)
      ? (errorDetails.dependents as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
  )

  useEffect(() => {
    if (error !== undefined) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [error])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api<ApiResult>('/plugins')
      setPlugins(result.plugins ?? [])
      setError(undefined)
      setErrorDetails(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
    try {
      const result = await api<ApiResult>('/apps')
      setApps(result.apps ?? [])
      setAppError(undefined)
    } catch (caught) {
      setAppError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const checkUpdates = useCallback(async (): Promise<void> => {
    setUpdatesBusy(true)
    try {
      const result = await api<ApiResult>('/updates')
      setUpdates(result.updates ?? [])
      setUpdatesMessage(undefined)
    } catch (caught) {
      setUpdatesMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setUpdatesBusy(false)
    }
  }, [])

  const performUpdate = useCallback(async (row: RemoteUpdateRow): Promise<void> => {
    setUpdatesBusy(true)
    try {
      const endpoint = row.kind === 'mygo'
        ? '/updates/mygo'
        : `/updates/${row.kind === 'plugin' ? 'plugins' : 'apps'}/${row.id}`
      const result = await api<ApiResult>(endpoint, 'POST')
      setUpdatesMessage(result.message)
      await refresh()
      await checkUpdates()
    } catch (caught) {
      setUpdatesMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setUpdatesBusy(false)
    }
  }, [refresh, checkUpdates])

  useEffect(() => { void refresh() }, [refresh])

  const act = useCallback(async (id: string, action: string): Promise<void> => {
    if (action === 'uninstall') {
      setPending({ id, action: 'uninstall' })
      return
    }
    setBusy(true)
    try {
      const preview = await api<ApiResult>('/plan', {
        method: 'POST',
        body: { op: action, id },
      })
      const plan = preview.plan
      if (plan === undefined) throw new Error('plan 接口未返回计划')
      // P1 起求解器级联动作已删除：plan 只剩求值结论（accepted/error/warnings）。
      if (plan.accepted) {
        const result = await api<ApiResult>(`/plugins/${id}/${action}`, 'POST')
        setNotice(result.message)
        setError(undefined)
        setErrorDetails(undefined)
        await refresh()
        return
      }
      setPending({ id, action: action === 'enable' ? 'enable' : 'disable', plan })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setErrorDetails(caught instanceof ApiError ? caught.details : undefined)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const confirmPending = useCallback(async (): Promise<void> => {
    if (pending === undefined) return
    const current = pending
    setPending(undefined)
    setBusy(true)
    try {
      if (current.action === 'uninstall') {
        const result = await api<ApiResult>(`/plugins/${current.id}/uninstall`, 'POST')
        setNotice(result.message)
      } else if (current.action === 'disable') {
        const result = await api<ApiResult>(`/plugins/${current.id}/disable`, {
          method: 'POST',
          body: { force: true },
        })
        setNotice(result.message)
      } else {
        const result = await api<ApiResult>(`/plugins/${current.id}/enable`, 'POST')
        setNotice(result.message)
      }
      setError(undefined)
      setErrorDetails(undefined)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setErrorDetails(caught instanceof ApiError ? caught.details : undefined)
    } finally {
      setBusy(false)
    }
  }, [pending, refresh])

  const openConfig = useCallback(async (plugin: MygoPluginRow): Promise<void> => {
    if (configPanel?.id === plugin.id) {
      setConfigPanel(undefined)
      return
    }
    setConfigPanel(undefined)
    try {
      const data = await api<ApiResult>(`/plugins/${plugin.id}/config`)
      const current = data.current ?? {}
      const fields = data.schema?.fields ?? []
      const editable: Record<string, unknown> = {}
      const base = isPlainObject(current) ? current : {}
      for (const field of fields) editable[field.name] = editableOf(field, base[field.name])
      setConfigPanel({
        id: plugin.id,
        current,
        ...(data.schema === undefined ? {} : { schema: data.schema }),
        ...(data.template === undefined ? {} : { template: data.template }),
        editable,
        mode: fields.length > 0 ? 'form' : 'json',
        text: JSON.stringify(current, null, 2),
        busy: false,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [configPanel])

  const saveConfig = useCallback(async (): Promise<void> => {
    const panel = configPanel
    if (panel === undefined) return
    setConfigPanel({ ...panel, busy: true, error: undefined, notice: undefined })
    try {
      const config = panel.mode === 'form' ? panel.editable : JSON.parse(panel.text) as unknown
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('配置必须是 JSON 对象')
      }
      await api<ApiResult>(`/plugins/${panel.id}/config`, { method: 'POST', body: { config } })
      setConfigPanel({ ...panel, busy: false, notice: '配置已更新（HMR 生效）' })
      void refresh()
    } catch (caught) {
      setConfigPanel({
        ...panel,
        busy: false,
        error: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }, [configPanel, refresh])

  const pollHelper = useCallback(async (): Promise<void> => {
    try {
      const status = await api<ApiResult>('/config-helper', {
        method: 'POST',
        body: { action: 'status' },
      })
      if (status.status === 'done') {
        if (helperTimer.current !== undefined) clearInterval(helperTimer.current)
        setHelperBusy(false)
        setHelper({
          status: 'done',
          ...(typeof status.startedAt === 'number' ? { startedAt: status.startedAt } : {}),
          ...(typeof status.runId === 'string' ? { runId: status.runId } : {}),
          messages: status.messages ?? [],
        })
      } else if (status.status === 'error' || status.status === 'stopped') {
        if (helperTimer.current !== undefined) clearInterval(helperTimer.current)
        setHelperBusy(false)
        setHelper({
          status: status.status,
          messages: status.messages ?? [],
          ...(status.error === undefined ? {} : { error: status.error }),
        })
      } else if (status.status === 'running') {
        setHelper(current => current === undefined
          ? { status: 'running', messages: status.messages ?? [] }
          : {
              ...current,
              status: 'running',
              ...(typeof status.startedAt === 'number' ? { startedAt: status.startedAt } : {}),
              messages: status.messages ?? current.messages,
            })
      }
    } catch (caught) {
      if (helperTimer.current !== undefined) clearInterval(helperTimer.current)
      setHelperBusy(false)
      setHelper(current => current === undefined
        ? undefined
        : {
            ...current,
            status: 'error',
            error: caught instanceof Error ? caught.message : String(caught),
          })
    }
  }, [])

  const startHelperPolling = useCallback((): void => {
    if (helperTimer.current !== undefined) clearInterval(helperTimer.current)
    helperTimer.current = setInterval(() => { void pollHelper() }, 2000)
  }, [pollHelper])

  const sendHelperMessage = useCallback(async (text: string): Promise<void> => {
    const content = text.trim()
    if (content === '') return
    setHelperBusy(true)
    setHelper(current => ({
      status: 'running',
      ...(current?.startedAt === undefined ? {} : { startedAt: current.startedAt }),
      messages: [...(current?.messages ?? []), { role: 'user' as const, content }],
      error: undefined,
    }))
    setHelperInput('')
    try {
      await api<ApiResult>('/config-helper', {
        method: 'POST',
        body: { action: 'chat', message: content },
      })
      startHelperPolling()
    } catch (caught) {
      setHelperBusy(false)
      setHelper(current => current === undefined
        ? undefined
        : {
            ...current,
            status: 'error',
            error: caught instanceof Error ? caught.message : String(caught),
          })
    }
  }, [startHelperPolling])

  const stopHelper = useCallback(async (): Promise<void> => {
    const current = helper
    if (current === undefined) return
    if (helperTimer.current !== undefined) {
      clearInterval(helperTimer.current)
      helperTimer.current = undefined
    }
    setHelperBusy(true)
    try {
      await api<ApiResult>('/config-helper', {
        method: 'POST',
        body: { action: 'stop' },
      })
      setHelperBusy(false)
      setHelper(undefined)
      setHelperOpen(false)
      setNotice('配置助手已关闭，记录已清空')
    } catch (caught) {
      setHelperBusy(false)
      setHelper({
        messages: current.messages,
        status: 'error',
        error: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }, [helper])

  // Re-open sync: after a refresh the server may still hold a running turn or
  // past messages; restore them instead of showing a stale idle panel.
  useEffect(() => {
    if (!helperOpen) return
    void (async () => {
      try {
        const status = await api<ApiResult>('/config-helper', {
          method: 'POST',
          body: { action: 'status' },
        })
        if (status.status === 'running') {
          setHelper(current => current === undefined
            ? { status: 'running', messages: status.messages ?? [] }
            : {
                ...current,
                status: 'running',
                ...(typeof status.startedAt === 'number' ? { startedAt: status.startedAt } : {}),
                messages: status.messages ?? current.messages,
              })
          startHelperPolling()
        } else if ((status.messages ?? []).length > 0) {
          setHelper(current => current === undefined || current.messages.length === 0
            ? { status: status.status as HelperPanelState['status'], messages: status.messages ?? [] }
            : current)
        }
      } catch {
        // server unreachable; keep the panel idle
      }
    })()
  }, [helperOpen, startHelperPolling])

  const appAct = useCallback(async (id: string, action: 'start' | 'stop'): Promise<void> => {
    setAppBusy(true)
    try {
      const result = await api<ApiResult>(`/apps/${id}/${action}`, 'POST')
      setAppNotice(result.message)
      setAppError(undefined)
      await refresh()
    } catch (caught) {
      setAppError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setAppBusy(false)
    }
  }, [refresh])

  const appUninstall = useCallback(async (row: MygoAppRow): Promise<void> => {
    const confirmed = window.confirm(
      `卸载外部应用 ${row.id} 只删除安装文件，不会保证停止进程或清理数据。确定继续？`,
    )
    if (!confirmed) return
    setAppBusy(true)
    try {
      const result = await api<ApiResult>(`/apps/${row.id}/uninstall`, 'POST')
      setAppNotice(result.message)
      setAppError(undefined)
      await refresh()
    } catch (caught) {
      setAppError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setAppBusy(false)
    }
  }, [refresh])

  const install = useCallback(async (): Promise<void> => {
    setInstalling(true)
    try {
      let config: unknown
      if (configText.trim() !== '') {
        config = JSON.parse(configText)
      }
      const endpoint = installAsApp ? '/api/mygo/apps/install' : '/api/mygo/install'
      const setup = setupText.split('&&').map(part => part.trim()).filter(part => part.length > 0)
      const startCommand = startCommandText.trim() === '' ? undefined : startCommandText.trim()
      const payload = installAsApp
        ? method === 'github'
          ? { method, url, ref, sandbox: appSandbox, setup, startCommand, skipBuild }
          : { method, path, sandbox: appSandbox, setup, startCommand, skipBuild }
        : method === 'github'
          ? { method, url, ref, config, installDeps }
          : method === 'bundle'
            ? { method, spec }
            : { method, path, config, installDeps }
      if (!installAsApp && method === 'bundle') {
        const result = await api<ApiResult & { readonly hostConflicts?: readonly string[] }>('/bundles/install', {
          method: 'POST',
          body: payload,
        })
        const plan = result.plan
        if (plan !== undefined
          && ((plan.warnings ?? []).length > 0
            || (result.hostConflicts ?? []).length > 0)) {
          setInstallPending({
            id: result.id ?? '',
            plan,
            payload: payload as Record<string, unknown>,
            ...(result.hostConflicts === undefined ? {} : { hostConflicts: result.hostConflicts }),
          })
          return
        }
        setNotice(result.message ?? 'bundle 已安装')
        setError(undefined)
        setErrorDetails(undefined)
        setSpec('')
        await refresh()
        return
      }
      if (!installAsApp) {
        const preview = await api<ApiResult>('/install-plan', {
          method: 'POST',
          body: payload,
        })
        const plan = preview.plan
        if (plan === undefined) throw new Error('install-plan 未返回计划')
        if (!plan.accepted) {
          setNotice(undefined)
          setError(`安装被拒：\n${plan.error?.message ?? '未知原因'}`)
          setErrorDetails(undefined)
          return
        }
        if (preview.configTemplate !== undefined && configText.trim() === '') {
          const template = JSON.stringify(preview.configTemplate, null, 2)
          setConfigText(template)
          payload.config = JSON.parse(template)
          setNotice('已按插件 schema 自动生成配置模板，可编辑后直接安装')
        }
        if ((plan.warnings ?? []).length === 0) {
          const result = await api<ApiResult>('/install', {
            method: 'POST',
            body: { ...payload },
          })
          setNotice(result.message ?? '插件已安装')
          setError(undefined)
          setErrorDetails(undefined)
          setUrl('')
          setRef('')
          setPath('')
          setConfigText('')
          setInstallDeps(false)
          setSetupText('')
          setStartCommandText('')
          setSkipBuild(false)
          await refresh()
          return
        }
        setInstallPending({ id: preview.id ?? '', plan, payload: payload as Record<string, unknown> })
        return
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as ApiResult & { readonly id?: string }
      if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (installAsApp) {
        setAppNotice(data.message ?? '外部应用已安装')
        setAppError(undefined)
      } else {
        setNotice(data.message ?? '插件已安装')
        setError(undefined)
      }
      setUrl('')
      setRef('')
      setPath('')
      setConfigText('')
      setInstallDeps(false)
      setInstallAsApp(false)
      setSetupText('')
      setStartCommandText('')
      setSkipBuild(false)
      await refresh()
    } catch (caught) {
      if (installAsApp) {
        setAppNotice(undefined)
        setAppError(caught instanceof Error ? caught.message : String(caught))
      } else {
        setNotice(undefined)
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setInstalling(false)
    }
  }, [method, url, ref, path, configText, installDeps, installAsApp, appSandbox, setupText, startCommandText, skipBuild, refresh])

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (installPending === undefined) return
    const current = installPending
    setInstallPending(undefined)
    setInstalling(true)
    try {
      const result = current.payload.method === 'bundle'
        ? ({ message: `bundle ${current.id} 已安装` } as ApiResult)
        : await api<ApiResult>('/install', {
            method: 'POST',
            body: { ...current.payload },
          })
      setNotice(result.message ?? '插件已安装')
      setError(undefined)
      setErrorDetails(undefined)
      setUrl('')
      setRef('')
      setSpec('')
      setPath('')
      setConfigText('')
      setInstallDeps(false)
      setSetupText('')
      setStartCommandText('')
      setSkipBuild(false)
      await refresh()
    } catch (caught) {
      setNotice(undefined)
      setError(caught instanceof Error ? caught.message : String(caught))
      setErrorDetails(caught instanceof ApiError ? caught.details : undefined)
    } finally {
      setInstalling(false)
    }
  }, [installPending, refresh])

  return (
    <div className={css.panel}>
      <div className={css.head}>
        <div className={css.title}>My 插件（mygo）</div>
        <button
          className={`${css.btn} ${css.btnGhost}`}
          disabled={updatesBusy}
          onClick={() => void checkUpdates()}
        >
          {updatesBusy ? '检查中…' : '检查更新'}
        </button>
        {notice !== undefined && <div className={css.status}>{notice}</div>}
        {error !== undefined && (
          <div ref={errorRef} className={css.statusError}>
            <div className={css.statusErrorTitle}>操作失败</div>
            <div>{error}</div>
            {highlighted.size > 0 && (
              <div className={css.statusErrorMeta}>
                涉及插件：{[...highlighted].sort().join('、')}（已在列表中高亮）
              </div>
            )}
          </div>
        )}
      </div>
      <div className={css.installBox}>
        <div className={css.installTitle}>安装插件</div>
        <div className={css.row}>
          {(['github', 'folder', 'archive'] as const).map(entry => (
            <button
              key={entry}
              className={method === entry ? `${css.btn} ${css.btnActive}` : `${css.btn} ${css.btnGhost}`}
              disabled={installing}
              onClick={() => { setMethod(entry); setError(undefined) }}
            >
              {entry === 'github' ? 'GitHub' : entry === 'folder' ? '文件夹' : '压缩包'}
            </button>
          ))}
          <button
            className={method === 'bundle' ? `${css.btn} ${css.btnActive}` : `${css.btn} ${css.btnGhost}`}
            disabled={installing}
            onClick={() => { setMethod('bundle'); setError(undefined) }}
          >
            Bundle
          </button>
        </div>
        {method === 'bundle' && (
          <div className={css.row}>
            <input
              className={css.input}
              placeholder="bundle spec，如 @pkg/name@^1.0.0 或 github:owner/repo#ref"
              value={spec}
              disabled={installing}
              onChange={event => setSpec(event.target.value)}
            />
          </div>
        )}
        {method === 'github' && (
          <div className={css.row}>
            <input
              className={css.input}
              placeholder="https://github.com/xxx/yyy"
              value={url}
              disabled={installing}
              onChange={event => setUrl(event.target.value)}
            />
            <input
              className={css.input}
              placeholder="分支（可选）"
              value={ref}
              disabled={installing}
              onChange={event => setRef(event.target.value)}
            />
          </div>
        )}
        {(method === 'folder' || method === 'archive') && (
          <div className={css.row}>
            <input
              className={css.input}
              placeholder={method === 'folder' ? '/绝对/路径/插件目录' : '/绝对/路径/插件.zip 或 .tar.gz'}
              value={path}
              disabled={installing}
              onChange={event => setPath(event.target.value)}
            />
          </div>
        )}
        <div className={css.row}>
          <input
            className={css.input}
            placeholder='可选：插件配置 JSON，如 {"baseURL":"http://127.0.0.1:11434/v1"}'
            value={configText}
            disabled={installing}
            onChange={event => setConfigText(event.target.value)}
          />
        </div>
        <label className={css.depsRow}>
          <input
            type="checkbox"
            checked={installDeps}
            disabled={installing}
            onChange={event => setInstallDeps(event.target.checked)}
          />
          <span>自动安装依赖并构建（npm install + npm run build）</span>
        </label>
        <label className={css.depsRow}>
          <input
            type="checkbox"
            checked={installAsApp}
            disabled={installing}
            onChange={event => setInstallAsApp(event.target.checked)}
          />
          <span>安装为外部应用（非 Cordis 插件，独立进程）</span>
        </label>
        {installAsApp && (
          <>
            <label className={css.depsRow}>
              <input
                type="checkbox"
                checked={skipBuild}
                disabled={installing}
                onChange={event => setSkipBuild(event.target.checked)}
              />
              <span>跳过构建（构建不稳定或使用 dev 模式时勾选）</span>
            </label>
            <label className={css.depsRow}>
              <span>沙箱：</span>
              <select
                className={css.input}
                value={appSandbox}
                disabled={installing}
                onChange={event => setAppSandbox(event.target.value as 'none' | 'workspace')}
              >
                <option value="none">none（与手动运行一致）</option>
                <option value="workspace">workspace（仅应用目录可写）</option>
              </select>
            </label>
            <div className={css.row}>
              <input
                className={css.input}
                placeholder="安装前准备命令（可选，&& 分隔），如 node scripts/build-db.ts"
                value={setupText}
                disabled={installing}
                onChange={event => setSetupText(event.target.value)}
              />
            </div>
            <div className={css.row}>
              <input
                className={css.input}
                placeholder="启动命令（可选，默认 start/dev 脚本），如 python3 -m http.server 3000 --directory out"
                value={startCommandText}
                disabled={installing}
                onChange={event => setStartCommandText(event.target.value)}
              />
            </div>
          </>
        )}
        <div className={css.row}>
          <button className={css.btn} disabled={installing} onClick={() => void (installPending === undefined ? install() : confirmInstall())}>
            {installing ? '安装中…' : installPending === undefined ? '安装' : '确认安装'}
          </button>
        </div>
        {installPending !== undefined && (
          <div className={css.inlineConfirm}>
            <div className={css.inlineTitle}>安装 {installPending.id}</div>
            {installPending.plan.error !== undefined && (
              <div className={css.inlineError}>{installPending.plan.error.message}</div>
            )}
            {installPending.plan.warnings !== undefined && installPending.plan.warnings.length > 0 && (
              <div className={css.inlineWarnings}>
                {installPending.plan.warnings.map((warning, index) => <div key={index}>! {warning}</div>)}
              </div>
            )}
            {installPending.hostConflicts !== undefined && installPending.hostConflicts.length > 0 && (
              <div className={css.inlineWarnings}>
                {installPending.hostConflicts.map((conflict, index) => <div key={index}>! 宿主行改写：{conflict}（停用/卸载会还原）</div>)}
              </div>
            )}
            <div className={css.inlineActions}>
              <button className={`${css.btn} ${css.btnGhost}`} disabled={installing} onClick={() => setInstallPending(undefined)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
      <div className={css.head}>
        <div className={css.title}>My 插件</div>
        <button
          className={`${css.btn} ${css.btnGhost}`}
          disabled={helperBusy}
          onClick={() => setHelperOpen(!helperOpen)}
        >
          配置助手 {helperOpen ? '收起' : '展开'}
        </button>
      </div>
      {helperOpen && (
        <div className={css.helperPanel}>
          <div className={css.helperHeader}>
            <div className={css.inlineTitle}>配置助手</div>
            <button
              className={`${css.btn} ${css.btnGhost}`}
              disabled={helperBusy}
              onClick={() => void stopHelper()}
            >
              关闭并清空记录
            </button>
          </div>
          <div className={css.helperChat} ref={helperChatRef}>
            {(helper?.messages ?? []).map((message, index) => (
              <div key={index} className={message.role === 'user' ? css.helperBubbleUser : css.helperBubbleAssistant}>
                {message.role === 'user' ? null : <div className={css.helperBubbleRole}>配置助手</div>}
                <div className={css.helperBubbleText}>{message.content}</div>
              </div>
            ))}
            {helper?.status === 'running' && (
              <div className={`${css.helperBubbleAssistant} ${css.helperTyping}`}>
                <span className={css.helperDot} />
                <span className={css.helperDot} />
                <span className={css.helperDot} />
              </div>
            )}
            {(helper?.messages ?? []).length === 0 && helper?.status === undefined && (
              <div className={css.helperEmpty}>
                <div className={css.inlineText}>不用先选插件，直接输入需求，例如：</div>
                {HELPER_EXAMPLES.map((example, index) => (
                  <button
                    key={index}
                    className={`${css.btn} ${css.btnGhost}`}
                    disabled={helperBusy}
                    onClick={() => setHelperInput(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
          </div>
          {helper?.status === 'error' && <div className={css.inlineError}>助手错误：{helper.error ?? '未知'}</div>}
          <div className={css.helperInputRow}>
            <textarea
              className={css.helperInput}
              rows={2}
              placeholder="输入需求，例如：帮我看看 dsh-stickers 的配置 / 安装 xxx 仓库…"
              value={helperInput}
              disabled={helperBusy || helper?.status === 'running'}
              onChange={(event) => setHelperInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (helper?.status !== 'running') {
                    void sendHelperMessage(helperInput)
                  }
                }
              }}
            />
            <button
              className={css.helperSend}
              disabled={helperBusy || helper?.status === 'running' || helperInput.trim() === ''}
              onClick={() => void sendHelperMessage(helperInput)}
            >
              发送
            </button>
          </div>
        </div>
      )}
      {plugins === null
        ? <div className={css.status}>加载中…</div>
        : plugins.length === 0
          ? <div className={css.status}>暂无 My 插件</div>
          : plugins.map((plugin) => (
              <div key={plugin.id} className={css.itemWrap}>
                <div
                  className={highlighted.has(plugin.id) ? `${css.item} ${css.itemBlocked}` : css.item}
                >
                  <div className={css.itemBody}>
                    <div className={css.itemId}>{plugin.id}</div>
                    <div className={css.itemMeta}>
                      v{plugin.version} · {plugin.origin} · gen {plugin.generation}
                      {plugin.rail === 'bundle' ? ' · profile bundle' : ''}
                    </div>
                    {plugin.hostConflicts !== undefined && plugin.hostConflicts.length > 0 && (
                      <div className={css.bundleHostWarning}>
                        宿主行改写：{plugin.hostConflicts.join('；')}（停用/卸载会还原）
                      </div>
                    )}
                  </div>
                  <div className={css.itemActions}>
                    <span className={plugin.status === 'enabled' ? `${css.pill} ${css.pillOn}` : css.pill}>
                      {STATUS_LABEL[plugin.status] ?? plugin.status}
                    </span>
                    {plugin.rail === 'bundle' && <span className={css.pill}>bundle</span>}
                    <button
                      className={`${css.btn} ${css.btnGhost}`}
                      disabled={busy}
                      onClick={() => {
                        const requested = plugin.status === 'enabled' ? 'disable' : 'enable'
                        if (pending?.id === plugin.id && pending.action === requested) {
                          void confirmPending()
                        } else {
                          void act(plugin.id, requested)
                        }
                      }}
                    >
                      {pending?.id === plugin.id && pending.action === 'disable'
                        ? '确认停用'
                        : pending?.id === plugin.id && pending.action === 'enable'
                          ? '确认启用'
                          : plugin.status === 'enabled' ? '停用' : '启用'}
                    </button>
                    {plugin.rail !== 'bundle' && (
                      <button
                        className={`${css.btn} ${css.btnGhost}`}
                        disabled={busy}
                        onClick={() => void openConfig(plugin)}
                      >
                        {configPanel?.id === plugin.id ? '收起配置' : '配置'}
                      </button>
                    )}
                    {plugin.rail !== 'bundle' && (
                      <button
                        className={`${css.btn} ${css.btnGhost}`}
                        disabled={busy || helperBusy}
                        onClick={() => {
                          setHelperOpen(true)
                          setHelper({ messages: [] })
                          setHelperInput(`帮我看看 ${plugin.id} 的配置`)
                          setNotice(undefined)
                        }}
                      >
                        助手
                      </button>
                    )}
                    <button
                      className={`${css.btn} ${css.btnDanger}`}
                      disabled={busy}
                      onClick={() => {
                        if (pending?.id === plugin.id && pending.action === 'uninstall') {
                          void confirmPending()
                        } else {
                          void act(plugin.id, 'uninstall')
                        }
                      }}
                    >
                      {pending?.id === plugin.id && pending.action === 'uninstall' ? '确认卸载' : '卸载'}
                    </button>
                  </div>
                </div>
                {pending?.id === plugin.id && (
                  <div className={css.inlineConfirm}>
                    {pending.action === 'uninstall' && (
                      <div className={css.inlineText}>
                        将删除安装目录与桥接行，且面板无法恢复该插件。确认卸载 {plugin.id}？
                      </div>
                    )}
                    {pending.action !== 'uninstall' && pending.plan?.error !== undefined && (
                      <div className={css.inlineError}>{pending.plan.error.message}</div>
                    )}
                    {pending.action !== 'uninstall' && pending.plan?.warnings !== undefined
                      && pending.plan.warnings.length > 0 && (
                        <div className={css.inlineWarnings}>
                          {pending.plan.warnings.map((warning, index) => <div key={index}>! {warning}</div>)}
                        </div>
                      )}
                    <div className={css.inlineActions}>
                      <button className={`${css.btn} ${css.btnGhost}`} disabled={busy} onClick={() => setPending(undefined)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {configPanel?.id === plugin.id && (
                  <div className={css.inlineConfirm}>
                    <div className={css.inlineTitle}>配置 · {plugin.id}</div>
                    {configPanel.schema?.description !== undefined && configPanel.schema.description !== '' && (
                      <div className={css.inlineText}>schema：{configPanel.schema.description}</div>
                    )}
                    <div className={css.inlineActions}>
                      <button
                        className={`${css.btn} ${css.btnGhost}`}
                        disabled={configPanel.busy}
                        onClick={() => setConfigPanel({
                          ...configPanel,
                          mode: configPanel.mode === 'form' ? 'json' : 'form',
                          error: undefined,
                          notice: undefined,
                        })}
                      >
                        {configPanel.mode === 'form' ? 'JSON 模式' : '表单模式'}
                      </button>
                    </div>
                    {configPanel.mode === 'form' && configPanel.schema?.fields !== undefined
                      && configPanel.schema.fields.length > 0 && (
                        <div className={css.configFields}>
                          {configPanel.schema.fields.map(field => (
                            <ConfigFieldEditor
                              key={field.name}
                              field={field}
                              value={configPanel.editable[field.name]}
                              onChange={(next) => setConfigPanel({
                                ...configPanel,
                                editable: { ...configPanel.editable, [field.name]: next },
                                error: undefined,
                                notice: undefined,
                              })}
                            />
                          ))}
                        </div>
                      )}
                    {configPanel.mode === 'json' && (
                      <textarea
                        className={css.configTextarea}
                        value={configPanel.text}
                        disabled={configPanel.busy}
                        rows={8}
                        spellCheck={false}
                        onChange={(event) => setConfigPanel({
                          ...configPanel,
                          text: event.target.value,
                          error: undefined,
                          notice: undefined,
                        })}
                      />
                    )}
                    {configPanel.mode === 'form' && configPanel.schema?.fields !== undefined
                      && configPanel.schema.fields.length === 0 && (
                        <div className={css.inlineText}>插件未暴露可表单化的字段，请使用 JSON 模式编辑。</div>
                      )}
                    {configPanel.error !== undefined && <div className={css.inlineError}>{configPanel.error}</div>}
                    {configPanel.notice !== undefined && <div className={css.inlineText}>{configPanel.notice}</div>}
                    <div className={css.inlineActions}>
                      <button className={`${css.btn} ${css.btnGhost}`} disabled={configPanel.busy} onClick={() => void saveConfig()}>
                        保存配置
                      </button>
                      <button
                        className={`${css.btn} ${css.btnGhost}`}
                        disabled={configPanel.busy}
                        onClick={() => setConfigPanel(undefined)}
                      >
                        收起
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
      <div className={css.head}>
        <div className={css.title}>外部应用</div>
        {appNotice !== undefined && <div className={css.status}>{appNotice}</div>}
        {appError !== undefined && <div className={css.statusError}>{appError}</div>}
      </div>
      {apps === null
        ? <div className={css.status}>加载中…</div>
        : apps.length === 0
          ? <div className={css.status}>暂无外部应用</div>
          : apps.map((app) => (
              <div key={app.id} className={css.item}>
                <div className={css.itemBody}>
                  <div className={css.itemId}>{app.id}</div>
                  <div className={css.itemMeta}>
                    外部应用 · {app.startCommand} · 沙箱 {app.sandbox} · 卸载不同步
                  </div>
                </div>
                <div className={css.itemActions}>
                  <span className={app.running ? `${css.pill} ${css.pillOn}` : css.pill}>
                    {app.running ? '运行中' : '已停止'}
                  </span>
                  <button
                    className={`${css.btn} ${css.btnGhost}`}
                    disabled={appBusy}
                    onClick={() => void appAct(app.id, app.running ? 'stop' : 'start')}
                  >
                    {app.running ? '停止' : '启动'}
                  </button>
                  <button
                    className={`${css.btn} ${css.btnDanger}`}
                    disabled={appBusy}
                    onClick={() => void appUninstall(app)}
                  >
                    卸载
                  </button>
                </div>
              </div>
            ))}
      <div className={css.head}>
        <div className={css.title}>远程更新</div>
        {updatesMessage !== undefined && <div className={css.status}>{updatesMessage}</div>}
      </div>
      {updates !== null && (
        updates.length === 0
          ? <div className={css.status}>暂无远程安装的插件/应用</div>
          : updates.map((row) => (
              <div key={`${row.kind}:${row.id}`} className={css.item}>
                <div className={css.itemBody}>
                  <div className={css.itemId}>{row.id}</div>
                  <div className={css.itemMeta}>
                    {row.kind === 'plugin' ? '插件' : row.kind === 'app' ? '外部应用' : 'mygo 自身'} · {row.currentCommit.slice(0, 8)}
                    {row.latestCommit !== undefined && ` → ${row.latestCommit.slice(0, 8)}`}
                  </div>
                </div>
                <div className={css.itemActions}>
                  {row.error !== undefined
                    ? <span className={css.pill}>{row.error}</span>
                    : row.upToDate === true
                      ? <span className={`${css.pill} ${css.pillOn}`}>已最新</span>
                      : (
                        <>
                          <span className={css.pill}>可更新</span>
                          <button
                            className={`${css.btn} ${css.btnGhost}`}
                            disabled={updatesBusy}
                            onClick={() => void performUpdate(row)}
                          >
                            更新
                          </button>
                        </>
                      )}
                </div>
              </div>
            ))
      )}
    </div>
  )
}
