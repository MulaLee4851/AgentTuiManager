import { useEffect, useMemo, useState } from 'react'

import type { AuditCategory, AuditEntry, AuditLevel, SessionSummary } from './shared/manager-api'

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  session: '会话', approval: '授权', recovery: '恢复', rule: '规则', remote: '远程',
}

const LEVEL_LABEL: Record<AuditLevel, string> = {
  info: '信息', warning: '提醒', error: '错误',
}

type AuditTimeRange = 'all' | '24h' | '7d' | '30d'
const AUDIT_PAGE_SIZE = 50

function detailText(entry: AuditEntry, key: string): string | undefined {
  const value = entry.details?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function normalizedWorkspace(value: string): string {
  return value.replace(/\//g, '\\').replace(/[\\]+$/, '').toLocaleLowerCase('en-US')
}

export default function AuditPage({ sessions = [] }: { sessions?: SessionSummary[] }): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [level, setLevel] = useState<AuditLevel | 'all'>('all')
  const [workspace, setWorkspace] = useState('all')
  const [agent, setAgent] = useState('all')
  const [timeRange, setTimeRange] = useState<AuditTimeRange>('all')
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState(1)

  const reload = async (): Promise<void> => {
    try { setEntries(await window.agentManager.listAuditEntries()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  useEffect(() => {
    void reload()
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.agentManager.subscribe((event) => {
      if (event.type !== 'audit-changed') return
      if (reloadTimer) return
      reloadTimer = setTimeout(() => { reloadTimer = undefined; void reload() }, 250)
    })
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      unsubscribe()
    }
  }, [])

  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.sessionId, session])), [sessions])
  const decorated = useMemo(() => entries.map((entry) => {
    const session = entry.sessionId ? sessionById.get(entry.sessionId) : undefined
    return {
      entry,
      displayName: detailText(entry, 'displayName') ?? session?.displayName,
      workspace: detailText(entry, 'workspace') ?? session?.workspace,
    }
  }), [entries, sessionById])
  const workspaceOptions = useMemo(() => {
    const unique = new Map<string, string>()
    for (const item of decorated) if (item.workspace) unique.set(normalizedWorkspace(item.workspace), item.workspace)
    return [...unique.entries()].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
  }, [decorated])
  const agentOptions = useMemo(() => {
    const unique = new Map<string, string>()
    for (const item of decorated) if (item.entry.sessionId) unique.set(item.entry.sessionId, item.displayName ?? `会话 ${item.entry.sessionId.slice(0, 8)}`)
    return [...unique.entries()].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
  }, [decorated])
  const filtered = useMemo(() => {
    const duration = timeRange === '24h' ? 86_400_000 : timeRange === '7d' ? 604_800_000 : timeRange === '30d' ? 2_592_000_000 : undefined
    const cutoff = duration ? Date.now() - duration : undefined
    return decorated.filter((item) => (category === 'all' || item.entry.category === category)
      && (level === 'all' || item.entry.level === level)
      && (workspace === 'all' || Boolean(item.workspace && normalizedWorkspace(item.workspace) === workspace))
      && (agent === 'all' || item.entry.sessionId === agent)
      && (cutoff === undefined || item.entry.timestamp >= cutoff))
  }, [agent, category, decorated, level, timeRange, workspace])
  const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleEntries = useMemo(() => filtered.slice((currentPage - 1) * AUDIT_PAGE_SIZE, currentPage * AUDIT_PAGE_SIZE), [currentPage, filtered])
  const selected = visibleEntries.find((item) => item.entry.id === selectedId) ?? visibleEntries[0]
  useEffect(() => { setPage(1); setSelectedId(undefined) }, [agent, category, level, timeRange, workspace])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const copySelected = async (): Promise<void> => {
    if (!selected) return
    try { await window.agentManager.writeClipboardText(JSON.stringify(selected.entry, null, 2)); setNotice('已复制审计详情') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const exportFiltered = async (): Promise<void> => {
    setExporting(true); setError(''); setNotice('')
    try {
      const path = await window.agentManager.exportAuditEntries(filtered.map((item) => item.entry.id))
      if (path) setNotice('已导出到 ' + path)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setExporting(false) }
  }

  return <section className="audit-page">
    <header className="audit-header">
      <div><span className="eyebrow">ACTIVITY</span><h2>活动记录</h2><p>启动、停止、恢复、授权与规则变更都会留在这里。</p></div>
      <div className="audit-filters">
        <label className="audit-filter-wide">工作区<select aria-label="审计工作区" value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="all">全部工作区</option>{workspaceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="audit-filter-wide">Agent<select aria-label="审计 Agent" value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">全部 Agent</option>{agentOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>类别<select aria-label="审计类别" value={category} onChange={(event) => setCategory(event.target.value as AuditCategory | 'all')}><option value="all">全部</option>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>级别<select aria-label="审计级别" value={level} onChange={(event) => setLevel(event.target.value as AuditLevel | 'all')}><option value="all">全部</option>{Object.entries(LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>时间<select aria-label="审计时间" value={timeRange} onChange={(event) => setTimeRange(event.target.value as AuditTimeRange)}><option value="all">全部时间</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select></label>
        <button type="button" className="button-secondary" disabled={exporting || filtered.length === 0} onClick={() => { void exportFiltered() }}>{exporting ? '请稍后…' : '导出'}</button>
        <button type="button" className="button-secondary" onClick={() => { void reload() }}>刷新</button>
      </div>
    </header>
    {error && <p className="form-error">读取审计记录失败：{error}</p>}
    {notice && <p className="audit-notice">{notice}</p>}
    <div className="audit-workbench"><div className="audit-list">
      {filtered.length === 0 ? <div className="audit-empty">还没有符合条件的活动记录</div> : visibleEntries.map(({ entry, displayName, workspace: entryWorkspace }) => <article className={`audit-row audit-${entry.level}${selected?.entry.id === entry.id ? ' active' : ''}`} key={entry.id} onClick={() => setSelectedId(entry.id)}>
        <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time>
        <span className="audit-category">{CATEGORY_LABEL[entry.category]}</span>
        <div><strong>{entry.message}</strong><small>{[displayName, entryWorkspace, entry.action].filter(Boolean).join(' · ')}</small>{(detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')) && <code>{detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')}</code>}</div>
        <span className="audit-level">{LEVEL_LABEL[entry.level]}</span>
      </article>)}
      {filtered.length > AUDIT_PAGE_SIZE && <nav className="audit-pagination" aria-label="审计分页"><span>共 {filtered.length} 条 · 第 {currentPage}/{pageCount} 页</span><div><button className="button-secondary button-compact" type="button" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><button className="button-secondary button-compact" type="button" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button></div></nav>}
    </div>{selected && <aside className="audit-detail"><header><div><span className="eyebrow">{CATEGORY_LABEL[selected.entry.category]} · {LEVEL_LABEL[selected.entry.level]}</span><h3>{selected.entry.message}</h3></div><button type="button" className="button-secondary button-compact" onClick={() => { void copySelected() }}>复制详情</button></header><dl><div><dt>时间</dt><dd>{new Date(selected.entry.timestamp).toLocaleString()}</dd></div><div><dt>Agent</dt><dd>{selected.displayName ?? '全局事件'}</dd></div><div><dt>会话</dt><dd>{selected.entry.sessionId ?? '—'}</dd></div><div><dt>工作区</dt><dd>{selected.workspace ?? '—'}</dd></div><div><dt>动作</dt><dd>{selected.entry.action}</dd></div></dl><div className="audit-detail-fields">{Object.entries(selected.entry.details ?? {}).map(([key, value]) => <div key={key}><strong>{key}</strong><code>{String(value)}</code></div>)}</div></aside>}</div>
  </section>
}
