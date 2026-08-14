/**
 * mygo 配置卡片（r7 视觉统一）：settings.plugin.item 槽的聚合卡片——
 * 枚举有 Config schema 的受管插件（/api/mygo/config-cards），逐插件渲染
 * 通用配置表单（ConfigFields），保存经 /api/mygo/config（bridge 走 HMR、
 * bundle 写 profile patch 层由宿主 watcher 重载）；附整 profile 配置的
 * 导出/导入（/api/mygo/config-export|config-import）。
 * @module @r05en1cu/dsh-mygo-ext-panel/client/ConfigCards
 */
import { useCallback, useEffect, useState } from 'react'
import css from './Panel.module.css'
import { ConfigFieldEditor, editableOf, type ConfigFieldShape } from './ConfigFields'

/** config-cards API 返回的一张卡片。 */
interface ConfigCardRow {
  readonly id: string
  readonly kind: 'bridge' | 'bundle'
  readonly rowId: string
  readonly packageName: string
  readonly schema: {
    readonly description: string
    readonly fields: readonly ConfigFieldShape[]
    readonly template: unknown
  }
  readonly config: unknown
  readonly enabled: boolean
}

interface CardsResult {
  readonly ok: boolean
  readonly error?: string
  readonly cards?: readonly ConfigCardRow[]
}

interface ActionResult {
  readonly ok: boolean
  readonly error?: string
  readonly message?: string
  readonly applied?: readonly string[]
  readonly rejected?: readonly { readonly id: string; readonly reason: string }[]
}

async function fetchJson<T>(path: string, init?: { readonly method?: string; readonly body?: unknown }): Promise<T> {
  const res = await fetch('/api/mygo' + path, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  return (await res.json()) as T
}

function PluginConfigCard(props: {
  readonly card: ConfigCardRow
  readonly onSaved: () => void
}): JSX.Element {
  const { card, onSaved } = props
  const [draft, setDraft] = useState<unknown>(() => {
    const out: Record<string, unknown> = {}
    for (const field of card.schema.fields) {
      out[field.name] = editableOf(field, (card.config as Record<string, unknown> | undefined)?.[field.name])
    }
    return out
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setMessage(undefined)
    setError(undefined)
    try {
      const result = await fetchJson<ActionResult>('/config', {
        method: 'PUT',
        body: { id: card.id, kind: card.kind, rowId: card.rowId, config: draft },
      })
      if (!result.ok) throw new Error(result.error ?? '保存失败')
      setMessage(result.message ?? '已保存')
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }, [card.id, card.kind, card.rowId, draft, onSaved])
  return (
    <div className={css.card}>
      <div className={css.cardBody}>
        <div className={css.cardMain}>
          <div className={css.cardTitleRow}>
            <div className={css.cardTitle}>{card.id}</div>
            <div className={css.cardBadges}>
              <span className={css.railChip}>{card.kind}</span>
              {card.enabled
                ? <span className={css.badge + ' ' + css.badgeOk}><span className={css.badgeDot} />已启用</span>
                : <span className={css.badge + ' ' + css.badgeOff}><span className={css.badgeDot} />已停用</span>}
            </div>
          </div>
          <div className={css.cardMeta}>
            <span className={css.metaChip}>{card.packageName}</span>
          </div>
          {card.schema.description !== '' && <div className={css.fieldHint}>{card.schema.description}</div>}
          <div className={css.configFields}>
            {card.schema.fields.map(field => (
              <ConfigFieldEditor
                key={field.name}
                field={field}
                value={(draft as Record<string, unknown>)[field.name]}
                onChange={(next) => setDraft({ ...(draft as Record<string, unknown>), [field.name]: next })}
              />
            ))}
          </div>
        </div>
      </div>
      <div className={css.details}>
        <div className={css.rowInline}>
          <button className={css.btn + ' ' + css.btnSm} disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          {message !== undefined && <span className={css.fieldHint}>{message}</span>}
          {error !== undefined && <span className={css.fieldError}>{error}</span>}
        </div>
      </div>
    </div>
  )
}

/** settings.plugin.item 槽的聚合配置卡片（r6；r7 视觉统一）。 */
export function MygoConfigCards(): JSX.Element {
  const [cards, setCards] = useState<readonly ConfigCardRow[] | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchJson<CardsResult>('/config-cards')
      setCards(result.cards ?? [])
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const doImport = useCallback(async (): Promise<void> => {
    setImporting(true)
    setNotice(undefined)
    setError(undefined)
    try {
      const parsed: unknown = JSON.parse(importText)
      const result = await fetchJson<ActionResult>('/config-import', { method: 'PUT', body: parsed })
      if (!result.ok) {
        setError(`导入部分失败：${(result.rejected ?? []).map(entry => entry.id + '（' + entry.reason + '）').join('；') || result.error}`)
        return
      }
      setNotice(result.message ?? '导入完成')
      setImportText('')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setImporting(false)
    }
  }, [importText, refresh])

  return (
    <div className={css.panel}>
      <div className={css.head}>
        <div className={css.title}>mygo 插件配置</div>
      </div>
      <div className={css.fieldHint}>有 Config schema 的受管插件直接出现在这里；无 Config 的插件不列。</div>
      {error !== undefined && <div className={css.fieldError}>{error}</div>}
      {cards === null
        ? (
          <div className={css.list}>
            {[0, 1].map(index => <div key={index} className={css.skeletonRow} />)}
          </div>
        )
        : cards.length === 0
          ? (
            <div className={css.listEmpty}>
              <div className={css.emptyTitle}>暂无可配置插件</div>
              <div className={css.emptyText}>受管插件未暴露 Config schema 时不列在这里。</div>
            </div>
          )
          : (
            <div className={css.list}>
              {cards.map(card => <PluginConfigCard key={card.id} card={card} onSaved={() => void refresh()} />)}
            </div>
          )}
      <div className={css.head}>
        <div className={css.title}>配置导入导出（整 profile）</div>
      </div>
      <div className={css.installCard}>
        <div className={css.rowInline}>
          <a className={css.btn + ' ' + css.btnGhost + ' ' + css.btnSm} href="/api/mygo/config-export" download="mygo-configs.json">
            导出全部配置（JSON）
          </a>
        </div>
        <textarea
          className={css.configTextarea}
          rows={4}
          spellCheck={false}
          placeholder='粘贴导出的 JSON（{"format":"dsh.mygo-configs/v1","configs":{...}}）后导入'
          value={importText}
          onChange={event => setImportText(event.target.value)}
        />
        <div className={css.rowInline}>
          <button className={css.btn + ' ' + css.btnSm} disabled={importing || importText.trim() === ''} onClick={() => void doImport()}>
            {importing ? '导入中…' : '导入配置'}
          </button>
          {notice !== undefined && <span className={css.fieldHint}>{notice}</span>}
        </div>
      </div>
    </div>
  )
}
