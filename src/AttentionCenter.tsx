import { useEffect, useMemo, useState } from 'react'

import type { ApprovalRequest, ApprovalRisk, SessionSummary } from './shared/manager-api'

interface AttentionCenterProps {
  sessions: SessionSummary[]
  approvals: ApprovalRequest[]
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

type QueueItem =
  | { key: string; kind: 'approval'; request: ApprovalRequest }
  | { key: string; kind: 'recovery'; session: SessionSummary }

function approvalTitle(request: ApprovalRequest): string {
  if (request.risk === 'delete') return request.displayName + ' 请求执行删除操作'
  if (request.risk === 'write') return request.displayName + ' 请求写入工作区'
  if (request.risk === 'read') return request.displayName + ' 请求运行只读操作'
  return request.displayName + ' 请求执行一个操作'
}

function approvalTargets(request: ApprovalRequest): string[] {
  return [
    ...(request.filePath ? [request.filePath] : []),
    ...(request.targetPaths ?? []),
  ]
}

function approvalDisplay(request: ApprovalRequest): string {
  return request.inputSummary
    ?? request.command
    ?? '工具没有提供可展示的参数，请打开终端核对原始请求。'
}

export default function AttentionCenter({
  sessions,
  approvals,
  onOpenSession,
  onReload,
}: AttentionCenterProps): JSX.Element {
  const queue = useMemo<QueueItem[]>(() => [
    ...approvals.map((request) => ({ key: 'approval:' + request.requestId, kind: 'approval' as const, request })),
    ...sessions
      .filter((session) => session.status === 'needs_attention')
      .map((session) => ({ key: 'recovery:' + session.sessionId, kind: 'recovery' as const, session })),
  ], [approvals, sessions])
  const [selectedKey, setSelectedKey] = useState<string>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = queue.find((item) => item.key === selectedKey) ?? queue[0]

  useEffect(() => {
    if (selected && selected.key !== selectedKey) setSelectedKey(selected.key)
  }, [selected, selectedKey])

  const run = async (action: () => Promise<void> | void): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      await onReload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const approveAll = (): void => {
    void run(async () => {
      const result = typeof window.agentManager.approveAllPending === 'function'
        ? await window.agentManager.approveAllPending()
        : await (async () => {
          let approved = 0
          for (const request of approvals.filter((item) => item.canBulkApprove)) {
            await window.agentManager.approveSession(request.sessionId)
            approved += 1
          }
          return { approved, skipped: approvals.length - approved, failed: 0, skippedRequestIds: [] }
        })()
      setNotice('已批准 ' + result.approved + ' 项'
        + (result.skipped ? '，跳过 ' + result.skipped + ' 项严重指令' : '')
        + (result.failed ? '，' + result.failed + ' 项处理失败' : ''))
    })
  }

  const recoveryCount = queue.length - approvals.length
  const bulkCount = approvals.filter((request) => request.canBulkApprove).length

  return <section className='attention-page attention-page-embedded'>
    <div className='attention-shell attention-shell-embedded'>
      <section className='attention-queue'>
        <header>
          <div><h1>需要处理</h1><span>{approvals.length} 个授权 · {recoveryCount} 个异常</span></div>
          <button className='button-primary button-compact' type='button' disabled={busy || bulkCount === 0} onClick={approveAll}>批准全部</button>
        </header>
        <div className='attention-queue-list'>
          {queue.length === 0 && <p className='attention-empty'>当前没有待处理项</p>}
          {queue.map((item) => {
            if (item.kind === 'recovery') {
              const unresponsive = item.session.attentionKind === 'host-unresponsive'
              return <button
                className={'attention-queue-item event' + (selected?.key === item.key ? ' active' : '')}
                key={item.key}
                type='button'
                onClick={() => setSelectedKey(item.key)}
              >
                <i className='severity' />
                  <span><span className='queue-top'><strong>{item.session.displayName}</strong><em>{unresponsive ? '终端无响应' : '异常退出'}</em></span>
                  <span className='queue-command'>{item.session.lastError ?? '未记录具体原因'}</span>
                  <span className='queue-meta'>{item.session.agentKind.toUpperCase()} · {item.session.workspace}</span>
                </span>
              </button>
            }
            const risk = RISK_DETAILS[item.request.risk]
            return <button
              className={'attention-queue-item ' + risk.tone + (selected?.key === item.key ? ' active' : '')}
              key={item.key}
              type='button'
              onClick={() => setSelectedKey(item.key)}
            >
              <i className='severity' />
              <span><span className='queue-top'><strong>{item.request.displayName}</strong><em>{item.request.llmReviewStatus === 'pending' ? 'LLM 审查中' : risk.label}</em></span>
                <span className='queue-command'>{item.request.toolName ? item.request.toolName + ' · ' : ''}{approvalDisplay(item.request)}</span>
                <span className='queue-meta'>{item.request.agentKind.toUpperCase()} · {item.request.workspace}{item.request.dangerRuleName ? ' · 命中：' + item.request.dangerRuleName : ''}</span>
              </span>
            </button>
          })}
        </div>
      </section>
      <section className='attention-detail'>
        {notice && <p className='attention-notice'>{notice}</p>}
        {!selected ? <div className='attention-detail-empty'><strong>所有 Agent 均可继续运行</strong><span>新的授权或恢复异常会出现在这里。</span></div>
          : selected.kind === 'recovery'
            ? <RecoveryDetail session={selected.session} busy={busy} error={error} onOpen={() => onOpenSession(selected.session.sessionId)} onContinue={() => run(() => window.agentManager.continueSession(selected.session.sessionId))} />
            : <ApprovalDetail
              request={selected.request}
              busy={busy}
              error={error}
              onOpen={() => onOpenSession(selected.request.sessionId)}
              onReject={() => run(() => {
                if (typeof window.agentManager.rejectRequest !== 'function') throw new Error('拒绝功能需要重启 Manager 后启用；当前可打开终端并在原生提示中拒绝')
                return window.agentManager.rejectRequest(selected.request.requestId)
              })}
              onRemember={() => run(async () => {
                if (typeof window.agentManager.approveAndRememberRequest === 'function') {
                  await window.agentManager.approveAndRememberRequest(selected.request.requestId)
                  return
                }
                if (!selected.request.command) throw new Error('Agent 没有提供完整命令或工具名称，无法记住')
                await window.agentManager.addApprovalRule(selected.request.command)
                await window.agentManager.approveSession(selected.request.sessionId)
              })}
              onApprove={() => run(() => typeof window.agentManager.approveRequest === 'function'
                ? window.agentManager.approveRequest(selected.request.requestId)
                : window.agentManager.approveSession(selected.request.sessionId))}
            />}
      </section>
    </div>
  </section>
}

function ApprovalDetail({
  request,
  busy,
  error,
  onOpen,
  onReject,
  onRemember,
  onApprove,
}: {
  request: ApprovalRequest
  busy: boolean
  error: string
  onOpen: () => void
  onReject: () => void
  onRemember: () => void
  onApprove: () => void
}): JSX.Element {
  const risk = RISK_DETAILS[request.risk]
  const highRisk = request.risk === 'delete' || request.risk === 'write' || request.risk === 'unknown'
  const targets = approvalTargets(request)
  return <div className='attention-detail-inner'>
    <p className={'detail-kicker ' + risk.tone}>{risk.label} · 需要本次确认{request.dangerRuleName ? ' · 命中 ' + request.dangerRuleName : ''}</p>
    <h2>{approvalTitle(request)}</h2>
    <p className='detail-subtitle'>请求来自“{request.displayName}”会话 · {request.workspace} · 会话 {request.nativeSessionId ?? request.sessionId}</p>
    <section className='command-card'>
      <div className='command-label'><span>{request.source === 'claude-hook' ? 'Claude Hook 结构化请求' : '终端兼容识别'}</span><span>{request.toolName ?? request.agentKind.toUpperCase()}</span></div>
      <pre>{approvalDisplay(request)}</pre>
      <div className='command-path'>{targets.length ? '目标：' + targets.join(' · ') : '工作目录：' + request.workspace}</div>
    </section>
    <div className='approval-facts'>
      <div><span>文件影响</span><strong className={risk.tone}>{targets.length ? targets.length + ' 个目标' : risk.impact}</strong></div>
      <div><span>工具名称</span><strong>{request.toolName ?? '未提供'}</strong></div>
      <div><span>可恢复性</span><strong className={highRisk ? 'delete' : 'read'}>{risk.reversibility}</strong></div>
      <div><span>{request.dangerRuleName ? '命中规则' : '自动学习'}</span><strong className={highRisk ? 'delete' : 'read'}>{request.dangerRuleName ?? risk.learning}</strong></div>
    </div>
    <div className={'approval-reason ' + (highRisk ? 'danger' : '')}>
      <strong>{request.dangerRuleName ? '命中高危规则「' + request.dangerRuleName + '」' : highRisk ? '为什么必须人工确认？' : '为什么这次仍需确认？'}</strong>
      <p>{request.reason}</p>
    </div>
    {request.llmReviewStatus && <section className={'llm-approval-review status-' + request.llmReviewStatus}>
      <header><div><strong>LLM 安全审查</strong><span>{request.llmReviewStatus === 'pending' ? '正在分析命令、路径和环境假设' : request.llmReviewStatus === 'failed' ? '审查失败 · 已转人工' : request.llmReview?.requiresHumanApproval ? '建议人工确认' : '可由全自动模式放行'}</span></div>{request.llmReview && <em>风险 {request.llmReview.riskScore}/100</em>}</header>
      {request.llmReviewStatus === 'pending' && <p>本地硬规则仍然优先；等待期间不会自动执行。</p>}
      {request.llmReviewError && <p>{request.llmReviewError}</p>}
      {request.llmReview && <>
        <h3>{request.llmReview.summary}</h3>
        {request.llmReview.reasons.length > 0 && <div><strong>判断理由</strong><ul>{request.llmReview.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
        {request.llmReview.hazards.length > 0 && <div className='hazards'><strong>风险点</strong><ul>{request.llmReview.hazards.map((hazard, index) => <li key={index}>{hazard}</li>)}</ul></div>}
        {request.llmReview.assumptions.length > 0 && <div><strong>路径与环境假设</strong><ul>{request.llmReview.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></div>}
        <footer><span>{request.llmReview.model}</span><span>{new Date(request.llmReview.reviewedAt).toLocaleString('zh-CN')}</span></footer>
      </>}
      <small>LLM 仅提供安全辅助判断，不能覆盖本地高危规则。</small>
    </section>}
    {error && <p className='form-error'>{error}</p>}
    <div className='detail-actions'>
      <span>请求键：{request.requestId}</span>
      <button className='button-secondary' type='button' onClick={onOpen}>打开终端</button>
      <button className='button-danger' type='button' disabled={busy} onClick={onReject}>拒绝</button>
      {request.command && request.risk !== 'write' && request.risk !== 'delete' && <button className='button-secondary button-safe-command' type='button' disabled={busy} onClick={onRemember}>作为安全命令批准</button>}
      <button className='button-primary' type='button' disabled={busy} onClick={onApprove}>{busy ? '请稍后…' : '批准这一次'}</button>
    </div>
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
  const unresponsive = session.attentionKind === 'host-unresponsive'
  return <div className='attention-detail-inner'>
    <p className='detail-kicker recovery'>{unresponsive ? '终端无响应 · 等待人工确认' : '异常恢复 · 已停止自动重试'}</p>
    <h2>{session.displayName + (unresponsive ? ' 疑似卡死' : ' 需要人工处理')}</h2>
    <p className='detail-subtitle'>{unresponsive ? 'Manager 不会自动重启，也不会发送 Continue。确认后才会释放当前受管终端并恢复会话。' : '终端和原生会话仍然保留，Manager 不会主动关闭窗口。'}</p>
    <section className='command-card'>
      <div className='command-label'><span>最近错误</span><span>{session.agentKind.toUpperCase()}</span></div>
      <pre>{session.lastError ?? '未记录具体错误'}</pre>
      <div className='command-path'>工作目录：{session.workspace}</div>
    </section>
    <div className='approval-facts'>
      <div><span>恢复次数</span><strong className='write'>{session.recoveryAttempts}</strong></div>
      <div><span>当前状态</span><strong className='write'>等待人工处理</strong></div>
      <div><span>终端进程</span><strong className={unresponsive ? 'write' : 'read'}>{unresponsive ? '等待确认重启' : '保持运行'}</strong></div>
      <div><span>正常完成</span><strong className='read'>不会误触发</strong></div>
    </div>
    {error && <p className='form-error'>{error}</p>}
    <div className='detail-actions'><span>{unresponsive ? '只有确认后才会结束旧进程' : '本次只尝试恢复一次'}</span><button className='button-secondary' type='button' onClick={onOpen}>打开终端</button><button className='button-primary' type='button' disabled={busy} onClick={onContinue}>{busy ? '请稍后…' : unresponsive ? '重启 Agent' : '尝试恢复'}</button></div>
  </div>
}

function PolicySummary(): JSX.Element {
  return <section className='policy-summary'>
    <h3>当前安全边界</h3>
    <div><i /><strong>内置只读命令</strong><span>直接批准</span></div>
    <div><i /><strong>普通低风险请求</strong><span>可使用批准全部</span></div>
    <div><i className='danger' /><strong>严重破坏性指令</strong><span>批量批准会跳过</span></div>
  </section>
}
