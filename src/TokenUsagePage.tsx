import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary, TokenUsagePage as UsagePageResult, TokenUsageRecord, TokenUsageSummary } from './shared/manager-api'
import { tokenUsageDateRange, type TokenUsageDateRange } from './token-usage-range'

interface Props { sessions: SessionSummary[] }

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function labelFor(record: TokenUsageRecord, sessions: SessionSummary[]): string {
  return sessions.find((session) => session.sessionId === record.sessionId)?.displayName ?? record.sessionId.slice(0, 8)
}

function formatRange(range: TokenUsageDateRange, days: number): string {
  if (days === 1) return '今天 00:00 至现在'
  const start = new Date(range.from).toLocaleDateString('zh-CN')
  const end = new Date(range.to).toLocaleDateString('zh-CN')
  return `${start} 00:00 至 ${end} 现在`
}

export default function TokenUsagePage({ sessions }: Props): JSX.Element {
  const [summaries, setSummaries] = useState<TokenUsageSummary[]>([])
  const [details, setDetails] = useState<UsagePageResult>({ records: [], total: 0, page: 1, pageSize: 100 })
  const [selectedSession, setSelectedSession] = useState<string>()
  const [days, setDays] = useState(1)
  const [range, setRange] = useState<TokenUsageDateRange>(() => tokenUsageDateRange(1))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestVersion = useRef(0)

  const reload = async (): Promise<void> => {
    if (!window.agentManager.listTokenUsageSummary || !window.agentManager.listTokenUsageDetails) {
      setError('当前版本暂未提供 Token 用量接口')
      return
    }
    const requestId = ++requestVersion.current
    const nextRange = tokenUsageDateRange(days)
    setLoading(true); setError(''); setRange(nextRange)
    try {
      const query = { ...nextRange, groupBy: 'session' as const, page: 1, pageSize: 100 }
      const [nextSummary, nextDetails] = await Promise.all([
        window.agentManager.listTokenUsageSummary(query),
        window.agentManager.listTokenUsageDetails({ ...nextRange, sessionId: selectedSession, page: 1, pageSize: 100 }),
      ])
      if (requestId !== requestVersion.current) return
      setSummaries(nextSummary); setDetails(nextDetails)
    } catch (reason) {
      if (requestId === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestId === requestVersion.current) setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => { void reload() }, 5_000)
    return () => {
      window.clearInterval(timer)
      requestVersion.current += 1
    }
  }, [days, selectedSession])

  const totals = useMemo(() => summaries.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.inputTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
    totalTokens: total.totalTokens + item.totalTokens,
    requestCount: total.requestCount + item.requestCount,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requestCount: 0 }), [summaries])

  return <section className='token-usage-page'>
    <header className='token-usage-toolbar'><div><strong>Token 用量</strong><span>原生 Session usage · {formatRange(range, days)} · {totals.requestCount.toLocaleString('zh-CN')} 条记录</span></div><label>范围<select aria-label='Token 统计范围' value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>今天</option><option value={7}>最近 7 个自然日</option><option value={30}>最近 30 个自然日</option></select></label><button className='button-secondary button-compact' type='button' onClick={() => void reload()} disabled={loading}>↻ 刷新</button></header>
    {error && <p className='token-usage-error' role='alert'>{error}</p>}
    <div className='token-usage-metrics'>{[['输入', totals.inputTokens], ['输出', totals.outputTokens], ['缓存读取', totals.cacheReadTokens], ['缓存写入', totals.cacheWriteTokens], ['总计', totals.totalTokens]].map(([name, value]) => <div key={String(name)}><span>{name}</span><strong>{formatTokens(Number(value))}</strong></div>)}</div>
    <div className='token-usage-workbench'><section className='token-usage-table-wrap'><h3>按 Agent 窗口</h3><table><thead><tr><th>Agent</th><th>模型 / 配置</th><th>输入</th><th>输出</th><th>缓存读取</th><th>总计</th></tr></thead><tbody>{summaries.length === 0 ? <tr><td colSpan={6} className='token-usage-empty'>{loading ? '正在读取 Session usage…' : '暂无精确 Token 数据'}</td></tr> : summaries.map((item) => <tr className={item.sessionId === selectedSession ? 'active' : ''} key={item.key} onClick={() => setSelectedSession(item.sessionId)}><td><strong>{item.label}</strong><small>{item.agentKind ?? '—'} · {item.workspace ?? '—'}</small></td><td><code>{item.model ?? '继承模型'}</code><small>{item.providerName ?? item.providerId ?? '默认配置'}</small></td><td>{formatTokens(item.inputTokens)}</td><td>{formatTokens(item.outputTokens)}</td><td>{formatTokens(item.cacheReadTokens)}</td><td><strong>{formatTokens(item.totalTokens)}</strong></td></tr>)}</tbody></table></section><aside className='token-usage-details'><header><h3>{selectedSession ? '窗口明细' : '最近 usage'}</h3><span>{details.records.length < details.total ? `显示最近 ${details.records.length} / 共 ${details.total} 条` : `${details.total} 条记录`}</span></header>{details.records.length === 0 ? <p className='token-usage-empty'>选择 Agent 查看每次 Turn 的输入、输出和缓存用量。</p> : <div className='token-usage-detail-list'>{details.records.map((record) => <article key={record.id}><header><strong>{labelFor(record, sessions)}</strong><time>{new Date(record.timestamp).toLocaleString('zh-CN')}</time></header><div><span>输入 <b>{formatTokens(record.inputTokens)}</b></span><span>输出 <b>{formatTokens(record.outputTokens)}</b></span><span>缓存读 <b>{formatTokens(record.cacheReadTokens)}</b></span><span>缓存写 <b>{formatTokens(record.cacheWriteTokens)}</b></span></div><small>{record.model ?? '继承模型'} · {record.source} · {record.accuracy === 'exact' ? '精确' : record.accuracy}</small></article>)}</div>}</aside></div>
  </section>
}
