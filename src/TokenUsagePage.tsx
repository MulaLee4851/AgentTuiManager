import { useEffect, useMemo, useState } from 'react'
import type { SessionSummary, TokenUsagePage as UsagePageResult, TokenUsageRecord, TokenUsageSummary } from './shared/manager-api'

interface Props { sessions: SessionSummary[] }

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function labelFor(record: TokenUsageRecord, sessions: SessionSummary[]): string {
  return sessions.find((session) => session.sessionId === record.sessionId)?.displayName ?? record.sessionId.slice(0, 8)
}

export default function TokenUsagePage({ sessions }: Props): JSX.Element {
  const [summaries, setSummaries] = useState<TokenUsageSummary[]>([])
  const [details, setDetails] = useState<UsagePageResult>({ records: [], total: 0, page: 1, pageSize: 100 })
  const [selectedSession, setSelectedSession] = useState<string>()
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reload = async (): Promise<void> => {
    if (!window.agentManager.listTokenUsageSummary || !window.agentManager.listTokenUsageDetails) {
      setError('当前版本暂未提供 Token 用量接口')
      return
    }
    setLoading(true); setError('')
    try {
      const from = Date.now() - days * 86_400_000
      const query = { from, groupBy: 'session' as const, page: 1, pageSize: 100 }
      const [nextSummary, nextDetails] = await Promise.all([
        window.agentManager.listTokenUsageSummary(query),
        window.agentManager.listTokenUsageDetails({ from, sessionId: selectedSession, page: 1, pageSize: 100 }),
      ])
      setSummaries(nextSummary); setDetails(nextDetails)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) }
  }

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => { void reload() }, 5_000)
    return () => window.clearInterval(timer)
  }, [days, selectedSession])

  const totals = useMemo(() => summaries.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.inputTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
    totalTokens: total.totalTokens + item.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }), [summaries])

  return <section className='token-usage-page'>
    <header className='token-usage-toolbar'><div><strong>Token 用量</strong><span>原生 Session usage · 精确数据优先</span></div><label>范围<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>今天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label><button className='button-secondary button-compact' type='button' onClick={() => void reload()} disabled={loading}>↻ 刷新</button></header>
    {error && <p className='token-usage-error' role='alert'>{error}</p>}
    <div className='token-usage-metrics'>{[['输入', totals.inputTokens], ['输出', totals.outputTokens], ['缓存读取', totals.cacheReadTokens], ['缓存写入', totals.cacheWriteTokens], ['总计', totals.totalTokens]].map(([name, value]) => <div key={String(name)}><span>{name}</span><strong>{formatTokens(Number(value))}</strong></div>)}</div>
    <div className='token-usage-workbench'><section className='token-usage-table-wrap'><h3>按 Agent 窗口</h3><table><thead><tr><th>Agent</th><th>模型 / 配置</th><th>输入</th><th>输出</th><th>缓存读取</th><th>总计</th></tr></thead><tbody>{summaries.length === 0 ? <tr><td colSpan={6} className='token-usage-empty'>{loading ? '正在读取 Session usage…' : '暂无精确 Token 数据'}</td></tr> : summaries.map((item) => <tr className={item.sessionId === selectedSession ? 'active' : ''} key={item.key} onClick={() => setSelectedSession(item.sessionId)}><td><strong>{item.label}</strong><small>{item.agentKind ?? '—'} · {item.workspace ?? '—'}</small></td><td><code>{item.model ?? '继承模型'}</code><small>{item.providerName ?? item.providerId ?? '默认配置'}</small></td><td>{formatTokens(item.inputTokens)}</td><td>{formatTokens(item.outputTokens)}</td><td>{formatTokens(item.cacheReadTokens)}</td><td><strong>{formatTokens(item.totalTokens)}</strong></td></tr>)}</tbody></table></section><aside className='token-usage-details'><header><h3>{selectedSession ? '窗口明细' : '最近 usage'}</h3><span>{details.total} 条记录</span></header>{details.records.length === 0 ? <p className='token-usage-empty'>选择 Agent 查看每次 Turn 的输入、输出和缓存用量。</p> : <div className='token-usage-detail-list'>{details.records.map((record) => <article key={record.id}><header><strong>{labelFor(record, sessions)}</strong><time>{new Date(record.timestamp).toLocaleString('zh-CN')}</time></header><div><span>输入 <b>{formatTokens(record.inputTokens)}</b></span><span>输出 <b>{formatTokens(record.outputTokens)}</b></span><span>缓存读 <b>{formatTokens(record.cacheReadTokens)}</b></span><span>缓存写 <b>{formatTokens(record.cacheWriteTokens)}</b></span></div><small>{record.model ?? '继承模型'} · {record.source} · {record.accuracy === 'exact' ? '精确' : record.accuracy}</small></article>)}</div>}</aside></div>
  </section>
}
