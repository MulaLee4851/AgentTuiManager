import { useEffect, useMemo, useState } from 'react'

import type { AuditCategory, AuditEntry, AuditLevel } from './shared/manager-api'

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  session: '会话', approval: '授权', recovery: '恢复', rule: '规则',
}

const LEVEL_LABEL: Record<AuditLevel, string> = {
  info: '信息', warning: '提醒', error: '错误',
}

export default function AuditPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [level, setLevel] = useState<AuditLevel | 'all'>('all')
  const [error, setError] = useState('')

  const reload = async (): Promise<void> => {
    try { setEntries(await window.agentManager.listAuditEntries()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  useEffect(() => {
    void reload()
    return window.agentManager.subscribe((event) => { if (event.type === 'audit-changed') void reload() })
  }, [])

  const filtered = useMemo(() => entries.filter((entry) => (category === 'all' || entry.category === category)
    && (level === 'all' || entry.level === level)), [entries, category, level])

  return <section className="audit-page">
    <header className="audit-header">
      <div><span className="eyebrow">ACTIVITY</span><h1>活动审计</h1><p>启动、停止、恢复、授权与规则变更都会留在这里。</p></div>
      <div className="audit-filters">
        <label>类别<select aria-label="审计类别" value={category} onChange={(event) => setCategory(event.target.value as AuditCategory | 'all')}><option value="all">全部</option>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>级别<select aria-label="审计级别" value={level} onChange={(event) => setLevel(event.target.value as AuditLevel | 'all')}><option value="all">全部</option>{Object.entries(LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button-secondary" onClick={() => { void reload() }}>刷新</button>
      </div>
    </header>
    {error && <p className="form-error">读取审计记录失败：{error}</p>}
    <div className="audit-list">
      {filtered.length === 0 ? <div className="audit-empty">还没有符合条件的活动记录</div> : filtered.map((entry) => <article className={`audit-row audit-${entry.level}`} key={entry.id}>
        <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time>
        <span className="audit-category">{CATEGORY_LABEL[entry.category]}</span>
        <div><strong>{entry.message}</strong>{entry.sessionId && <small>会话 {entry.sessionId.slice(0, 8)}</small>}</div>
        <span className="audit-level">{LEVEL_LABEL[entry.level]}</span>
      </article>)}
    </div>
  </section>
}
