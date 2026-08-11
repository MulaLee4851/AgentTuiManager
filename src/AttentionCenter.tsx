import { useEffect, useMemo, useState } from 'react'

import type { ApprovalRisk, SessionSummary } from './shared/manager-api'

interface AttentionCenterProps {
  sessions: SessionSummary[]
  onOpenSession: (sessionId: string) => void
  onReload: () => Promise<void>
}

const RISK_DETAILS: Record<ApprovalRisk, {
  label: string
  tone: string
  impact: string
  reversibility: string
  learning: string
}> = {
  read: { label: '低风险', tone: 'read', impact: '只读', reversibility: '不修改文件', learning: '可在重复批准后询问' },
  write: { label: '写入操作', tone: 'write', impact: '修改工作区', reversibility: '取决于工具操作', learning: '禁止自动学习' },
  delete: { label: '高风险删除', tone: 'delete', impact: '删除内容', reversibility: '可能不可撤销', learning: '禁止自动学习' },
  unknown: { label: '影响未识别', tone: 'unknown', impact: '需要人工判断', reversibility: '无法确认', learning: '禁止自动学习' },
}

function approvalTitle(session: SessionSummary): string {
  if (session.approvalRisk === 'delete') return session.displayName + ' 请求执行删除操作'
  if (session.approvalRisk === 'write') return session.displayName + ' 请求写入工作区'
  if (session.approvalRisk === 'read') return session.displayName + ' 请求运行只读操作'
  return session.displayName + ' 请求执行一个操作'
}

function approvalTargets(session: SessionSummary): string[] {
  return [
    ...(session.approvalFilePath ? [session.approvalFilePath] : []),
    ...(session.approvalTargetPaths ?? []),
  ]
}

function approvalDisplay(session: SessionSummary): string {
  return session.approvalInputSummary
    ?? session.pendingApprovalCommand
    ?? '未能识别具体命令，请打开终端核对原始请求。'
}

export default function AttentionCenter({
  sessions,
  onOpenSession,
  onReload,
}: AttentionCenterProps): JSX.Element {
  const pending = useMemo(
    () => sessions.filter((session) => session.status === 'needs_approval' || session.status === 'needs_attention'),
    [sessions],
  )
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = pending.find((session) => session.sessionId === selectedId) ?? pending[0]

  useEffect(() => {
    if (selected && selected.sessionId !== selectedId) setSelectedId(selected.sessionId)
  }, [selected, selectedId])

  const run = async (action: () => Promise<void> | void): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await onReload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const approvalCount = pending.filter((session) => session.status === 'needs_approval').length
  const recoveryCount = pending.length - approvalCount

  return <section className='attention-page attention-page-embedded'>
    <div className='attention-shell attention-shell-embedded'>
      <section className='attention-queue'>
        <header><div><h1>需要处理</h1><span>{approvalCount} 个授权 · {recoveryCount} 个异常</span></div></header>
        <div className='attention-queue-list'>
          {pending.length === 0 && <p className='attention-empty'>当前没有待处理项</p>}
          {pending.map((session) => {
            const risk = RISK_DETAILS[session.approvalRisk ?? 'unknown']
            return <button
              className={'attention-queue-item ' + (selected?.sessionId === session.sessionId ? 'active ' : '') + (session.status === 'needs_attention' ? 'event' : risk.tone)}
              key={session.sessionId}
              type='button'
              onClick={() => setSelectedId(session.sessionId)}
            >
              <i className='severity' />
              <span><span className='queue-top'><strong>{session.displayName}</strong><em>{session.status === 'needs_attention' ? '重试耗尽' : risk.label}</em></span>
                <span className='queue-command'>{session.status === 'needs_attention' ? session.lastError : session.pendingApprovalCommand ?? '未识别具体命令'}</span>
                <span className='queue-meta'>{session.agentKind.toUpperCase()} · {session.workspace}</span>
              </span>
            </button>
          })}
        </div>
      </section>
      <section className='attention-detail'>
        {!selected ? <div className='attention-detail-empty'><strong>所有 Agent 均可继续运行</strong><span>新的授权或恢复异常会出现在这里。</span></div>
          : selected.status === 'needs_attention'
            ? <RecoveryDetail session={selected} busy={busy} error={error} onOpen={() => onOpenSession(selected.sessionId)} onContinue={() => run(() => window.agentManager.continueSession(selected.sessionId))} />
            : <ApprovalDetail session={selected} busy={busy} error={error} onOpen={() => onOpenSession(selected.sessionId)} onApprove={() => run(() => window.agentManager.approveSession(selected.sessionId))} />}
      </section>
    </div>
  </section>
}

function ApprovalDetail({
  session,
  busy,
  error,
  onOpen,
  onApprove,
}: {
  session: SessionSummary
  busy: boolean
  error: string
  onOpen: () => void
  onApprove: () => void
}): JSX.Element {
  const risk = RISK_DETAILS[session.approvalRisk ?? 'unknown']
  const highRisk = session.approvalRisk === 'delete' || session.approvalRisk === 'write' || session.approvalRisk === 'unknown'
  const targets = approvalTargets(session)
  const structured = Boolean(session.approvalToolName)
  return <div className='attention-detail-inner'>
    <p className={'detail-kicker ' + risk.tone}>{risk.label} · 需要本次确认</p>
    <h2>{approvalTitle(session)}</h2>
    <p className='detail-subtitle'>请求来自“{session.displayName}”会话。Manager 只展示已识别的信息，最终操作仍由原生 Agent 执行。</p>
    <section className='command-card'>
      <div className='command-label'><span>{structured ? 'Claude Hook 结构化请求' : '终端兼容识别'}</span><span>{session.approvalToolName ?? session.agentKind.toUpperCase()}</span></div>
      <pre>{approvalDisplay(session)}</pre>
      <div className='command-path'>{targets.length ? '目标：' + targets.join(' · ') : '工作目录：' + session.workspace}</div>
    </section>
    <div className='approval-facts'>
      <div><span>文件影响</span><strong className={risk.tone}>{targets.length ? targets.length + ' 个目标' : risk.impact}</strong></div>
      <div><span>工具名称</span><strong>{session.approvalToolName ?? '未提供'}</strong></div>
      <div><span>可恢复性</span><strong className={highRisk ? 'delete' : 'read'}>{risk.reversibility}</strong></div>
      <div><span>自动学习</span><strong className={highRisk ? 'delete' : 'read'}>{risk.learning}</strong></div>
    </div>
    <div className={'approval-reason ' + (highRisk ? 'danger' : '')}>
      <strong>{highRisk ? '为什么必须人工确认？' : '为什么这次仍需确认？'}</strong>
      <p>{session.approvalReason ?? '该操作没有命中现有自动批准规则。'}</p>
    </div>
    {session.approvalSuggestion && <section className='approval-learning'>
      <strong>同一操作已手动批准 {session.approvalSuggestion.approvalCount} 次</strong>
      <p>这条只读规则可以在批准后加入授权列表；风险操作永远不会自动学习。</p>
    </section>}
    {error && <p className='form-error'>{error}</p>}
    <div className='detail-actions'><span>本次决定只对当前请求有效</span><button className='button-secondary' type='button' onClick={onOpen}>打开终端</button><button className='button-primary' type='button' disabled={busy} onClick={onApprove}>{busy ? '请稍后…' : '批准这一次'}</button></div>
    <PolicySummary />
  </div>
}

function RecoveryDetail({
  session,
  busy,
  error,
  onOpen,
  onContinue,
}: {
  session: SessionSummary
  busy: boolean
  error: string
  onOpen: () => void
  onContinue: () => void
}): JSX.Element {
  return <div className='attention-detail-inner'>
    <p className='detail-kicker recovery'>异常恢复 · 已停止自动重试</p>
    <h2>{session.displayName} 连续 {session.recoveryAttempts} 次重试失败</h2>
    <p className='detail-subtitle'>终端和原生会话仍然保留，Manager 不会主动关闭窗口。手动继续会重新计算最多三次自动尝试。</p>
    <section className='command-card'>
      <div className='command-label'><span>最近错误</span><span>{session.agentKind.toUpperCase()}</span></div>
      <pre>{session.lastError ?? '未记录具体错误'}</pre>
      <div className='command-path'>工作目录：{session.workspace}</div>
    </section>
    <div className='approval-facts'>
      <div><span>恢复次数</span><strong className='write'>{session.recoveryAttempts}</strong></div>
      <div><span>当前状态</span><strong className='write'>等待人工处理</strong></div>
      <div><span>终端进程</span><strong className='read'>保持运行</strong></div>
      <div><span>正常完成</span><strong className='read'>不会误触发</strong></div>
    </div>
    {error && <p className='form-error'>{error}</p>}
    <div className='detail-actions'><span>再次继续会重置自动重试预算</span><button className='button-secondary' type='button' onClick={onOpen}>打开终端</button><button className='button-primary' type='button' disabled={busy} onClick={onContinue}>{busy ? '请稍后…' : '再次继续'}</button></div>
  </div>
}

function PolicySummary(): JSX.Element {
  return <section className='policy-summary'>
    <h3>当前安全边界</h3>
    <div><i /><strong>内置只读命令</strong><span>直接批准</span></div>
    <div><i /><strong>低风险重复命令</strong><span>第 3 次后询问是否记住</span></div>
    <div><i className='danger' /><strong>删除、覆盖、提权和外部写入</strong><span>永远人工确认</span></div>
  </section>
}
