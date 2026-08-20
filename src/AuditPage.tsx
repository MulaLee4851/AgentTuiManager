import { useEffect, useMemo, useState } from 'react'

import type { AuditCategory, AuditEntry, AuditLevel, LlmRuleAuditFinding, SessionSummary } from './shared/manager-api'

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  session: '会话', approval: '授权', recovery: '恢复', rule: '规则', review: '审查', remote: '远程',
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

const REVIEW_SEVERITY_LABEL: Record<LlmRuleAuditFinding['severity'], string> = {
  low: '低风险', medium: '需要复核', high: '高风险', critical: '严重危险',
}

const REVIEW_LEVEL_LABEL: Record<string, string> = {
  low: '低', medium: '中', high: '高',
}

const REVIEW_VERDICT_LABEL: Record<string, string> = {
  allow: '建议放行', manual: '需要人工确认', deny: '建议拒绝', uncertain: '无法确定',
}

function displayedCategory(entry: AuditEntry): AuditCategory {
  return entry.action.startsWith('llm_') ? 'review' : entry.category
}

function detailValue(entry: AuditEntry, key: string): string | number | boolean | undefined {
  return entry.details?.[key]
}

function parsedStringList(entry: AuditEntry, key: string): string[] {
  const value = detailText(entry, key)
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item)) : []
  } catch { return [] }
}

function parsedFindings(entry: AuditEntry): LlmRuleAuditFinding[] {
  const value = detailText(entry, 'findings')
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is LlmRuleAuditFinding => Boolean(item) && typeof item === 'object'
      && typeof (item as LlmRuleAuditFinding).rule === 'string'
      && typeof (item as LlmRuleAuditFinding).issue === 'string'
      && typeof (item as LlmRuleAuditFinding).recommendation === 'string'
      && ['low', 'medium', 'high', 'critical'].includes((item as LlmRuleAuditFinding).severity))
  } catch { return [] }
}

function reviewFacts(entry: AuditEntry): Array<[string, string]> {
  const facts: Array<[string, string]> = []
  const add = (label: string, value: unknown): void => { if (value !== undefined && value !== '') facts.push([label, String(value)]) }
  const source = detailValue(entry, 'source')
  add('触发方式', source === 'manual' ? '手动审查' : source === 'scheduled' ? '定时审查' : source)
  add('模型', detailValue(entry, 'model'))
  const level = detailValue(entry, 'level')
  add('审查等级', typeof level === 'string' ? REVIEW_LEVEL_LABEL[level] ?? level : level)
  add('规则数量', detailValue(entry, 'ruleCount'))
  add('发现问题', detailValue(entry, 'findingCount'))
  add('风险分', detailValue(entry, 'riskScore'))
  const verdict = detailValue(entry, 'verdict')
  add('模型结论', typeof verdict === 'string' ? REVIEW_VERDICT_LABEL[verdict] ?? verdict : verdict)
  const requiresHuman = detailValue(entry, 'requiresHumanApproval')
  add('人工确认', requiresHuman === true ? '需要' : requiresHuman === false ? '不需要' : requiresHuman)
  add('请求超时', detailValue(entry, 'timeoutSeconds') !== undefined ? `${detailValue(entry, 'timeoutSeconds')} 秒` : undefined)
  return facts
}

function normalizedWorkspace(value: string): string {
  return value.replace(/\//g, '\\').replace(/[\\]+$/, '').toLocaleLowerCase('en-US')
}

export default function AuditPage({ sessions = [], onOpenLlmReviewResults }: { sessions?: SessionSummary[]; onOpenLlmReviewResults?: () => void }): JSX.Element {
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
      category: displayedCategory(entry),
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
    return decorated.filter((item) => (category === 'all' || item.category === category)
      && (level === 'all' || item.entry.level === level)
      && (workspace === 'all' || Boolean(item.workspace && normalizedWorkspace(item.workspace) === workspace))
      && (agent === 'all' || item.entry.sessionId === agent)
      && (cutoff === undefined || item.entry.timestamp >= cutoff))
  }, [agent, category, decorated, level, timeRange, workspace])
  const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleEntries = useMemo(() => filtered.slice((currentPage - 1) * AUDIT_PAGE_SIZE, currentPage * AUDIT_PAGE_SIZE), [currentPage, filtered])
  const selected = visibleEntries.find((item) => item.entry.id === selectedId) ?? visibleEntries[0]
  const selectedReviewFacts = selected?.category === 'review' ? reviewFacts(selected.entry) : []
  const selectedFindings = selected?.category === 'review' ? parsedFindings(selected.entry) : []
  const selectedReasons = selected?.category === 'review' ? parsedStringList(selected.entry, 'reasons') : []
  const selectedHazards = selected?.category === 'review' ? parsedStringList(selected.entry, 'hazards') : []
  const selectedAssumptions = selected?.category === 'review' ? parsedStringList(selected.entry, 'assumptions') : []
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
        <span className="audit-category">{CATEGORY_LABEL[displayedCategory(entry)]}</span>
        <div><strong>{entry.message}</strong><small>{[displayName, entryWorkspace, entry.action].filter(Boolean).join(' · ')}</small>{(detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')) && <code>{detailText(entry, 'command') ?? detailText(entry, 'toolName') ?? detailText(entry, 'reason') ?? detailText(entry, 'error')}</code>}</div>
        <span className="audit-level">{LEVEL_LABEL[entry.level]}</span>
      </article>)}
      {filtered.length > AUDIT_PAGE_SIZE && <nav className="audit-pagination" aria-label="审计分页"><span>共 {filtered.length} 条 · 第 {currentPage}/{pageCount} 页</span><div><button className="button-secondary button-compact" type="button" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><button className="button-secondary button-compact" type="button" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button></div></nav>}
    </div>{selected && <aside className="audit-detail">
      <header><div><span className="eyebrow">{CATEGORY_LABEL[selected.category]} · {LEVEL_LABEL[selected.entry.level]}</span><h3>{selected.entry.message}</h3></div><div className="audit-detail-actions">{selected.category === 'review' && selected.entry.action.startsWith('llm_rule_audit_') && onOpenLlmReviewResults && <button type="button" className="button-primary button-compact" onClick={onOpenLlmReviewResults}>查看完整审查结果</button>}<button type="button" className="button-secondary button-compact" onClick={() => { void copySelected() }}>复制详情</button></div></header>
      <dl><div><dt>时间</dt><dd>{new Date(selected.entry.timestamp).toLocaleString()}</dd></div><div><dt>Agent</dt><dd>{selected.displayName ?? '全局事件'}</dd></div><div><dt>会话</dt><dd>{selected.entry.sessionId ?? '—'}</dd></div><div><dt>工作区</dt><dd>{selected.workspace ?? '—'}</dd></div><div><dt>动作</dt><dd>{selected.entry.action}</dd></div></dl>
      {selected.category === 'review' ? <div className="audit-review-detail">
        {selectedReviewFacts.length > 0 && <dl className="audit-review-facts">{selectedReviewFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {detailText(selected.entry, 'summary') && <section><strong>审查结论</strong><p>{detailText(selected.entry, 'summary')}</p></section>}
        {detailText(selected.entry, 'command') && <section><strong>被审查命令</strong><code>{detailText(selected.entry, 'command')}</code></section>}
        {detailText(selected.entry, 'error') && <section className="danger"><strong>失败原因</strong><p>{detailText(selected.entry, 'error')}</p></section>}
        {selectedReasons.length > 0 && <section><strong>判断理由</strong><ul>{selectedReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></section>}
        {selectedHazards.length > 0 && <section className="danger"><strong>危险点</strong><ul>{selectedHazards.map((hazard, index) => <li key={index}>{hazard}</li>)}</ul></section>}
        {selectedAssumptions.length > 0 && <section><strong>环境与路径假设</strong><ul>{selectedAssumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></section>}
        {selectedFindings.length > 0 && <section className="audit-review-findings"><strong>命中的规则问题</strong>{selectedFindings.map((finding, index) => <article className={'severity-' + finding.severity} key={`${finding.rule}::${index}`}><header><span>{REVIEW_SEVERITY_LABEL[finding.severity]}</span><code>{finding.rule}</code></header><p>{finding.issue}</p><small>{finding.recommendation}</small></article>)}</section>}
        {detailValue(selected.entry, 'findingsTruncated') === true && <p className="audit-review-truncated">这里只显示前 8 项，点击“查看完整审查结果”查看最新完整结果。</p>}
      </div> : <div className="audit-detail-fields">{Object.entries(selected.entry.details ?? {}).map(([key, value]) => <div key={key}><strong>{key}</strong><code>{String(value)}</code></div>)}</div>}
    </aside>}</div>
  </section>
}
