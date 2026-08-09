import { useCallback, useEffect, useState } from 'react'
import css from './Panel.module.css'

export interface MygoPluginRow {
  readonly id: string
  readonly version: string
  readonly status: string
  readonly origin: string
  readonly generation: number
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

interface ApiResult {
  readonly ok: boolean
  readonly error?: string
  readonly message?: string
  readonly plugins?: readonly MygoPluginRow[]
  readonly apps?: readonly MygoAppRow[]
  readonly updates?: readonly RemoteUpdateRow[]
}

async function api<T extends ApiResult>(path: string, method = 'GET'): Promise<T> {
  const res = await fetch('/api/mygo' + path, { method })
  const data = (await res.json()) as T
  if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

const STATUS_LABEL: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  quarantined: '隔离',
  shadowed: '遮蔽',
}

export function Panel(): JSX.Element {
  const [plugins, setPlugins] = useState<readonly MygoPluginRow[] | null>(null)
  const [apps, setApps] = useState<readonly MygoAppRow[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [appError, setAppError] = useState<string | undefined>()
  const [appNotice, setAppNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [appBusy, setAppBusy] = useState(false)
  const [updates, setUpdates] = useState<readonly RemoteUpdateRow[] | null>(null)
  const [updatesBusy, setUpdatesBusy] = useState(false)
  const [updatesMessage, setUpdatesMessage] = useState<string | undefined>()
  const [method, setMethod] = useState<'github' | 'folder' | 'archive'>('github')
  const [url, setUrl] = useState('')
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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api<ApiResult>('/plugins')
      setPlugins(result.plugins ?? [])
      setError(undefined)
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
    setBusy(true)
    try {
      const result = await api<ApiResult>(`/plugins/${id}/${action}`, 'POST')
      setNotice(result.message)
      setError(undefined)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [refresh])

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
          : { method, path, config, installDeps }
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

  return (
    <div className={css.panel}>
      <div className={css.head}>
        <div className={css.title}>受管插件（mygo）</div>
        <button
          className={`${css.btn} ${css.btnGhost}`}
          disabled={updatesBusy}
          onClick={() => void checkUpdates()}
        >
          {updatesBusy ? '检查中…' : '检查更新'}
        </button>
        {notice !== undefined && <div className={css.status}>{notice}</div>}
        {error !== undefined && <div className={css.statusError}>{error}</div>}
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
        </div>
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
          <button className={css.btn} disabled={installing} onClick={() => void install()}>
            {installing ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
      {plugins === null
        ? <div className={css.status}>加载中…</div>
        : plugins.length === 0
          ? <div className={css.status}>暂无受管插件</div>
          : plugins.map((plugin) => (
              <div key={plugin.id} className={css.item}>
                <div className={css.itemBody}>
                  <div className={css.itemId}>{plugin.id}</div>
                  <div className={css.itemMeta}>
                    v{plugin.version} · {plugin.origin} · gen {plugin.generation}
                  </div>
                </div>
                <div className={css.itemActions}>
                  <span className={plugin.status === 'enabled' ? `${css.pill} ${css.pillOn}` : css.pill}>
                    {STATUS_LABEL[plugin.status] ?? plugin.status}
                  </span>
                  <button
                    className={`${css.btn} ${css.btnGhost}`}
                    disabled={busy}
                    onClick={() => void act(plugin.id, plugin.status === 'enabled' ? 'disable' : 'enable')}
                  >
                    {plugin.status === 'enabled' ? '停用' : '启用'}
                  </button>
                  <button
                    className={`${css.btn} ${css.btnDanger}`}
                    disabled={busy}
                    onClick={() => void act(plugin.id, 'uninstall')}
                  >
                    卸载
                  </button>
                </div>
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
