import { useEffect, useMemo, useState } from 'react'

import type { AuditCategory, AuditEntry, AuditLevel, SessionSummary } from './shared/manager-api'

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  session: '会话', approval: '授权', recovery: '恢复', rule: '规则',
}

const LEVEL_LABEL: Record<AuditLevel, string> = {
  info: '信息', warning: '提醒', error: '错误',
}

type AuditTimeRange = 'all' | '24h' | '7d' | '30d'

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

  const reload = async (): Promise<void> => {
    try { setEntries(await window.agentManager.listAuditEntries()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  useEffect(() => {
    void reload()
    return window.agentManager.subscribe((event) => { if (event.type === 'audit-changed') void reload() })
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

  return <section className="audit-page">
    <header className="audit-header">
      <div><span className="eyebrow">ACTIVITY</span><h2>活动记录</h2><p>启动、停止、恢复、授权与规则变更都会留在这里。</p></div>
      <div className="audit-filters">
        <label className="audit-filter-wide">工作区<select aria-label="审计工作区" value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="all">全部工作区</option>{workspaceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="audit-filter-wide">Agent<select aria-label="审计 Agent" value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">全部 Agent</option>{agentOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>类别<select aria-label="审计类别" value={category} onChange={(event) => setCategory(event.target.value as AuditCategory | 'all')}><option value="all">全部</option>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>级别<select aria-label="审计级别" value={level} onChange={(event) => setLevel(event.target.value as AuditLevel | 'all')}><option value="all">全部</option>{Object.entries(LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>时间<select aria-label="审计时间" value={timeRange} onChange={(event) => setTimeRange(event.target.value as AuditTimeRange)}><option value="all">全部时间</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select></label>
        <button type="button" className="button-secondary" onClick={() => { void reload() }}>刷新</button>
      </div>
    </header>
    {error && <p className="form-error">读取审计记录失败：{error}</p>}
    <div className="audit-list">
      {filtered.length === 0 ? <div className="audit-empty">还没有符合条件的活动记录</div> : filtered.map(({ entry, displayName, workspace: entryWorkspace }) => <article className={`audit-row audit-${entry.level}`} key={entry.id}>
        <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time>
        <span className="audit-category">{CATEGORY_LABEL[entry.category]}</span>
        <div><strong>{entry.message}</strong><small>{[displayName, entryWorkspace, entry.action].filter(Boolean).join(' · ')}</small>{(detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')) && <code>{detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')}</code>}</div>
        <span className="audit-level">{LEVEL_LABEL[entry.level]}</span>
      </article>)}
    </div>
  </section>
}
