import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApprovalPolicyEngine } from '../../electron/approval-policy'
import { permissionHookFields } from '../../electron/permission-hook-input'
import { MAX_APPROVAL_COMMAND_LENGTH } from '../../src/shared/approval-input'
import * as approvalRouting from '../../electron/approval-routing'
import { LlmReviewerPoolError } from '../../electron/llm-security-reviewer'
import { SessionController, type LlmApprovalReviewPort, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostHandle, HostRecord } from '../../electron/session-host-manager'
import type { ApprovalMode, LlmReviewConclusion } from '../../src/shared/manager-api'
import type { HostEvent } from '../../src/shared/protocol'

class ApprovalHandle implements HostHandle {
  constructor(readonly hostId = 'approval-mode-host') {}
  readonly writes: string[] = []
  readonly permissionResponses: Array<{ requestId: string; action: 'allow' | 'ask' | 'deny' }> = []
  readonly permissionReasons: Array<string | undefined> = []
  permissionHook?: 'claude' | 'codex' = 'codex'
  readonly stop = vi.fn(async (): Promise<void> => undefined)
  readonly preserveOnDisconnect = vi.fn(async () => undefined)
  readonly resumeManagement = vi.fn()
  readonly ping = vi.fn(async (): Promise<'managed'> => 'managed')
  private readonly events: Array<HostEvent | Error> = []
  private readonly waiters: Array<{ resolve: (event: HostEvent) => void; reject: (error: Error) => void }> = []

  nextEvent(): Promise<HostEvent> {
    const event = this.events.shift()
    if (event instanceof Error) return Promise.reject(event)
    return event ? Promise.resolve(event) : new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  emit(event: HostEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }
  fail(error: Error): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.reject(error)
    else this.events.push(error)
  }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  async replay(): Promise<string> { return '' }
  disconnect(): void {}
  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny', reason?: string): void {
    this.permissionResponses.push({ requestId, action })
    this.permissionReasons.push(reason)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function conclusion(verdict: LlmReviewConclusion['verdict']): LlmReviewConclusion {
  return { verdict, riskScore: verdict === 'allow' ? 5 : 90, summary: `review-${verdict}`, reasons: ['fixture evidence'], hazards: [], assumptions: [], requiresHumanApproval: verdict !== 'allow', model: 'fixture-reviewer', reviewedAt: 1 }
}

const ordinaryCommand = 'git status --short'
const highRiskCommand = 'Remove-Item -LiteralPath .\\cache -Recurse -Force'
const workspace = 'B:\\work'

function fixture(kind: 'codex' | 'claude' = 'codex') {
  const handle = new ApprovalHandle()
  handle.permissionHook = kind
  const manager: SessionHostManagerPort = {
    start: vi.fn(async () => handle), reconnect: vi.fn(async () => handle),
    listLiveHosts: vi.fn(async (): Promise<HostRecord[]> => []),
    readLastExit: vi.fn(async () => undefined), updateMetadata: vi.fn(async () => undefined),
    removeArtifacts: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  }
  const policy = new ApprovalPolicyEngine()
  const reviewer = {
    getSettings: vi.fn(() => ({ enabled: true, level: 'high' as const })),
    reviewApproval: vi.fn<LlmApprovalReviewPort['reviewApproval']>(async () => conclusion('allow')),
  }
  const activity = { pending: vi.fn(), approved: vi.fn(), blocked: vi.fn(), rejected: vi.fn(), reviewStarted: vi.fn(), reviewed: vi.fn(), reviewFailed: vi.fn() }
  const controller = new SessionController(manager, undefined, undefined, policy, undefined, activity, undefined, undefined, undefined, reviewer)
  const start = (recoverable = false) => controller.startSession({ displayName: 'approval fixture', agentKind: kind, workspace, executable: kind, args: [], cols: 100, rows: 30, nativeSessionId: 'fixture-native-session',
    ...(recoverable ? { recovery: { executable: kind, args: ['resume', 'fixture-native-session'] } } : {}),
  })
  const emitApproval = (requestId: string, command = highRiskCommand, overrides: Partial<Extract<HostEvent, { type: 'permission-request' }>> = {}) => handle.emit({
    type: 'permission-request', hookSource: kind, requestId, toolName: 'PowerShell', command,
    operation: command === ordinaryCommand ? 'read' : 'delete', cwd: workspace,
    toolInput: { command, cwd: workspace }, ...overrides,
  })
  const setMode = async (sessionId: string, mode: ApprovalMode) => {
    if (mode === 'unattended') await controller.setUnattendedMode(sessionId, { enabled: true, endWord: 'TEST-DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 0 })
    else await controller.setApprovalMode(sessionId, mode)
  }
  return { controller, handle, manager, policy, reviewer, activity, start, emitApproval, setMode }
}

async function drain(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

describe('controller approval modes acceptance', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers() })

  const cases = (['codex', 'claude'] as const).flatMap(kind =>
    (['manual', 'agent-review', 'rules-auto', 'unattended'] as const).flatMap(mode =>
      (['ordinary', 'high-risk'] as const).map(risk => ({ kind, mode, risk }))))

  it.each(cases)('$kind $mode handles $risk operations with the selected mode only', async ({ kind, mode, risk }) => {
    const f = fixture(kind)
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('matrix-request', risk === 'ordinary' ? ordinaryCommand : highRiskCommand)
    await drain()
    if (mode === 'unattended') await vi.advanceTimersByTimeAsync(5000)

    const expectedAction = mode === 'manual' ? undefined : mode === 'rules-auto' && risk === 'high-risk' ? 'deny' : 'allow'
    expect(f.handle.permissionResponses).toEqual(expectedAction ? [{ requestId: 'matrix-request', action: expectedAction }] : [])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(mode === 'agent-review' && risk === 'high-risk' ? 1 : 0)
    expect(f.controller.listPendingApprovals()).toHaveLength(expectedAction ? 0 : 1)
    expect(f.controller.listSessions()[0]?.approvalMode).toBe(mode)
    expect(f.activity.pending).toHaveBeenCalledTimes(mode === 'manual' ? 1 : 0)
  })

  it('manual mode ignores both built-in and saved allow rules', async () => {
    const f = fixture()
    const session = await f.start()
    f.policy.addRule('git log --oneline')
    expect(f.policy.decide(ordinaryCommand).action).toBe('auto-approve')
    expect(f.policy.decide('git log --oneline').action).toBe('auto-approve')
    await f.setMode(session.sessionId, 'manual')
    f.emitApproval('built-in-allow', ordinaryCommand)
    f.emitApproval('saved-allow', 'git log --oneline', { operation: 'read' })
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals().map(request => request.requestId)).toEqual(['built-in-allow', 'saved-allow'])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it.each(['agent-review', 'rules-auto'] as const)('%s auto-approves ordinary writes and unknown tools without a model call', async mode => {
    const f = fixture()
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('ordinary-write', 'Set-Content -LiteralPath .\\notes.txt updated', { operation: 'write' })
    f.emitApproval('ordinary-build', 'npm test', { operation: 'unknown' })
    f.emitApproval('ordinary-tool', 'tool:InspectResource', { operation: 'unknown', toolName: 'InspectResource', toolInput: { resource: 'project-metadata' } })
    await drain()
    expect(f.handle.permissionResponses).toEqual([
      { requestId: 'ordinary-write', action: 'allow' },
      { requestId: 'ordinary-build', action: 'allow' },
      { requestId: 'ordinary-tool', action: 'allow' },
    ])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each((['codex', 'claude'] as const).flatMap(kind =>
    (['allow', 'deny', 'manual', 'uncertain'] as const).map(verdict => ({ kind, verdict }))))('applies a $kind high-risk reviewer $verdict verdict exactly once', async ({ kind, verdict }) => {
    const f = fixture(kind)
    const session = await f.start()
    f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('verdict')
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    const [reviewed, reason, signal] = f.reviewer.reviewApproval.mock.calls[0]!
    expect(reviewed).toMatchObject({ command: highRiskCommand, workspace, hookCwd: workspace })
    expect(reason).toEqual(expect.any(String))
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'verdict', action: verdict === 'allow' ? 'allow' : 'deny' }])
    expect(f.controller.listPendingApprovals()).toEqual([])
    const expectedVerdict = verdict === 'allow' ? 'allow' : 'deny'
    expect(f.activity.reviewed).toHaveBeenCalledWith(
      expect.objectContaining({ llmReview: expect.objectContaining({ verdict: expectedVerdict, requiresHumanApproval: false }) }),
      expect.objectContaining({ verdict: expectedVerdict, requiresHumanApproval: false }),
    )
    expect(f.activity.pending).not.toHaveBeenCalled()
    if (verdict !== 'allow') expect(f.handle.permissionReasons[0]).toContain('实质更安全的新请求')
  })

  it('rejects a failed reviewer request and reports the service failure without waiting for a human', async () => {
    const f = fixture()
    const session = await f.start()
    f.reviewer.reviewApproval.mockRejectedValue(new Error('fixture timeout'))
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('failed-review')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'failed-review', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain('审核不可用不代表该命令已被判定危险')
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.reviewFailed).toHaveBeenCalledOnce()
    expect(f.activity.reviewFailed).toHaveBeenCalledWith(expect.objectContaining({
      llmReviewStatus: 'failed', llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false, riskScore: 0 }),
    }), expect.stringContaining('fixture timeout'))
    expect(f.handle.permissionReasons[0]).toContain('检查审核服务连接、模型和协议配置')
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it('normalizes an allow-with-human-condition to denial before storing or auditing it', async () => {
    const f = fixture()
    const legacy = { ...conclusion('allow'), requiresHumanApproval: true, reviewerId: 'legacy-reviewer', reviewerName: 'Legacy fixture' }
    f.reviewer.reviewApproval.mockResolvedValue(legacy)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('conditional-allow')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'conditional-allow', action: 'deny' }])
    expect(f.activity.reviewed).toHaveBeenCalledWith(expect.objectContaining({
      llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false }),
    }), expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false, reviewerId: 'legacy-reviewer', reviewerName: 'Legacy fixture' }))
    expect(legacy.requiresHumanApproval).toBe(true)
    expect(f.activity.pending).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('preserves safe failover attempts on the final service-unavailable denial', async () => {
    const f = fixture()
    const attempts = [
      { reviewerId: 'reviewer-a', reviewerName: 'A', backend: 'api' as const, status: 'failed' as const, failure: 'timeout' as const },
      { reviewerId: 'reviewer-b', reviewerName: 'B', backend: 'api' as const, status: 'failed' as const, failure: 'network' as const },
    ]
    f.reviewer.reviewApproval.mockRejectedValue(new LlmReviewerPoolError('all-failed', attempts))
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('all-reviewers-failed'); await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'all-reviewers-failed', action: 'deny' }])
    expect(f.activity.reviewFailed).toHaveBeenCalledWith(expect.objectContaining({
      llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false, attempts }),
    }), expect.stringContaining('全部 2 个审核服务均失败'))
    expect(f.activity.pending).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('rejects synchronous reviewer failures without leaving a pending request', async () => {
    const f = fixture()
    f.reviewer.reviewApproval.mockImplementation(() => { throw new Error('fixture synchronous service failure') })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('sync-failure')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'sync-failure', action: 'deny' }])
    expect(f.activity.reviewFailed).toHaveBeenCalledWith(expect.objectContaining({
      llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false }),
    }), expect.stringContaining('fixture synchronous service failure'))
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it('rejects a result if its reviewer became disabled while it was running', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('disabled-in-flight')
    await drain()
    f.reviewer.getSettings.mockReturnValue({ enabled: false, level: 'high' })
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'disabled-in-flight', action: 'deny' }])
    expect(f.activity.reviewed).not.toHaveBeenCalled()
    expect(f.activity.reviewFailed).toHaveBeenCalledOnce()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('records denial when the final local assessment finds incomplete arguments after an allow', async () => {
    const f = fixture()
    vi.spyOn(f.policy, 'decide').mockReturnValue({ action: 'manual', risk: 'delete', reason: 'fixture risk' })
    vi.spyOn(f.policy, 'assessApprovalRequest')
      .mockReturnValueOnce({ status: 'high-risk', reason: 'fixture review required', reasonCode: 'fixture', matchedRules: [] })
      .mockReturnValueOnce({ status: 'incomplete', reason: 'fixture missing full parameters', reasonCode: 'fixture-incomplete', matchedRules: [] })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('incomplete-on-recheck')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'incomplete-on-recheck', action: 'deny' }])
    expect(f.activity.reviewed).toHaveBeenCalledWith(expect.objectContaining({
      llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false }),
    }), expect.objectContaining({ verdict: 'deny', summary: 'fixture missing full parameters' }))
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each(['unexpected-route', 'assessment-error'] as const)('rejects automatic %s without invoking a human fallback', async scenario => {
    const f = fixture()
    if (scenario === 'unexpected-route') vi.spyOn(approvalRouting, 'routeApproval').mockReturnValueOnce('manual')
    else {
      vi.spyOn(f.policy, 'decide').mockReturnValue({ action: 'manual', risk: 'unknown', reason: 'fixture preliminary assessment' })
      vi.spyOn(f.policy, 'assessApprovalRequest').mockImplementationOnce(() => { throw new Error('fixture rules unavailable') })
    }
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('unexpected', ordinaryCommand)
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'unexpected', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain('不转人工')
    expect(f.activity.pending).not.toHaveBeenCalled()
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('keeps ordinary bulk approval from overriding an automatic review', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    vi.spyOn(f.policy, 'assessApprovalRequest').mockReturnValue({ status: 'high-risk', reason: 'fixture rule', reasonCode: 'fixture', matchedRules: [] })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('review-in-progress', ordinaryCommand)
    await drain()
    expect(await f.controller.approveAllPending()).toEqual({ approved: 0, failed: 0, skipped: 1, skippedRequestIds: ['review-in-progress'] })
    expect(f.handle.permissionResponses).toEqual([])
    pending.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'review-in-progress', action: 'deny' }])
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each(['allow', 'deny', 'manual', 'uncertain', 'error', 'disabled'] as const)('terminal agent review reaches one binary action for %s', async verdict => {
    const f = fixture()
    f.handle.permissionHook = undefined
    if (verdict === 'error') f.reviewer.reviewApproval.mockRejectedValue(new Error('fixture terminal reviewer unavailable'))
    else if (verdict === 'disabled') f.reviewer.getSettings.mockReturnValue({ enabled: false, level: 'high' })
    else f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.handle.emit({ type: 'output', data: 'Would you like to run the following command?\r\n$ ' + highRiskCommand + '\r\n1. Yes, proceed\r\n2. No' })
    await drain()
    expect(f.handle.writes).toEqual([verdict === 'allow' ? '\r' : '\x1b'])
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it.each(['ordinary', 'high-risk', 'incomplete'] as const)('terminal rules auto handles %s without waiting for a user', async risk => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    const command = risk === 'ordinary' ? ordinaryCommand : risk === 'incomplete' ? 'tool:Shell' : highRiskCommand
    f.handle.emit({ type: 'output', data: 'Would you like to run the following command?\r\n$ ' + command + '\r\n1. Yes, proceed\r\n2. No' })
    await drain()
    expect(f.handle.writes).toEqual([risk === 'ordinary' ? '\r' : '\x1b'])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it.each(['agent-review', 'rules-auto'] as const)('%s rejects truncated requests without consulting the reviewer', async mode => {
    const f = fixture()
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('truncated', highRiskCommand, { inputTruncated: true })
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'truncated', action: 'deny' }])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toHaveLength(0)
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it.each((['codex', 'claude'] as const).flatMap(kind => (['agent-review', 'rules-auto'] as const).map(mode => ({ kind, mode }))))('$kind $mode approves intact JSON writes beyond the former hook cap without AI review', async ({ kind, mode }) => {
    const f = fixture(kind)
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    const command = "Set-Content -LiteralPath '.\\cache.json' -Value '" + JSON.stringify({ data: 'a'.repeat(17000) }) + "'"
    f.emitApproval('large-json', command, { ...permissionHookFields({ command }), operation: 'write' })
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'large-json', action: 'allow' }])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.activity.approved.mock.calls[0]?.[0].command).toBe(command)
  })

  it.each(['codex', 'claude'] as const)('%s preserves safe input diagnostics and returns a precise oversize refusal', async kind => {
    const f = fixture(kind)
    const session = await f.start()
    const command = 'echo ' + 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH)
    const fields = permissionHookFields({ command })
    f.emitApproval('large-input', 'tool:PowerShell', {
      ...fields, toolInput: { command }, inputIssue: { ...fields.inputIssue!, message: 'fixture-private-value' } as NonNullable<typeof fields.inputIssue>,
    })
    await drain()
    expect(f.controller.listPendingApprovals()[0]?.inputIssue).toEqual(fields.inputIssue)
    await f.setMode(session.sessionId, 'agent-review')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'large-input', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain(String(command.length))
    expect(f.handle.permissionReasons[0]).toContain(String(MAX_APPROVAL_COMMAND_LENGTH))
    expect(f.handle.permissionReasons[0]).not.toMatch(/截断|fixture-private-value/)
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude'] as const)('%s rejects without human handoff when the reviewer is disabled', async kind => {
    const f = fixture(kind)
    f.reviewer.getSettings.mockReturnValue({ enabled: false, level: 'high' })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('disabled')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'disabled', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain('不转人工')
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.reviewFailed).toHaveBeenCalledWith(expect.objectContaining({
      llmReview: expect.objectContaining({ verdict: 'deny', requiresHumanApproval: false }),
    }), expect.stringContaining('不是命令危险性的结论'))
    expect(f.activity.pending).not.toHaveBeenCalled()
  })

  it('stops safely if a rejection cannot reach its exact hook, without leaving a human approval queued', async () => {
    const f = fixture()
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(async () => false) })
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('lost-hook')
    await drain()
    expect(f.handle.stop).toHaveBeenCalledOnce()
    expect(f.handle.writes).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.controller.listSessions()[0]).toMatchObject({ status: 'failed', userStopRequested: true })
  })

  it.each(['allow', 'deny'] as const)('a late failed %s delivery cannot stop a replacement host', async verdict => {
    const f = fixture()
    const delivery = deferred<boolean>()
    const checked = vi.fn(() => delivery.promise)
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    const session = await f.start(true)
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-delivery'); await drain()
    expect(checked).toHaveBeenCalledOnce()
    await f.controller.stopSession(session.sessionId)
    const replacement = new ApprovalHandle('replacement-host')
    vi.mocked(f.manager.start).mockResolvedValueOnce(replacement)
    await f.controller.restartSession(session.sessionId)
    delivery.resolve(false); await drain()
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(f.controller.listSessions()[0]).toMatchObject({ status: 'running', userStopRequested: false })
    expect(f.activity.blocked).not.toHaveBeenCalled()
  })

  it.each((['codex', 'claude'] as const).flatMap(kind =>
    (['allow', 'deny'] as const).map(verdict => ({ kind, verdict }))))('a late successful $kind $verdict receipt cannot consume a replacement request', async ({ kind, verdict }) => {
    const f = fixture(kind)
    const delivery = deferred<boolean>()
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(() => delivery.promise) })
    f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    const session = await f.start(true)
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('reused-request-id'); await drain()
    await f.controller.stopSession(session.sessionId)
    const replacement = new ApprovalHandle('replacement-host')
    replacement.permissionHook = kind
    vi.mocked(f.manager.start).mockResolvedValueOnce(replacement)
    await f.controller.restartSession(session.sessionId)
    await f.setMode(session.sessionId, 'manual')
    replacement.emit({ type: 'permission-request', hookSource: kind, requestId: 'reused-request-id', toolName: 'PowerShell',
      command: highRiskCommand, operation: 'delete', cwd: workspace, toolInput: { command: highRiskCommand, cwd: workspace } })
    await drain()
    delivery.resolve(true); await drain()
    expect(f.controller.listPendingApprovals()).toEqual([expect.objectContaining({ requestId: 'reused-request-id' })])
    expect(replacement.permissionResponses).toEqual([])
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(f.activity.approved).not.toHaveBeenCalled()
    expect(f.activity.rejected).not.toHaveBeenCalled()
  })

  it.each(['user-stop', 'manual-mode'] as const)('a late rejected delivery preserves an explicit %s', async action => {
    const f = fixture()
    const delivery = deferred<boolean>()
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(() => delivery.promise) })
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('delayed-deny'); await drain()
    if (action === 'user-stop') await f.controller.stopSession(session.sessionId)
    else await f.setMode(session.sessionId, 'manual')
    delivery.reject(new Error('synthetic response failure')); await drain()
    expect(f.handle.stop).toHaveBeenCalledTimes(action === 'user-stop' ? 1 : 0)
    expect(f.controller.listSessions()[0]?.status).toBe(action === 'user-stop' ? 'stopped' : 'needs_approval')
    expect(f.activity.blocked).not.toHaveBeenCalled()
  })

  it('re-routes an undelivered old rejection under a newly selected automatic mode', async () => {
    const f = fixture()
    const delivery = deferred<boolean>()
    const checked = vi.fn().mockReturnValueOnce(delivery.promise).mockResolvedValue(true)
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('switched-delivery'); await drain()
    await f.setMode(session.sessionId, 'agent-review')
    delivery.resolve(false); await drain()
    expect(checked.mock.calls.map((call) => call[1])).toEqual(['deny', 'allow'])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    expect(f.handle.stop).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('does not let an old terminal denial check stop a newly selected mode', async () => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const prompt = 'Would you like to run the following command?\r\n$ ' + highRiskCommand + '\r\n1. Yes, proceed\r\n2. No'
    vi.spyOn(f.handle, 'replay').mockResolvedValue(prompt)
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.handle.emit({ type: 'output', data: prompt }); await drain()
    await f.setMode(session.sessionId, 'agent-review')
    await vi.advanceTimersByTimeAsync(1100)
    expect(f.handle.stop).not.toHaveBeenCalled()
    expect(f.activity.blocked).not.toHaveBeenCalled()
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('agent-review')
  })

  it.each(['user-stop', 'restart'] as const)('a delayed automatic stop receipt cannot overwrite a later %s', async action => {
    const f = fixture()
    const stopping = deferred<void>()
    f.handle.stop.mockReturnValueOnce(stopping.promise)
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(async () => false) })
    const session = await f.start(true)
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('failed-delivery'); await drain()
    expect(f.handle.stop).toHaveBeenCalledOnce()
    const replacement = new ApprovalHandle('replacement-host')
    if (action === 'user-stop') await f.controller.stopSession(session.sessionId)
    else {
      vi.mocked(f.manager.start).mockResolvedValueOnce(replacement)
      await f.controller.restartSession(session.sessionId)
    }
    stopping.resolve(); await drain()
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(f.controller.listSessions()[0]?.status).toBe(action === 'user-stop' ? 'stopped' : 'running')
  })

  it.each(['manual', 'rules-auto', 'agent-review'] as const)('%s handles exhausted terminal approval retries without changing manual behavior', async mode => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.handle.emit({ type: 'output', data: 'Would you like to run the following command?\r\n$ git status --short\r\n1. Yes, proceed\r\n2. No' })
    await drain()
    if (mode === 'manual') await f.controller.approveSession(session.sessionId)
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.controller.listPendingApprovals()).toHaveLength(mode === 'manual' ? 1 : 0)
    expect(f.handle.stop).toHaveBeenCalledTimes(mode === 'manual' ? 0 : 1)
    expect(f.controller.listSessions()[0]?.status).toBe(mode === 'manual' ? 'needs_approval' : 'failed')
    if (mode !== 'manual') expect(f.activity.blocked).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('重试耗尽'))
  })

  it.each(['still-pending', 'closed', 'new-command'] as const)('checks the exact terminal approval after a rejection: %s', async outcome => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const prompt = (command: string) => 'Would you like to run the following command?\r\n$ ' + command + '\r\n1. Yes, proceed\r\n2. No'
    vi.spyOn(f.handle, 'replay').mockResolvedValue(outcome === 'closed' ? 'Codex\r\n›\r\n' : prompt(outcome === 'new-command' ? ordinaryCommand : highRiskCommand))
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.handle.emit({ type: 'output', data: prompt(highRiskCommand) }); await drain()
    expect(f.handle.writes).toEqual(['\x1b'])
    await vi.advanceTimersByTimeAsync(1100)
    expect(f.handle.stop).toHaveBeenCalledTimes(outcome === 'still-pending' ? 1 : 0)
    expect(f.controller.listPendingApprovals()).toEqual([])
    if (outcome === 'still-pending') expect(f.activity.blocked).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('自动拒绝按键已发送'))
  })

  it.each([true, false])('checks a Claude denial and an alias arriving during its ACK (alias delivered: %s)', async aliasDelivered => {
    const f = fixture('claude')
    const primary = deferred<boolean>()
    const checked = vi.fn((id: string) => id === 'primary' ? primary.promise : Promise.resolve(aliasDelivered))
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    f.reviewer.reviewApproval.mockResolvedValue(conclusion('deny'))
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('primary', highRiskCommand, { toolUseId: 'shared-tool' }); await drain()
    f.emitApproval('child-alias', highRiskCommand, { toolUseId: 'shared-tool', agentId: 'child-agent' }); await drain()
    expect(checked).toHaveBeenCalledOnce()
    primary.resolve(true); await drain()
    expect(checked.mock.calls.map(([id]) => id)).toEqual(['primary', 'child-alias'])
    expect(checked).toHaveBeenCalledWith('child-alias', 'deny', expect.stringContaining('实质更安全的新请求'))
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.handle.stop).toHaveBeenCalledTimes(aliasDelivered ? 0 : 1)
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each([true, false])('checks a Claude automatic allow and its in-flight alias (alias delivered: %s)', async aliasDelivered => {
    const f = fixture('claude')
    const primary = deferred<boolean>()
    const checked = vi.fn((id: string) => id === 'primary-allow' ? primary.promise : Promise.resolve(aliasDelivered))
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('primary-allow', highRiskCommand, { toolUseId: 'shared-tool' }); await drain()
    f.emitApproval('child-allow-alias', highRiskCommand, { toolUseId: 'shared-tool', agentId: 'child-agent' }); await drain()
    expect(checked).toHaveBeenCalledOnce()
    expect(f.activity.approved).not.toHaveBeenCalled()
    primary.resolve(true); await drain()
    expect(checked.mock.calls.map(([id]) => id)).toEqual(['primary-allow', 'child-allow-alias'])
    expect(checked).toHaveBeenCalledWith('child-allow-alias', 'allow', undefined)
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.handle.stop).toHaveBeenCalledTimes(aliasDelivered ? 0 : 1)
    expect(f.activity.approved).toHaveBeenCalledTimes(aliasDelivered ? 1 : 0)
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each(['manual', 'rules-auto'] as const)('cancels a pending review when switching to %s and ignores a late allow', async mode => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-review')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    expect(signal.aborted).toBe(false)
    await f.setMode(session.sessionId, mode)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual(mode === 'rules-auto' ? [{ requestId: 'old-review', action: 'deny' }] : [])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
  })

  it('changes the effective mode and cancels reviews before a deferred metadata write finishes', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-review')
    await drain()
    const persisted = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(persisted.promise)
    const switching = f.controller.setApprovalMode(session.sessionId, 'manual')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('manual')
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    f.emitApproval('arrived-during-save', ordinaryCommand)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    persisted.resolve()
    await switching
    expect(f.controller.listPendingApprovals().map(request => request.requestId)).toEqual(['old-review', 'arrived-during-save'])
  })

  it('falls back to manual if enabling an automatic mode cannot be persisted', async () => {
    const f = fixture()
    const session = await f.start()
    vi.mocked(f.manager.updateMetadata).mockRejectedValueOnce(new Error('fixture persistence failure'))
    await expect(f.controller.setApprovalMode(session.sessionId, 'rules-auto')).rejects.toThrow('fixture persistence failure')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('manual')
    f.emitApproval('after-failed-save', ordinaryCommand)
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer mode when an older metadata write fails', async () => {
    const f = fixture()
    const session = await f.start()
    const firstSave = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(firstSave.promise)
    const firstSwitch = f.controller.setApprovalMode(session.sessionId, 'rules-auto')
    const firstOutcome = expect(firstSwitch).rejects.toThrow('old metadata failure')
    await drain()
    const secondSwitch = f.controller.setApprovalMode(session.sessionId, 'agent-review')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('agent-review')
    firstSave.reject(new Error('old metadata failure'))
    await firstOutcome
    await secondSwitch
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('agent-review')
  })

  it('does not re-enable unattended after a newer mode supersedes its pending save', async () => {
    const f = fixture()
    const session = await f.start()
    const firstSave = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(firstSave.promise)
    const enabling = f.controller.setUnattendedMode(session.sessionId, { enabled: true, endWord: 'TEST-DONE', recoveryWord: 'continue' })
    await drain()
    const switching = f.controller.setApprovalMode(session.sessionId, 'rules-auto')
    firstSave.resolve()
    await enabling
    await switching
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('rules-auto')
    expect(f.controller.listSessions()[0]?.unattended?.enabled).not.toBe(true)
    f.emitApproval('after-unattended-race')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'after-unattended-race', action: 'deny' }])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it.each(['stop', 'ctrl-c', 'escape'] as const)('%s cancels a pending review and ignores its late verdict', async action => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('interrupted')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    if (action === 'stop') await f.controller.stopSession(session.sessionId)
    else f.controller.write(session.sessionId, action === 'ctrl-c' ? '\x03' : '\x1b')
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    if (action === 'stop') expect(f.handle.stop).toHaveBeenCalledOnce()
  })

  it('replaces a pending review when a same-ID request carries refined command and tool arguments', async () => {
    const f = fixture()
    const first = deferred<LlmReviewConclusion>()
    const second = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('refined')
    await drain()
    const refinedCommand = 'Remove-Item -LiteralPath .\\logs -Recurse -Force'
    f.emitApproval('refined', refinedCommand)
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(2)
    const [oldCall, newCall] = f.reviewer.reviewApproval.mock.calls
    expect(oldCall![2]!.aborted).toBe(true)
    expect(newCall![2]!.aborted).toBe(false)
    expect(newCall![0]).toMatchObject({ command: refinedCommand, toolInput: { command: refinedCommand } })
    first.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    second.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'refined', action: 'deny' }])
  })

  it('does not duplicate a pending review when an unchanged same-ID hook is re-emitted', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('repaint')
    await drain()
    f.emitApproval('repaint')
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    expect(f.controller.listPendingApprovals()[0]?.llmReviewStatus).toBe('pending')
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'repaint', action: 'allow' }])
  })

  it('manual approval wins a race with a late reviewer denial without a duplicate response', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('human-choice')
    await drain()
    await f.controller.approveRequest('human-choice')
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    pending.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'human-choice', action: 'allow' }])
  })

  it('cancels an abandoned hook request rather than leaving its reviewer running', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('closed-hook')
    await drain()
    f.handle.emit({ type: 'permission-hook-closed', hookSource: 'codex', requestId: 'closed-hook' })
    await drain()
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each([0, 1])('cancels a pending reviewer when its host exits with code %i', async exitCode => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('host-exit')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    f.handle.emit({ type: 'exit', exitCode })
    await drain()
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('cancels a pending reviewer when the host connection is lost without an exit receipt', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('lost-host')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    f.handle.fail(new Error('fixture socket closed'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
  })

  it('cancels reviewers when preserving sessions and disconnecting the manager', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('preserved-session')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    expect(await f.controller.preserveAllSessions()).toBe(1)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
  })

  it('invalidates a review when the policy or reviewer configuration is refreshed', async () => {
    const f = fixture()
    const first = deferred<LlmReviewConclusion>()
    const second = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('config-change')
    await drain()
    await f.controller.refreshApprovalPolicy()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(2)
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    first.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    second.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'config-change', action: 'deny' }])
  })
})
