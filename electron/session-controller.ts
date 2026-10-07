import { randomUUID } from 'node:crypto'
import { freshSessionArgs } from './session-continuation'
import { normalizeWorkspace } from './native-session-discovery'
import { SessionMessageDelivery } from './session-message-delivery'
import { TerminalInputState } from './terminal-input-state'
import { terminalReplayText } from './terminal-state-replay'
import { UnattendedSupervisor, type UnattendedAudit } from './unattended-supervisor'
import type { UnattendedSettings } from '../src/shared/manager-api'
import { approvalEnterCount, approvalEnterDelay, errorRecoveryPolicy, parseUnattendedSettings, selectedRecoveryEndWord } from '../src/shared/unattended-settings'

import type { HostHandle, HostMetadataUpdate, HostRecord, SessionHostManager, StartHostOptions } from './session-host-manager'
import type { HostEvent, HostExitFact } from '../src/shared/protocol'
import type { AgentConfigSummary, AgentKind, AgentProxySummary, ApprovalRequest, BulkApprovalResult, LlmReviewConclusion, LlmReviewLevel, LlmReviewRouting, ManagerEvent, NativeSessionSummary, SessionSummary, StartSessionRequest } from '../src/shared/manager-api'
import { reduceSession } from '../src/shared/session-state'
import { createAgentAdapter, extractApprovalCommand, type AgentAdapter, type AgentObservation } from './agent-adapters'
import type { NativeActivityBinding, NativeActivityBindingPort, NativeActivityEvent, NativeActivitySession } from './native-session-activity'
import { assessApprovalRequest, canBulkApproveCommand, canFullAutoApprove, type ApprovalDecision, type FullAutoApprovalInput, type LocalApprovalAssessment } from './approval-policy'
import { approvalInputIssueFields } from '../src/shared/approval-input'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import { terminalScrollbackArgs } from './start-request-policy'
import type { StoredManagedSession } from './managed-session-catalog'
import { approvalModeOf, isApprovalMode } from '../src/shared/approval-mode'
import { routeApproval } from './approval-routing'
import { LlmReviewerPoolError } from './llm-security-reviewer'
import type { ApprovalMode } from '../src/shared/manager-api'

export interface SessionHostManagerPort {
  start(options: StartHostOptions): Promise<HostHandle>
  reconnect(hostId: string): Promise<HostHandle>
  listLiveHosts(): Promise<HostRecord[]>
  release?(hostId: string): Promise<void>
  forceRelease?(hostId: string): Promise<void>
  setPreserveOnLeaseExpiry?(value: boolean): void
  readLastExit(hostId: string): Promise<HostExitFact | undefined>
  updateMetadata(hostId: string, update: HostMetadataUpdate): Promise<void>
  removeArtifacts(hostId: string): Promise<void>
}

export interface NativeSessionDiscoveryPort {
  discover(agentKind: AgentKind, workspace: string): Promise<NativeSessionSummary[]>
}

export interface ApprovalPolicyPort {
  assessApprovalRequest?(input: FullAutoApprovalInput): LocalApprovalAssessment
  decide(command: string | undefined): ApprovalDecision
  noteManualApproval(command: string | undefined): { command: string; approvalCount: number } | undefined
  addRule(command: string): Promise<void> | void
  canBulkApproveCommand?(command: string | undefined): boolean
  canFullAutoApprove?(input: Parameters<typeof canFullAutoApprove>[0]): ReturnType<typeof canFullAutoApprove>
}

export interface RecoveryPolicyPort {
  hasRule(reason: string): boolean
  addRule(reason: string): Promise<void> | void
}

export interface ManagedSessionCatalogPort {
  list(): StoredManagedSession[]
  upsert(entry: StoredManagedSession): Promise<void>
  remove(sessionId: string): Promise<void>
  clear(): Promise<void>
  flush(): Promise<void>
}

export interface ContinueKeywordPolicyPort {
  getSettings(): { enabled: boolean; quietSeconds: number; keywords: string[]; maxRetries?: number }
  match(value: string): string | undefined
  matchIncremental?(previous: string, current: string): string | undefined
  maxKeywordLength(): number
}

export interface RecoveryActivityPort {
  keywordMatched(sessionId: string, keyword: string): void
  keywordContinued(sessionId: string, keyword: string): void
  keywordLimitReached?(sessionId: string, count: number): void
  keywordFailed?(sessionId: string, reason: string): void
}

export interface FullAutoActivityPort {
  pending?(request: ApprovalRequest): void
  approved(request: ApprovalRequest): void
  blocked(request: ApprovalRequest, reason: string): void
  rejected?(request: ApprovalRequest, reason: string): void
  reviewStarted?(request: ApprovalRequest): void
  reviewed?(request: ApprovalRequest, conclusion: LlmReviewConclusion): void
  reviewFailed?(request: ApprovalRequest, error: string): void
}

export interface LlmApprovalReviewPort {
  getSettings(): { enabled: boolean; level: LlmReviewLevel }
  reviewApproval(request: ApprovalRequest, localRiskReason?: string, signal?: AbortSignal): Promise<LlmReviewConclusion>
}

interface NativeSessionCapture {
  finalCaptureRequested?: boolean
  baselineIds: Set<string>
  startedAt: number
  attempts: number
  inFlight: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface ClaudeHookIdentity {
  requestId: string
  fingerprint: string
  createdAt: number
  toolUseId?: string
  agentId?: string
  agentType?: string
}

interface RecentClaudeHookApproval extends ClaudeHookIdentity {
  approvedAt: number
}

interface ManagedSession {
  startupAttempt?: number
  startupStillRequested?: () => boolean
  bindingChangeBusy?: boolean
  bindingAwaitingUser?: boolean
  bindingVersion?: number
  unusedFreshSession?: boolean
  summary: SessionSummary
  request?: StartSessionRequest
  handle: HostHandle
  generation: number
  nativeActivityBinding?: NativeActivityBinding & { generation: number; version: number }
  nativeActivityBindingAttempt?: number
  recoveryToken: number
  stopRequestVersion?: number
  hostHealthFailures: number
  pendingUserInterrupt: boolean
  hostTransitioning: boolean
  pendingHostInput: string
  awaitingRecoveryReady: boolean
  agentReady: boolean
  activityInputPending?: boolean
  activityInputState?: TerminalInputState
  suppressTransientRetryUntilReady: boolean
  terminalReplay: TerminalReplayBuffer
  outputSequence: number
  adapter: AgentAdapter
  nativeCapture?: NativeSessionCapture
  pendingApprovalCommand?: string
  approvalRequests: ApprovalRequest[]
  claudeHookIdentities?: Map<string, ClaudeHookIdentity>
  claudeHookAliases?: Map<string, Set<string>>
  recentClaudeHookApprovals?: RecentClaudeHookApproval[]
  pendingClaudeTerminalApproval?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
    observation: AgentObservation
    eventData: string
  }
  pendingCodexTerminalApproval?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
    observation: AgentObservation
    eventData: string
  }
  pendingTerminalAutoApproval?: {
    command: string
    generation: number
    timer: ReturnType<typeof setTimeout>
    onConfirmed?: () => void
    replay: string
  }
  claudeTerminalFallbackBlockedUntil?: number
  lastTerminalAutoApproval?: {
    command: string
    expiresAt: number
  }
  transientRetry?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
  }
  activeRecoveryReason?: string
  pendingContinueSubmit?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
  }
  continueKeywordTail: string
  continueKeywordCount?: number
  continueKeywordLimitLogged?: boolean
  continueKeywordNativeText?: string
  continueKeywordSuppressedUntil?: number
  continueKeywordAttempted: Set<string>
  pendingKeywordContinue?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
    keyword: string
    outputSequence: number
  }
}

interface ApprovalDeliveryContext { generation: number; handle: HostHandle; modeVersion: number | undefined; bindingVersion: number | undefined }

type Emit = (event: ManagerEvent) => void

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out waiting for host event/i.test(error.message)
}

function isTerminalStatus(status: SessionSummary['status']): boolean {
  return status === 'completed' || status === 'stopped' || status === 'failed'
}

const HOST_HEALTH_PROBE_TIMEOUT_MS = 1_000
const HOST_HEALTH_FAILURE_LIMIT = 3

const TRANSIENT_RETRY_DELAY_MS = 3_000
const MAX_PENDING_HOST_INPUT = 64 * 1024
const CLAUDE_TERMINAL_APPROVAL_FALLBACK_MS = 1_000
const CODEX_TERMINAL_APPROVAL_FALLBACK_MS = 1_000
const CLAUDE_TERMINAL_REDRAW_GUARD_MS = 3_000
const CLAUDE_HOOK_DUPLICATE_WINDOW_MS = 3_000
const TERMINAL_AUTO_APPROVAL_REDRAW_GUARD_MS = 3_000

// Codex can paint the approval OSC marker before its raw-input prompt is ready.
// Keep a single short fallback so a swallowed first Enter does not require a
// resize/redraw to be discovered, while never retrying indefinitely.
const TERMINAL_AUTO_APPROVAL_CONFIRM_MS = 250

type ApprovalReviewSubject = Pick<ApprovalRequest, 'risk'>
  & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'inputTruncated' | 'inputIssue' | 'filePath' | 'targetPaths' | 'dangerRuleId' | 'hookCwd' | 'workspace' | 'toolInput'>>

function sameApprovalReviewSubject(
  left: ApprovalReviewSubject,
  right: ApprovalReviewSubject,
): boolean {
  return left.risk === right.risk
    && left.toolName === right.toolName
    && left.command === right.command
    && left.inputSummary === right.inputSummary
    && left.inputTruncated === right.inputTruncated
    && JSON.stringify(left.inputIssue) === JSON.stringify(right.inputIssue)
    && left.filePath === right.filePath
    && left.hookCwd === right.hookCwd
    && left.workspace === right.workspace
    && JSON.stringify(left.toolInput) === JSON.stringify(right.toolInput)
    && left.dangerRuleId === right.dangerRuleId
    && JSON.stringify(left.targetPaths ?? []) === JSON.stringify(right.targetPaths ?? [])
}

/** Legacy adapters may still return human/uncertain conclusions. Normalize the
 * final decision before publishing it to the queue, audit, or delivery code. */
function automaticReviewConclusion(conclusion: LlmReviewConclusion): LlmReviewConclusion {
  if (conclusion.verdict === 'deny' || (conclusion.verdict === 'allow' && conclusion.requiresHumanApproval === false)) {
    return { ...conclusion, requiresHumanApproval: false }
  }
  return {
    ...conclusion,
    verdict: 'deny',
    requiresHumanApproval: false,
    summary: '审核未给出明确且无需人工确认的批准结论，本次已拒绝；这不表示已确认命令危险。请补全目标、完整参数与副作用说明，或改为只读预览后提交新请求。',
  }
}

function unavailableReviewConclusion(reason: string): LlmReviewConclusion {
  return {
    verdict: 'deny', requiresHumanApproval: false,
    // No risk estimate was produced. Failed-status consumers must show the
    // availability reason rather than interpreting this placeholder as low risk.
    riskScore: 0, summary: reason, reasons: [reason], hazards: [], assumptions: [],
    model: 'unavailable', reviewedAt: Date.now(),
  }
}

function isTerminalProtocolResponse(data: string): boolean {
  // A user arrow key is ESC [ C/D. Require at least one parameter for the
  // device-attribute responses ending in c so ESC [ C is never swallowed.
  return /^(?:(?:\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]+c|\x1b\[>[\d;]+c|\x1b\[\?[\d;]+u)|(?:\x1b\](?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}(?:\x07|\x1b\\)))+$/i.test(data)
}

export class SessionController {
  private readonly approvalModeWrites = new Map<string, Promise<void>>()
  private readonly approvalModeVersions = new Map<string, number>()
  private approvalPolicyVersion = 0
  private readonly approvalReviews = new Map<string, { abort: AbortController }>()
  private readonly approvalActions = new Map<string, Promise<void>>()
  private readonly restartingSessions = new Set<string>()
  private readonly nativeSessionReservations = new Map<string, { owner: string; count: number }>()

  private nativeSessionIdentity(request: StartSessionRequest | undefined, summary?: SessionSummary): string | undefined {
    const explicit = summary?.nativeSessionId ?? request?.nativeSessionId
    if (explicit) return explicit
    const args = request?.recovery?.args
    if (!args) return undefined
    if (request.agentKind === 'codex') {
      const index = args.indexOf('resume')
      const id = index < 0 ? undefined : args[index + 1]
      return id && !id.startsWith('-') ? id : undefined
    }
    if (request.agentKind === 'claude') {
      const equals = args.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length)
      if (equals) return equals
      const index = args.findIndex(arg => arg === '--resume' || arg === '-r')
      const id = index < 0 ? undefined : args[index + 1]
      return id && !id.startsWith('-') ? id : undefined
    }
    return undefined
  }

  private reserveNativeSession(kind: AgentKind, nativeSessionId: string | undefined, owner: string): () => void {
    if (!nativeSessionId || (kind !== 'codex' && kind !== 'claude')) return () => undefined
    const key = JSON.stringify([kind, nativeSessionId])
    const pending = this.nativeSessionReservations.get(key)
    if (pending && pending.owner !== owner || this.nativeCaptureReservations.has(nativeSessionId)
      || [...this.sessions.values()].some(other => other.summary.sessionId !== owner
      && other.summary.agentKind === kind && this.nativeSessionIdentity(other.request, other.summary) === nativeSessionId
      && (!isTerminalStatus(other.summary.status) || other.hostTransitioning))) {
      throw new Error('该会话正在另一个窗口中运行或启动，请先停止该窗口')
    }
    const reservation = pending ?? { owner, count: 0 }
    reservation.count += 1
    this.nativeSessionReservations.set(key, reservation)
    return () => {
      reservation.count -= 1
      if (reservation.count === 0 && this.nativeSessionReservations.get(key) === reservation) this.nativeSessionReservations.delete(key)
    }
  }

  private approvalMode(managed: ManagedSession): ApprovalMode {
    return approvalModeOf(managed.summary, this.llmReview?.getSettings().enabled)
  }

  private async writeApprovalModeMetadata(managed: ManagedSession, mode: ApprovalMode): Promise<void> {
    const id = managed.summary.sessionId
    const hostId = managed.handle.hostId
    const previous = this.approvalModeWrites.get(id) ?? Promise.resolve()
    const update = previous.catch(() => undefined).then(() => this.manager.updateMetadata(hostId, {
      approvalMode: mode, fullAutoEnabled: mode === 'rules-auto' || mode === 'agent-review',
    }))
    this.approvalModeWrites.set(id, update)
    const version = this.approvalModeVersions.get(id)
    try { await update } catch (error) {
      if (this.approvalModeVersions.get(id) === version) {
        this.approvalModeVersions.set(id, (version ?? 0) + 1)
        this.cancelSessionReviews(managed)
        this.unattended.disable(id, '模式保存失败，已退回普通模式')
        this.cancelPendingTerminalAutoApproval(managed)
        managed.summary = { ...managed.summary, approvalMode: 'manual', fullAutoEnabled: false }
        this.changed(id)
        await this.catalog?.flush()
      }
      throw error
    } finally { if (this.approvalModeWrites.get(id) === update) this.approvalModeWrites.delete(id) }
  }

  private reportAutomaticApproval(managed: ManagedSession, request: ApprovalRequest): void {
    if (request.source === 'terminal' && managed.summary.agentKind === 'codex') {
      const pending = managed.pendingTerminalAutoApproval
      if (pending && pending.command === request.command) pending.onConfirmed = () => this.fullAutoActivity?.approved(request)
      return
    }
    this.fullAutoActivity?.approved(request)
  }

  private cancelApprovalReview(requestId: string): void {
    this.approvalReviews.get(requestId)?.abort.abort()
    this.approvalReviews.delete(requestId)
  }

  private cancelSessionReviews(managed: ManagedSession): void {
    for (const request of managed.approvalRequests) {
      this.cancelApprovalReview(request.requestId)
      delete request.llmReviewStatus
      delete request.llmReview
      delete request.llmReviewError
    }
  }

  /** Called after rule or reviewer settings change. Old results cannot cross versions. */
  async refreshApprovalPolicy(): Promise<void> {
    this.approvalPolicyVersion += 1
    for (const managed of this.sessions.values()) {
      this.cancelSessionReviews(managed)
      for (const request of [...managed.approvalRequests]) await this.processApproval(managed, request)
    }
  }

  private assessRequest(request: ApprovalRequest): LocalApprovalAssessment {
    const input = { ...request, cwd: request.hookCwd }
    return this.approvalPolicy?.assessApprovalRequest?.(input) ?? assessApprovalRequest(input)
  }

  private async processApproval(managed: ManagedSession, request: ApprovalRequest): Promise<void> {
    if (managed.summary.userStopRequested || managed.hostTransitioning || isTerminalStatus(managed.summary.status)
      || this.approvalActions.has(request.requestId) || !managed.approvalRequests.includes(request)) return
    const mode = this.approvalMode(managed)
    // The supervisor owns unattended timing and continuation, not the rule engine.
    if (mode === 'manual' || mode === 'unattended') return
    let assessment: LocalApprovalAssessment
    let route: ReturnType<typeof routeApproval>
    try {
      assessment = this.assessRequest(request)
      route = routeApproval(mode, assessment)
    } catch {
      await this.rejectAutomaticRequest(managed, request, '本地规则评估未能完成，本次请求未获批准；这不是命令危险性的结论。请检查规则配置后重新提交完整请求')
      return
    }
    request.reason = assessment.reason
    request.dangerRuleId = assessment.matchedRules[0]?.id
    request.dangerRuleName = assessment.matchedRules[0]?.name
    if (route === 'review' && mode === 'agent-review') {
      this.scheduleLlmReview(managed, request, assessment)
      return
    }
    const delivery = this.approvalDeliveryContext(managed)
    try {
      if (route === 'approve') {
        await this.approveRequest(request.requestId, false)
        if (this.sameApprovalDelivery(managed, delivery) && !managed.summary.userStopRequested) this.reportAutomaticApproval(managed, request)
      } else {
        await this.rejectAutomaticRequest(managed, request, route === 'reject'
          ? assessment.reason
          : '自动审批未得到有效的最终处理路径，本次请求已拒绝；请检查审批模式与规则配置后重新提交完整请求')
      }
    } catch {
      await this.stopAfterApprovalDeliveryFailure(managed, request, delivery)
    }
  }

  private approvalDeliveryContext(managed: ManagedSession): ApprovalDeliveryContext {
    return { generation: managed.generation, handle: managed.handle, modeVersion: this.approvalModeVersions.get(managed.summary.sessionId), bindingVersion: managed.bindingVersion }
  }

  private sameApprovalDelivery(managed: ManagedSession, delivery: ApprovalDeliveryContext): boolean {
    return this.sessions.get(managed.summary.sessionId) === managed
      && managed.generation === delivery.generation && managed.handle === delivery.handle
      && managed.bindingVersion === delivery.bindingVersion
  }

  private async stopAfterApprovalDeliveryFailure(managed: ManagedSession, request: ApprovalRequest, delivery: ApprovalDeliveryContext,
    reason = '自动审批响应无法确认送达，已停止会话以避免挂起或误执行；未转人工审批'): Promise<void> {
    if (!this.sameApprovalDelivery(managed, delivery) || managed.hostTransitioning
      || managed.summary.userStopRequested || isTerminalStatus(managed.summary.status)
      || this.approvalMode(managed) === 'manual') return
    if (this.approvalModeVersions.get(managed.summary.sessionId) !== delivery.modeVersion) {
      // The old decision must not stop a newly selected automatic mode. Its
      // failed action has settled; re-route any surviving request in that mode.
      const current = managed.approvalRequests.find(item => item.requestId === request.requestId)
      if (current) await this.processApproval(managed, current)
      return
    }
    this.fullAutoActivity?.blocked(request, reason)
    const stopping = this.stopSession(managed.summary.sessionId)
    const stopRequestVersion = managed.stopRequestVersion
    await stopping
    // The old host's stop receipt can arrive after a user stop or restart.
    if (!this.sameApprovalDelivery(managed, delivery) || managed.stopRequestVersion !== stopRequestVersion
      || this.approvalModeVersions.get(managed.summary.sessionId) !== delivery.modeVersion
      || managed.summary.status !== 'stopped' || this.approvalMode(managed) === 'manual') return
    managed.approvalRequests = []
    this.syncApprovalSummary(managed)
    managed.summary = { ...managed.summary, status: 'failed', lastError: reason }
    this.changed(managed.summary.sessionId)
  }

  private async rejectAutomaticRequest(managed: ManagedSession, request: ApprovalRequest, reason: string, reviewUnavailable = false): Promise<void> {
    const delivery = this.approvalDeliveryContext(managed)
    const message = '自动审批拒绝：' + reason.slice(0, 1400)
      + (reviewUnavailable
        ? '\n本模式不转人工。请检查审核服务连接、模型和协议配置，恢复后重新提交完整请求；也可改为无需该操作的安全替代方案。服务仍不可用时结束该步骤并报告原因，不要反复重试或绕过审核。'
        : '\n本模式不转人工。请依据上述原因补全参数、缩小影响范围或移除危险副作用，再提交实质更安全的新请求；不要原样重试，也不要换壳绕过审核。无法安全继续时结束该步骤并报告原因。')
    try {
      await this.rejectRequest(request.requestId, message)
      if (!this.sameApprovalDelivery(managed, delivery) || managed.summary.userStopRequested) return
      if (request.source === 'terminal') this.scheduleTerminalRejectionCheck(managed, request, delivery)
      this.fullAutoActivity?.rejected?.(request, message)
    } catch {
      await this.stopAfterApprovalDeliveryFailure(managed, request, delivery)
    }
  }

  private runApprovalAction(requestId: string, action: () => Promise<void>): Promise<void> {
    const existing = this.approvalActions.get(requestId)
    if (existing) return existing
    this.cancelApprovalReview(requestId)
    let pending: Promise<void>
    try { pending = action() } catch (error) { return Promise.reject(error) }
    this.approvalActions.set(requestId, pending)
    return pending.finally(() => { if (this.approvalActions.get(requestId) === pending) this.approvalActions.delete(requestId) })
  }

  private readonly unattended: UnattendedSupervisor = new UnattendedSupervisor({
    session: id => this.sessions.get(id)?.summary,
    approvals: id => this.sessions.get(id)?.approvalRequests ?? [],
    ready: id => {
      const managed = this.sessions.get(id)
      return Boolean(managed && !managed.hostTransitioning && !managed.pendingTerminalAutoApproval
        && !managed.activityInputPending && managed.agentReady
        && managed.summary.status !== 'starting' && managed.summary.status !== 'recovering')
    },
    blockedReason: id => {
      const managed = this.sessions.get(id)
      if (!managed) return 'Agent 已移除'
      if (managed.hostTransitioning) return '等待终端连接恢复'
      if (managed.pendingTerminalAutoApproval) return '等待终端确认上一笔审批'
      if (managed.activityInputPending) return '终端存在未提交输入'
      if (!managed.agentReady) return '尚未确认 CLI 就绪'
      if (managed.summary.status === 'starting' || managed.summary.status === 'recovering') return 'Agent 正在启动或恢复'
      return undefined
    },
    approve: id => this.approveRequest(id, false, true),
    epoch: id => this.sessions.get(id)?.generation,
    enter: async id => {
      const managed = this.sessions.get(id)
      if (!managed || !this.unattended.enabled(id) || managed.hostTransitioning || managed.activityInputPending
        || managed.pendingContinueSubmit || managed.summary.userStopRequested
        || isTerminalStatus(managed.summary.status) || ['starting', 'recovering'].includes(managed.summary.status)) return false
      // Deliberately bypass write()'s approval interception: this workaround must
      // send a real CR to the PTY even when the Manager queue has already cleared.
      managed.handle.write('\r')
      return true
    },
    send: (id, text) => this.sendSessionMessage(id, text, false),
    restart: (id): Promise<void> => this.restartSession(id, () => this.unattended.enabled(id)),
    changed: (id, settings) => {
      const managed = this.sessions.get(id)
      if (!managed) return
      if (!settings.enabled) {
        this.messageDelivery.interrupt(id)
        this.cancelHookApprovalContinue(managed)
        this.cancelPendingContinueSubmit(managed)
        this.cancelPendingTerminalAutoApproval(managed)
      }
      managed.summary = { ...managed.summary, unattended: settings, approvalMode: settings.enabled ? 'unattended' : (managed.summary.approvalMode === 'unattended' ? 'manual' : managed.summary.approvalMode) }
      this.changed(id)
    },
    audit: entry => this.unattendedActivity?.(entry),
  })

  async setUnattendedMode(sessionId: string, settings: UnattendedSettings): Promise<void> {
    if (!settings || typeof settings.enabled !== 'boolean') throw new Error('无监管配置无效')
    if (!settings.enabled) { await this.setApprovalMode(sessionId, 'manual'); return }
    const managed = this.required(sessionId)
    selectedRecoveryEndWord(settings)
    approvalEnterDelay(settings)
    approvalEnterCount(settings)
    errorRecoveryPolicy(settings)
    if (typeof settings.recoveryWord !== 'string') throw new Error('恢复词必须为文本')
    const expectedVersion = (this.approvalModeVersions.get(sessionId) ?? 0) + 1
    await this.setFullAutoMode(sessionId, false)
    if (this.approvalModeVersions.get(sessionId) !== expectedVersion || this.approvalMode(managed) !== 'manual') return
    this.cancelHookApprovalContinue(managed)
    this.cancelKeywordContinue(managed)
    this.cancelTransientRetry(managed, true)
    this.cancelPendingContinueSubmit(managed)
    this.unattended.enable(sessionId, settings)
    await this.writeApprovalModeMetadata(managed, 'unattended')
  }
  private submittingRemoteInput = false
  async saveUnattendedSettings(sessionId: string, settings: UnattendedSettings): Promise<void> {
    const managed = this.required(sessionId)
    if (this.unattended.enabled(sessionId)) throw new Error('请先停止无监管模式，再修改配置')
    managed.summary = { ...managed.summary, unattended: { ...parseUnattendedSettings(settings), enabled: false } }
    this.changed(sessionId)
    await this.catalog?.flush()
  }
  private readonly messageDelivery = new SessionMessageDelivery(id => {
    const managed = this.required(id)
    if (isTerminalStatus(managed.summary.status) || managed.hostTransitioning
      || managed.summary.status === 'starting' || managed.summary.status === 'recovering'
      || managed.summary.userStopRequested || managed.pendingUserInterrupt) throw new Error('Agent 当前无法接收消息')
    if (!['codex', 'claude', 'pi'].includes(managed.summary.agentKind)) throw new Error('该 Agent 请在原生界面发送消息')
    if (managed.approvalRequests.length || managed.pendingTerminalAutoApproval
      || managed.summary.status === 'needs_approval') throw new Error('Agent 正在等待授权，已取消消息提交，请先处理审批')
    return { generation: managed.generation, nativeSessionId: managed.summary.nativeSessionId }
  }, (id, data) => {
    if (data === '\r' && this.codexTerminalApprovalFromReplay(this.required(id), true)) {
      throw new Error('终端出现新的审批菜单，已取消回车提交')
    }
    this.submittingRemoteInput = true
    try { this.write(id, data) } finally { this.submittingRemoteInput = false }
  })

  async sendSessionMessage(sessionId: string, text: string, confirmReceipt = true): Promise<void> {
    const managed = this.required(sessionId)
    if (managed.activityInputPending) throw new Error('终端已有未提交输入，请先处理，避免与远程消息混合')
    if (this.codexTerminalApprovalFromReplay(managed, true)) throw new Error('终端正在等待审批，请先处理')
    await this.messageDelivery.send(sessionId, text, confirmReceipt)
  }
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly nativeCaptureReservations = new Set<string>()
  private readonly manager: SessionHostManagerPort
  private readonly emit: Emit
  private readonly discovery?: NativeSessionDiscoveryPort
  private readonly approvalPolicy?: ApprovalPolicyPort
  private readonly recoveryPolicy?: RecoveryPolicyPort

  constructor(
    manager: SessionHostManager | SessionHostManagerPort,
    emit: Emit = () => undefined,
    discovery?: NativeSessionDiscoveryPort,
    approvalPolicy?: ApprovalPolicyPort,
    recoveryPolicy?: RecoveryPolicyPort,
    private readonly fullAutoActivity?: FullAutoActivityPort,
    private readonly continueKeywordPolicy?: ContinueKeywordPolicyPort,
    private readonly recoveryActivity?: RecoveryActivityPort,
    private readonly catalog?: ManagedSessionCatalogPort,
    private readonly llmReview?: LlmApprovalReviewPort,
    private readonly unattendedActivity?: (entry: UnattendedAudit) => void,
    private readonly nativeActivityBinding?: NativeActivityBindingPort,
  ) {
    this.manager = manager
    this.emit = emit
    this.discovery = discovery
    this.approvalPolicy = approvalPolicy
    this.recoveryPolicy = recoveryPolicy
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(({ summary }) => this.copySessionSummary(summary))
  }

  listNativeActivitySessions(): NativeActivitySession[] {
    return [...this.sessions.values()].map(managed => {
      const binding = managed.nativeActivityBinding?.generation === managed.generation ? managed.nativeActivityBinding : undefined
      return { ...this.copySessionSummary(managed.summary), activityGeneration: managed.generation, ...(binding ? {
        activityNativeSessionId: binding.nativeSessionId, activityTranscriptPath: binding.transcriptPath,
        activityBindingVersion: binding.version,
      } : {}) }
    })
  }

  isNativeActivitySnapshotCurrent(snapshot: NativeActivitySession): boolean {
    const managed = this.sessions.get(snapshot.sessionId)
    if (!managed || managed.summary.nativeSessionId !== snapshot.nativeSessionId
      || managed.summary.activitySince !== snapshot.activitySince
      || snapshot.activityGeneration !== undefined && snapshot.activityGeneration !== managed.generation) return false
    const binding = managed.nativeActivityBinding?.generation === managed.generation ? managed.nativeActivityBinding : undefined
    return (binding?.version ?? 0) === (snapshot.activityBindingVersion ?? 0)
      && binding?.nativeSessionId === snapshot.activityNativeSessionId
      && binding?.transcriptPath === snapshot.activityTranscriptPath
  }

  private async bindHookNativeActivity(managed: ManagedSession, event: Extract<HostEvent, { type: 'permission-request' }>): Promise<void> {
    const kind = managed.summary.agentKind
    if (!this.nativeActivityBinding || (kind !== 'codex' && kind !== 'claude')
      || event.hookSource !== kind || !event.nativeSessionId || !event.transcriptPath
      || event.agentId && event.agentId !== event.nativeSessionId
      || event.agentType && !['main', 'primary', 'root'].includes(event.agentType.toLowerCase())) return
    const generation = managed.generation
    const attempt = (managed.nativeActivityBindingAttempt ?? 0) + 1
    managed.nativeActivityBindingAttempt = attempt
    try {
      const binding = await this.nativeActivityBinding.validate(kind,
        { nativeSessionId: event.nativeSessionId, transcriptPath: event.transcriptPath })
      if (!binding || this.sessions.get(managed.summary.sessionId) !== managed || managed.generation !== generation
        || managed.nativeActivityBindingAttempt !== attempt || managed.summary.userStopRequested || isTerminalStatus(managed.summary.status)) return
      const previous = managed.nativeActivityBinding
      if (previous?.generation === generation && previous.nativeSessionId === binding.nativeSessionId
        && previous.transcriptPath === binding.transcriptPath) return
      managed.nativeActivityBinding = { ...binding, generation, version: (previous?.version ?? 0) + 1 }
      this.changed(managed.summary.sessionId)
    } catch { /* Invalid/unavailable metadata never changes activity or approval. */ }
  }

  private clearBindingAutomation(managed: ManagedSession, resetKeywordCount = true): void {
    this.cancelSessionReviews(managed)
    this.messageDelivery.interrupt(managed.summary.sessionId)
    this.unattended.cancelApprovalEnter(managed.summary.sessionId)
    this.cancelHookApprovalContinue(managed)
    this.cancelKeywordContinue(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelTransientRetry(managed)
    this.cancelClaudeTerminalApproval(managed)
    this.cancelCodexTerminalApproval(managed)
    this.cancelPendingTerminalAutoApproval(managed)
    managed.approvalRequests.length = 0
    this.clearClaudeHookState(managed)
    this.syncApprovalSummary(managed)
    delete managed.lastTerminalAutoApproval
    managed.continueKeywordTail = ''
    delete managed.continueKeywordNativeText
    managed.continueKeywordAttempted.clear()
    if (resetKeywordCount) {
      managed.continueKeywordCount = 0
      managed.continueKeywordLimitLogged = false
    }
  }

  private syncHookSessionBinding(managed: ManagedSession, event: Extract<HostEvent, { type: 'permission-request' }>): void {
    const kind = managed.summary.agentKind
    const nativeSessionId = event.nativeSessionId
    // This only trusts the authenticated parent Hook's bounded UUID and cwd.
    // It does not authorize reading transcriptPath; that requires validation above.
    if ((kind !== 'codex' && kind !== 'claude') || event.hookSource !== kind
      || event.agentId || event.agentType || !nativeSessionId || !event.cwd
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeSessionId)
      || normalizeWorkspace(event.cwd) !== normalizeWorkspace(managed.summary.workspace)
      || nativeSessionId === managed.summary.nativeSessionId || !managed.request
      || this.nativeCaptureReservations.has(nativeSessionId)
      || this.nativeSessionReservations.has(JSON.stringify([kind, nativeSessionId]))
        && this.nativeSessionReservations.get(JSON.stringify([kind, nativeSessionId]))?.owner !== managed.summary.sessionId
      || [...this.sessions.values()].some(other => other !== managed && other.summary.agentKind === kind
        && this.nativeSessionIdentity(other.request, other.summary) === nativeSessionId
        && (!isTerminalStatus(other.summary.status) || other.hostTransitioning))) return
    try {
      const base = managed.adapter.recoveryRecipe(managed.request.executable, nativeSessionId)
      if (!base) return
      const args = freshSessionArgs(kind, managed.request.args)
      const recovery = { ...base, args: [...args, ...base.args.filter(arg => arg !== '--no-alt-screen' || !args.includes(arg))] }
      if (managed.summary.nativeSessionId || managed.request.recovery) {
        managed.bindingVersion = (managed.bindingVersion ?? 0) + 1
        this.clearBindingAutomation(managed)
        this.unattended.disable(managed.summary.sessionId, '原生会话已切换，无监管已关闭')
      }
      if (managed.nativeCapture?.timer) clearTimeout(managed.nativeCapture.timer)
      delete managed.nativeCapture
      delete managed.nativeActivityBinding
      managed.nativeActivityBindingAttempt = (managed.nativeActivityBindingAttempt ?? 0) + 1
      managed.request = { ...managed.request, args, nativeSessionId, recovery }
      managed.summary = { ...managed.summary, nativeSessionId }
      managed.unusedFreshSession = false
      this.changed(managed.summary.sessionId)
      void this.manager.updateMetadata(managed.handle.hostId, { nativeSessionId, recovery }).catch(() => undefined)
    } catch { /* Invalid launch metadata must not interrupt the current approval. */ }
  }

  listPendingApprovals(): ApprovalRequest[] {
    return [...this.sessions.values()]
      .flatMap(({ approvalRequests }) => approvalRequests.map((request) => this.copyApprovalRequest(request)))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  terminalReplay(sessionId: string): { data: string; sequence: number } {
    const managed = this.required(sessionId)
    return { data: managed.terminalReplay.snapshot(), sequence: managed.outputSequence }
  }

  private readonly terminalTextReads = new Map<string, Promise<string>>()

  terminalText(sessionId: string): Promise<string> {
    const existing = this.terminalTextReads.get(sessionId)
    if (existing) return existing
    const managed = this.required(sessionId)
    const read = (async () => {
      const generation = managed.generation
      // Codex Host already keeps the parsed screen for native cursor responses.
      // Reuse it instead of flattening repeated redraws from the raw event log.
      const data = !isTerminalStatus(managed.summary.status)
        ? await managed.handle.replay(2_000)
        : managed.terminalReplay.snapshot()
      if (managed.generation !== generation) throw new Error('Agent 已重启，请重新获取终端内容')
      return terminalReplayText(data, managed.request?.cols ?? 100, managed.request?.rows ?? 30)
    })().finally(() => this.terminalTextReads.delete(sessionId))
    this.terminalTextReads.set(sessionId, read)
    return read
  }

  isSessionReady(sessionId: string): boolean {
    return this.required(sessionId).agentReady
  }

  observeNativeActivity(snapshot: NativeActivitySession, event: NativeActivityEvent): void {
    const managed = this.sessions.get(snapshot.sessionId)
    if (!managed || !this.isNativeActivitySnapshotCurrent(snapshot)
      || event.timestamp < (managed.summary.activitySince ?? 0)) return
    if (event.userMessage) {
      managed.continueKeywordAttempted.clear()
      this.messageDelivery.observe(snapshot.sessionId, event.userMessage.text, event.userMessage.timestamp)
      // Only clear input that the native CLI has actually consumed. A later
      // local draft must survive delayed transcript updates.
      const input = managed.activityInputState
      if (input?.updatedAt !== undefined && event.userMessage.timestamp >= input.updatedAt) {
        input.reset()
        managed.activityInputPending = false
      }
    }
    if (event.assistantMessage) this.unattended.observe(snapshot.sessionId, event.assistantMessage.text, event.assistantMessage.timestamp)
    if (isTerminalStatus(managed.summary.status)) return
    if (event.timestamp < (managed.summary.activityUpdatedAt ?? 0)) return
    // Current native task evidence proves the CLI is ready even when its
    // welcome/prompt screen was not recognized by the terminal adapter.
    if (event.activity !== 'starting') this.finishStartup(managed)
    this.setActivity(managed, event.activity, event.timestamp, event.error)
    if (event.assistantMessage || event.error) {
      managed.continueKeywordNativeText = (event.assistantMessage?.text ?? event.error ?? '').slice(-4096)
    } else if (event.activity === 'running' || event.userMessage) {
      managed.continueKeywordNativeText = undefined
      managed.continueKeywordTail = ''
      this.cancelKeywordContinue(managed)
    }
    if (['idle', 'completed', 'error'].includes(event.activity)) {
      this.observeContinueKeyword(managed, managed.continueKeywordNativeText ?? managed.continueKeywordTail, { ready: true, approvalRequired: false }, true)
    }
  }

  private setActivity(managed: ManagedSession, activity: NonNullable<SessionSummary['activity']>, timestamp = Date.now(), error?: string): void {
    if (activity === 'running' || activity === 'completed') managed.unusedFreshSession = false
    const changed = managed.summary.activity !== activity || managed.summary.activityError !== error
    managed.summary = { ...managed.summary, activity, activityUpdatedAt: timestamp, activityError: error }
    if (changed) this.changed(managed.summary.sessionId)
  }

  private observeActivityInput(managed: ManagedSession, data: string): void {
    if (managed.approvalRequests.length > 0) return
    const input = managed.activityInputState ??= new TerminalInputState()
    if (data === '\x03' || data === '\x1b') {
      input.reset()
      if (data === '\x1b') input.observe(data, Date.now())
      managed.activityInputPending = false
      this.setActivity(managed, 'idle')
      return
    }
    const submitted = input.observe(data, Date.now())
    managed.activityInputPending = input.pending
    if (submitted) { managed.bindingAwaitingUser = false; this.setActivity(managed, 'running') }
  }

  continuationSource(sessionId: string): { summary: SessionSummary; request: StartSessionRequest } {
    const managed = this.required(sessionId)
    if (!managed.request || !managed.summary.nativeSessionId) throw new Error('当前窗口尚未绑定原生会话，请等待会话建立后再试')
    return structuredClone({ summary: managed.summary, request: managed.request })
  }

  async startSession(request: StartSessionRequest, initialPrompt?: string): Promise<SessionSummary> {
    const sessionId = randomUUID()
    const release = this.reserveNativeSession(request.agentKind, this.nativeSessionIdentity(request), sessionId)
    try { return await this.startManagedSession(request, initialPrompt, sessionId) }
    finally { release() }
  }

  private async startManagedSession(request: StartSessionRequest, initialPrompt: string | undefined, sessionId: string): Promise<SessionSummary> {
    const adapter = createAgentAdapter(request.agentKind)
    const nativeCapture = !request.nativeSessionId && adapter.supportsNativeSessions
      ? await this.prepareNativeCapture(request.agentKind, request.workspace)
      : undefined
    // The host can consume an initial prompt before start() finishes connecting.
    const activitySince = Date.now()
    const handle = await this.manager.start({ ...this.hostOptions(request, sessionId), ...(initialPrompt ? { initialPrompt } : {}) })
    const managed: ManagedSession = {
      startupAttempt: request.nativeSessionId ? 1 : undefined,
      // 仅为确定未开始对话的新窗口开放原配置重启；未知历史记录保持保守。
      unusedFreshSession: !request.nativeSessionId && !request.recovery && !initialPrompt
        && request.args.every(arg => request.agentKind === 'codex' && arg === '--no-alt-screen'),
      summary: {
        sessionId,
        displayName: request.displayName,
        approvalMode: 'manual',
        agentKind: request.agentKind,
        workspace: request.workspace,
        status: 'running',
        activity: 'starting',
        activitySince,
        recoveryAttempts: 0,
        userStopRequested: false,
        ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
        ...(request.agentConfig && 'hasApiKey' in request.agentConfig ? { agentConfig: { ...request.agentConfig, extraArgs: [...request.agentConfig.extraArgs] } } : {}),
        ...(request.agentProxy && 'hasPassword' in request.agentProxy ? { agentProxy: { ...request.agentProxy } } : {}),
      },
      request,
      handle,
      generation: 1,
      recoveryToken: 0,
      hostHealthFailures: 0,
      pendingUserInterrupt: false,
      hostTransitioning: false,
      pendingHostInput: '',
      awaitingRecoveryReady: false,
      agentReady: false,
      suppressTransientRetryUntilReady: Boolean(request.nativeSessionId),
      terminalReplay: new TerminalReplayBuffer(),
      outputSequence: 0,
      adapter,
      approvalRequests: [],
      continueKeywordTail: '',
      continueKeywordAttempted: new Set(),
      ...(nativeCapture ? { nativeCapture } : {}),
    }
    this.sessions.set(sessionId, managed)
    this.changed(sessionId)
    void this.pump(managed, managed.generation)
    return { ...managed.summary }
  }

  async restoreSessions(preserveWorkspaceOnCrash = true): Promise<void> {
    const liveRecords = await this.manager.listLiveHosts()
    const reconnectableHostIds = new Set(liveRecords
      .filter((record) => preserveWorkspaceOnCrash || record.managerOwnership === 'preserved')
      .map((record) => record.hostId))
    for (const record of liveRecords) {
      if (reconnectableHostIds.has(record.hostId)) continue
      await this.manager.release?.(record.hostId).catch(() => undefined)
    }
    const storedEntries = this.catalog?.list() ?? []
    const storedBySessionId = new Map(storedEntries.map((entry) => [entry.sessionId, entry]))
    // Process retention and catalog retention are independent: stopped entries
    // remain available for manual/native workspace restoration.
    for (const record of liveRecords.filter((candidate) => reconnectableHostIds.has(candidate.hostId))) {
      const restoredSessionId = record.sessionId ?? record.hostId
      const stored = storedBySessionId.get(restoredSessionId)
      if (this.sessions.has(restoredSessionId)) continue
      try {
        const handle = await this.manager.reconnect(record.hostId)
        const terminalReplay = new TerminalReplayBuffer()
        const agentKind = record.agentKind ?? 'generic'
        const replay = await handle.replay(2_000).catch(() => '')
        terminalReplay.append(replay)
        const adapter = createAgentAdapter(agentKind)
        const replayObservation = adapter.observeOutput(replay)
        const managed: ManagedSession = {
          summary: {
            sessionId: restoredSessionId,
            displayName: record.displayName ?? `已恢复 Agent ${record.hostId.slice(0, 8)}`,
            agentKind,
            workspace: record.cwd,
            status: 'running',
            activity: replayObservation.ready ? 'idle' : 'starting',
            activitySince: Number.isFinite(Date.parse(record.createdAt)) ? Date.parse(record.createdAt) : Date.now(),
            recoveryAttempts: 0,
            userStopRequested: false,
            ...(replayObservation.webUrl ? { webUrl: replayObservation.webUrl } : {}),
            ...(record.nativeSessionId ?? stored?.summary.nativeSessionId
              ? { nativeSessionId: record.nativeSessionId ?? stored!.summary.nativeSessionId }
              : {}),
          ...(record.agentConfig ? { agentConfig: { ...record.agentConfig, extraArgs: [...record.agentConfig.extraArgs] } } : {}),
          ...(record.agentProxy ? { agentProxy: { ...record.agentProxy } } : {}),
            ...(record.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
            approvalMode: (() => {
              const mode = approvalModeOf({ ...stored?.summary, ...record }, this.llmReview?.getSettings().enabled)
              return mode === 'unattended' ? 'manual' : mode
            })(),
          },
          handle,
          generation: 1,
          recoveryToken: 0,
          hostHealthFailures: 0,
          pendingUserInterrupt: false,
          hostTransitioning: false,
          pendingHostInput: '',
          awaitingRecoveryReady: false,
          agentReady: Boolean(replayObservation.ready),
          suppressTransientRetryUntilReady: true,
          terminalReplay,
          outputSequence: 0,
          adapter,
          approvalRequests: [],
          continueKeywordTail: '',
          continueKeywordAttempted: new Set(),
        }
        if (record.recovery) {
          managed.request = {
            displayName: managed.summary.displayName,
            agentKind,
            workspace: record.cwd,
            executable: record.recovery.executable,
            args: [...record.recovery.args],
            cols: record.cols ?? 80,
            rows: record.rows ?? 24,
            maxContinueRetries: record.maxContinueRetries ?? 3,
            ...(record.agentConfig ? { agentConfig: { ...record.agentConfig, extraArgs: [...record.agentConfig.extraArgs] } } : {}),
            ...(record.agentProxy ? { agentProxy: { ...record.agentProxy } } : {}),
            ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
            recovery: {
              executable: record.recovery.executable,
              args: [...record.recovery.args],
              ...(record.recovery.continueInput ? { continueInput: record.recovery.continueInput } : {}),
            },
          }
        } else if (stored?.request) {
          managed.request = stored.request
        }
        if (!managed.summary.nativeSessionId && stored?.nativeCapture) {
          managed.nativeCapture = {
            baselineIds: new Set(stored.nativeCapture.baselineIds),
            startedAt: stored.nativeCapture.startedAt,
            attempts: 0,
            inFlight: false,
          }
        }
        this.sessions.set(restoredSessionId, managed)
        this.changed(restoredSessionId)
        void this.pump(managed, managed.generation)
      } catch {
        // A live host can be between endpoint restarts; the next app launch probes again.
      }
    }
    const liveSessionIds = new Set([...this.sessions.keys()])
    for (const entry of this.catalog?.list() ?? []) {
      if (liveSessionIds.has(entry.sessionId)) continue
      const alreadyTerminal = isTerminalStatus(entry.summary.status)
      const summary: SessionSummary = alreadyTerminal
        ? { ...entry.summary }
        : {
            ...entry.summary,
            status: 'stopped',
            userStopRequested: true,
            recoveryAttempts: 0,
            lastError: entry.summary.lastError ?? 'Manager 上次未正常退出，受管终端已释放',
          }
      const handle = this.detachedHandle(entry.hostId)
      this.sessions.set(entry.sessionId, {
        unusedFreshSession: entry.unusedFreshSession === true,
        summary,
        ...(entry.request ? { request: entry.request } : {}),
        handle,
        generation: 1,
        recoveryToken: 0,
        hostHealthFailures: 0,
        pendingUserInterrupt: false,
        hostTransitioning: false,
        pendingHostInput: '',
        awaitingRecoveryReady: false,
        agentReady: false,
        suppressTransientRetryUntilReady: true,
        terminalReplay: new TerminalReplayBuffer(),
        outputSequence: 0,
        adapter: createAgentAdapter(summary.agentKind),
        approvalRequests: [],
        continueKeywordTail: '',
        continueKeywordAttempted: new Set(),
        ...(!summary.nativeSessionId && entry.nativeCapture ? {
          nativeCapture: {
            baselineIds: new Set(entry.nativeCapture.baselineIds),
            startedAt: entry.nativeCapture.startedAt,
            attempts: 0,
            inFlight: false,
          },
        } : {}),
      })
      this.changed(entry.sessionId)
    }
  }

  async restoreLiveHosts(): Promise<void> {
    await this.restoreSessions(true)
  }

  updateCrashRetentionPolicy(preserveWorkspaceOnCrash: boolean): void {
    this.manager.setPreserveOnLeaseExpiry?.(preserveWorkspaceOnCrash)
    for (const managed of this.sessions.values()) {
      if (!isTerminalStatus(managed.summary.status)) {
        managed.handle.updateManagerLeasePolicy?.(preserveWorkspaceOnCrash)
      }
    }
  }

  write(sessionId: string, data: string): void {
    const managed = this.required(sessionId)
    if (data && !isTerminalProtocolResponse(data)) this.unattended.cancelApprovalEnter(sessionId)
    if (data === '\x03' || data === '\x1b') { this.cancelSessionReviews(managed); this.unattended.disable(sessionId, '检测到本地中断，无监管已关闭') }
    if (!this.submittingRemoteInput && !isTerminalProtocolResponse(data)) this.messageDelivery.interrupt(sessionId)
    if (isTerminalStatus(managed.summary.status)) throw new Error('Agent 已结束，请先重新启动')
    let handledClaudeHookApproval = false
    if (data.length > 0) {
      this.cancelHookApprovalContinue(managed)
      this.cancelKeywordContinue(managed)
      this.cancelPendingTerminalAutoApproval(managed)
      if (managed.summary.agentKind === 'claude') {
        this.cancelClaudeTerminalApproval(managed)
        managed.claudeTerminalFallbackBlockedUntil = 0
      } else if (managed.summary.agentKind === 'codex') {
        this.cancelCodexTerminalApproval(managed)
      }
      if (!isTerminalProtocolResponse(data)) {
        if (!this.submittingRemoteInput) {
          managed.continueKeywordCount = 0
          managed.continueKeywordLimitLogged = false
        }
        managed.continueKeywordAttempted.clear()
        managed.continueKeywordTail = ''
        managed.continueKeywordNativeText = undefined
      }
      this.cancelTransientRetry(managed, true)
      this.cancelPendingContinueSubmit(managed)
      if (managed.summary.status === 'needs_attention') {
        const resumeHostMonitoring = managed.summary.attentionKind === 'host-unresponsive'
        this.clearRecoveryState(managed, 'running')
        if (resumeHostMonitoring) {
          managed.hostHealthFailures = 0
          managed.generation += 1
          void this.pump(managed, managed.generation)
        }
        this.changed(sessionId)
      }
    }
    if (data === '\x03' || data === '\x1b') {
      managed.pendingUserInterrupt = true
      if (managed.hostTransitioning) {
        managed.pendingHostInput = ''
        return
      }
    }
    else if (data.length > 0) {
      managed.pendingUserInterrupt = false
      const hookApproval = /^[\r\n]+$/.test(data)
        ? managed.approvalRequests.find((request) => request.source !== 'terminal')
        : undefined
      const terminalApproval = managed.approvalRequests.find((request) => request.source === 'terminal')
      if (hookApproval) {
        if (hookApproval.source === 'claude-hook') {
          managed.adapter.acknowledgeUserInput(true)
          managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
          this.respondToClaudeHook(managed, hookApproval.requestId, 'allow')
          this.completeManualApproval(managed, hookApproval)
        } else {
          void this.approveRequest(hookApproval.requestId).catch(() => undefined)
        }
        handledClaudeHookApproval = true
      } else if (terminalApproval && /^[\r\n]+$/.test(data)) {
        managed.adapter.acknowledgeUserInput(true)
        this.completeManualApproval(managed, terminalApproval)
      } else if (managed.summary.status !== 'needs_approval') managed.adapter.acknowledgeUserInput()
    }
    if (handledClaudeHookApproval) return
    if (managed.hostTransitioning) {
      if (isTerminalProtocolResponse(data)) return
      if (managed.pendingHostInput.length + data.length > MAX_PENDING_HOST_INPUT) {
        throw new Error('Agent 正在重新连接，等待发送的输入过多，请稍后再试')
      }
      managed.pendingHostInput += data
      return
    }
    managed.handle.write(data)
    this.observeActivityInput(managed, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const managed = this.required(sessionId)
    if (isTerminalStatus(managed.summary.status)) return
    this.cancelKeywordContinue(managed)
    managed.continueKeywordTail = ''
    managed.continueKeywordSuppressedUntil = Date.now() + 1_000
    managed.handle.resize(cols, rows)
    if (managed.request) managed.request = { ...managed.request, cols, rows }
  }

  approveSession(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    const request = managed.approvalRequests[0]
    if (!request) throw new Error('当前 Agent 没有等待处理的授权请求')
    return this.approveRequest(request.requestId)
  }

  approveRequest(requestId: string, recordManualApproval = true, suppressHookContinue = false): Promise<void> {
    return this.runApprovalAction(requestId, () => this.performApproval(requestId, recordManualApproval, suppressHookContinue))
  }

  private performApproval(requestId: string, recordManualApproval: boolean, suppressHookContinue: boolean): Promise<void> {
    const { managed, request } = this.requiredApproval(requestId)
    const delivery = this.approvalDeliveryContext(managed)
    if (request.source !== 'terminal') {
      this.cancelClaudeTerminalApproval(managed)
      managed.adapter.acknowledgeUserInput(true)
      if (request.source === 'claude-hook') {
        managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
        if (!recordManualApproval && managed.handle.respondToPermissionChecked) {
          return this.respondToClaudeHookChecked(managed, request.requestId, 'allow').then(() => {
            if (this.sameApprovalDelivery(managed, delivery)) this.completeApproval(managed, request, false)
          })
        }
        this.respondToClaudeHook(managed, request.requestId, 'allow')
      } else {
        const checked = managed.handle.respondToPermissionChecked?.(request.requestId, 'allow')
        if (checked) {
          return checked.then((delivered) => {
            if (!this.sameApprovalDelivery(managed, delivery)) return
            if (!delivered && suppressHookContinue && !this.unattended.enabled(managed.summary.sessionId)) {
              throw new Error('无监管已关闭，已取消过期 Hook 的终端回退审批')
            }
            if (!delivered && (!recordManualApproval || !this.approveExpiredCodexHookViaTerminal(managed, request))) {
              throw new Error('Codex Hook 已失效，且尚未检测到原生审批界面，请稍后重试')
            }
            this.completeApproval(managed, request, recordManualApproval)
            if (delivered && recordManualApproval && !suppressHookContinue) this.scheduleHookApprovalContinue(managed)
          })
        }
        managed.handle.respondToPermission(request.requestId, 'allow')
      }
    } else {
      managed.adapter.acknowledgeUserInput(true)
      managed.handle.write(managed.adapter.approvalInput())
      // Codex can render a terminal fallback approval before its raw-input
      // reader is ready. Reuse the bounded confirmation used by full-auto so
      // a manual click is not silently swallowed.
      this.schedulePendingTerminalAutoApproval(managed, request.command, undefined, request)
    }
    this.completeApproval(managed, request, recordManualApproval)
    if (request.source !== 'terminal' && recordManualApproval && !suppressHookContinue) this.scheduleHookApprovalContinue(managed)
    return Promise.resolve()
  }

  async approveAndRememberRequest(requestId: string): Promise<void> {
    const { request } = this.requiredApproval(requestId)
    if (!request.command) throw new Error('Agent 没有提供完整命令或工具名称，无法记为安全命令')
    if (request.risk === 'write' || request.risk === 'delete') {
      throw new Error('写入和删除操作不能记为安全命令，仍需逐次确认')
    }
    if (!this.approvalPolicy) throw new Error('批准规则尚未加载，请稍后重试')
    await this.approvalPolicy.addRule(request.command)
    await this.approveRequest(requestId)
  }

  rejectRequest(requestId: string, reason?: string): Promise<void> {
    return this.runApprovalAction(requestId, async () => {
      const { managed, request } = this.requiredApproval(requestId)
      const delivery = this.approvalDeliveryContext(managed)
      if (request.source !== 'terminal') {
        this.cancelClaudeTerminalApproval(managed)
        managed.adapter.acknowledgeUserInput(true)
        if (request.source === 'claude-hook') {
          managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
          const rejected = this.respondToClaudeHook(managed, request.requestId, 'deny', reason)
          if (rejected) await rejected
        } else if (managed.handle.respondToPermissionChecked) {
          const delivered = await managed.handle.respondToPermissionChecked(request.requestId, 'deny', reason)
          if (!delivered) throw new Error('拒绝响应未送达，Hook 已失效；未对其他终端请求执行操作')
        } else managed.handle.respondToPermission(request.requestId, 'deny', reason)
      } else {
        managed.adapter.acknowledgeUserInput(true)
        managed.handle.write(managed.adapter.rejectionInput())
      }
      if (!this.sameApprovalDelivery(managed, delivery)) return
      this.removeApproval(managed, request.requestId)
      this.syncApprovalSummary(managed)
      this.changed(managed.summary.sessionId)
    })
  }

  async approveAllPending(): Promise<BulkApprovalResult> {
    const result: BulkApprovalResult = { approved: 0, skipped: 0, failed: 0, skippedRequestIds: [] }
    for (const request of this.listPendingApprovals()) {
      const managed = this.sessions.get(request.sessionId)
      if (!managed || this.approvalMode(managed) !== 'manual'
        || !(this.approvalPolicy?.canBulkApproveCommand?.(request.command) ?? canBulkApproveCommand(request.command))) {
        result.skipped += 1
        result.skippedRequestIds.push(request.requestId)
        continue
      }
      try {
        await this.approveRequest(request.requestId)
        result.approved += 1
      } catch {
        result.failed += 1
      }
    }
    return result
  }

  async approveAllPendingForced(): Promise<BulkApprovalResult> {
    const result: BulkApprovalResult = { approved: 0, skipped: 0, failed: 0, skippedRequestIds: [] }
    for (const request of this.listPendingApprovals()) {
      try {
        await this.approveRequest(request.requestId)
        result.approved += 1
      } catch {
        result.failed += 1
      }
    }
    return result
  }

  continueSession(sessionId: string): void {
    void this.tryRecoveryOnce(sessionId)
  }

  async tryRecoveryOnce(sessionId: string): Promise<void> {
    await this.performRecoveryOnce(this.required(sessionId), false)
  }

  async acceptRecoverySuggestion(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    const reason = managed.summary.lastError
    if (managed.summary.status !== 'needs_attention' || !reason || !this.recoveryPolicy) {
      throw new Error('当前没有可采纳的异常恢复建议')
    }
    await this.recoveryPolicy.addRule(reason)
    await this.performRecoveryOnce(managed, true)
  }

  dismissRecoverySuggestion(sessionId: string): void {
    const managed = this.required(sessionId)
    if (managed.summary.status !== 'needs_attention') return
    if (managed.summary.attentionKind === 'host-unresponsive') {
      this.clearRecoveryState(managed, 'running')
      managed.hostHealthFailures = 0
      managed.generation += 1
      this.changed(sessionId)
      void this.pump(managed, managed.generation)
      return
    }
    const action = managed.summary.recoveryAction
    this.clearRecoveryState(managed, action === 'resume' ? 'failed' : 'running', action === 'resume')
    this.changed(sessionId)
  }

  async acceptApprovalSuggestion(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    const suggestion = managed.summary.approvalSuggestion
    if (!suggestion || !this.approvalPolicy) throw new Error('Session has no approval rule suggestion')
    await this.approvalPolicy.addRule(suggestion.command)
    const { approvalSuggestion: _suggestion, ...summary } = managed.summary
    managed.summary = summary
    this.changed(sessionId)
  }

  dismissApprovalSuggestion(sessionId: string): void {
    const managed = this.required(sessionId)
    if (!managed.summary.approvalSuggestion) return
    const { approvalSuggestion: _suggestion, ...summary } = managed.summary
    managed.summary = summary
    this.changed(sessionId)
  }

  async stopSession(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    managed.stopRequestVersion = (managed.stopRequestVersion ?? 0) + 1
    this.cancelSessionReviews(managed)
    this.unattended.disable(sessionId, '已手动停止 Agent，无监管已关闭')
    this.messageDelivery.interrupt(sessionId)
    managed.startupAttempt = undefined
    managed.summary = { ...managed.summary, startupRecoveryRequired: false }
    this.cancelHookApprovalContinue(managed)
    this.cancelClaudeTerminalApproval(managed)
    this.cancelCodexTerminalApproval(managed)
    this.cancelPendingTerminalAutoApproval(managed)
    if (isTerminalStatus(managed.summary.status)) { this.changed(sessionId); return }
    managed.recoveryToken += 1
    this.cancelTransientRetry(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelKeywordContinue(managed)
    const generation = managed.generation
    const hostId = managed.handle.hostId
    managed.pendingUserInterrupt = true
    managed.summary = reduceSession(managed.summary, { type: 'user-stop-requested' }) as SessionSummary
    this.changed(sessionId)
    await managed.handle.stop().catch(() => undefined)
    const exit = await this.manager.readLastExit(hostId).catch(() => undefined)
    if (exit) await this.onExit(managed, generation, exit.exitCode)
  }

  async renameSession(sessionId: string, displayName: string): Promise<void> {
    const managed = this.required(sessionId)
    const normalized = displayName.trim()
    if (!normalized || normalized.length > 120 || /[\r\n\0]/.test(normalized)) throw new Error('Agent 名称应为 1 到 120 个字符')
    if (managed.summary.displayName === normalized) return
    if (!isTerminalStatus(managed.summary.status)) {
      await this.manager.updateMetadata(managed.handle.hostId, { displayName: normalized })
    }
    managed.summary = { ...managed.summary, displayName: normalized }
    if (managed.request) managed.request = { ...managed.request, displayName: normalized }
    managed.approvalRequests = managed.approvalRequests.map((request) => ({ ...request, displayName: normalized }))
    this.changed(sessionId)
  }

  async updateSessionConfig(sessionId: string, config: AgentConfigSummary): Promise<void> {
    const managed = this.required(sessionId)
    const normalized = { ...config, extraArgs: [...config.extraArgs] }
    if (!isTerminalStatus(managed.summary.status)) {
      await this.manager.updateMetadata(managed.handle.hostId, { agentConfig: normalized.enabled || normalized.networkRetry || normalized.autoCompactTokens !== undefined ? normalized : null })
    }
    managed.summary = { ...managed.summary, agentConfig: normalized }
    if (managed.request) managed.request = { ...managed.request, agentConfig: normalized }
    this.changed(sessionId)
  }

  async updateSessionProxy(sessionId: string, proxy: AgentProxySummary | undefined): Promise<void> {
    const managed = this.required(sessionId)
    if (!isTerminalStatus(managed.summary.status)) {
      await this.manager.updateMetadata(managed.handle.hostId, { agentProxy: proxy ? { ...proxy } : null })
    }
    const { agentProxy: _previous, ...summary } = managed.summary
    managed.summary = { ...summary, ...(proxy ? { agentProxy: { ...proxy } } : {}) }
    if (managed.request) {
      const { agentProxy: _requestProxy, ...request } = managed.request
      managed.request = { ...request, ...(proxy ? { agentProxy: { ...proxy } } : {}) }
    }
    this.changed(sessionId)
  }

  async setApprovalMode(sessionId: string, mode: ApprovalMode, settings?: UnattendedSettings): Promise<void> {
    if (!isApprovalMode(mode)) throw new Error('审批模式无效')
    const managed = this.required(sessionId)
    if (mode === 'unattended') {
      await this.setUnattendedMode(sessionId, { ...parseUnattendedSettings(settings ?? managed.summary.unattended ?? {}), enabled: true })
      return
    }
    this.approvalModeVersions.set(sessionId, (this.approvalModeVersions.get(sessionId) ?? 0) + 1)
    this.cancelSessionReviews(managed)
    this.unattended.disable(sessionId, '已切换审批模式')
    this.cancelHookApprovalContinue(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelPendingTerminalAutoApproval(managed)
    this.cancelKeywordContinue(managed)
    const version = this.approvalModeVersions.get(sessionId)
    const fullAutoEnabled = mode === 'agent-review' || mode === 'rules-auto'
    managed.summary = { ...managed.summary, approvalMode: mode, fullAutoEnabled }
    this.changed(sessionId)
    if (!isTerminalStatus(managed.summary.status)) {
      await this.writeApprovalModeMetadata(managed, mode)
    }
    if (this.approvalModeVersions.get(sessionId) !== version) return
    for (const request of [...managed.approvalRequests]) await this.processApproval(managed, request)
    await this.catalog?.flush()
  }

  async setFullAutoMode(sessionId: string, enabled: boolean): Promise<void> {
    await this.setApprovalMode(sessionId, enabled ? 'rules-auto' : 'manual')
  }

  async stopAllSessions(): Promise<number> {
    const active = [...this.sessions.values()]
      .filter((managed) => !isTerminalStatus(managed.summary.status))
      .map((managed) => managed.summary.sessionId)
    await Promise.all(active.map((sessionId) => this.stopSession(sessionId)))
    return active.length
  }

  async preserveAllSessions(): Promise<number> {
    for (const id of this.sessions.keys()) {
      this.cancelSessionReviews(this.required(id))
      this.unattended.disable(id, 'Manager 正在退出，无监管已关闭')
      this.messageDelivery.interrupt(id)
    }
    const active = [...this.sessions.values()].filter((managed) => !isTerminalStatus(managed.summary.status))
    const preserved: ManagedSession[] = []
    try {
      for (const managed of active) {
        if (!managed.handle.preserveOnDisconnect) throw new Error(`${managed.summary.displayName} 的 Host 不支持安全保留，请重启 Agent 后再试`)
        await managed.handle.preserveOnDisconnect()
        preserved.push(managed)
      }
    } catch (error) {
      for (const managed of preserved) managed.handle.resumeManagement?.()
      throw error
    }
    for (const managed of active) {
      managed.generation += 1
      managed.handle.disconnect()
    }
    return active.length
  }

  async clearAllSessions(): Promise<number> {
    const count = this.sessions.size
    await this.stopAllSessions()
    for (const managed of this.sessions.values()) {
      managed.handle.disconnect()
      await this.manager.removeArtifacts(managed.handle.hostId).catch(() => undefined)
    }
    this.sessions.clear()
    await this.catalog?.clear()
    return count
  }

  flushCatalog(): Promise<void> {
    return this.catalog?.flush() ?? Promise.resolve()
  }

  async replaceSessionBinding(sessionId: string, nativeSessionId: string | null): Promise<void> {
    const managed = this.required(sessionId)
    if (managed.bindingChangeBusy || managed.hostTransitioning || this.restartingSessions.has(sessionId)) throw new Error('正在切换会话，请稍后再试')
    if (!isTerminalStatus(managed.summary.status) && managed.summary.status !== 'needs_attention') throw new Error('请先停止 Agent，再切换会话')
    const request = managed.request
    if (!request || !['codex', 'claude'].includes(managed.summary.agentKind)) throw new Error('此 Agent 不支持切换原生会话')
    const args = freshSessionArgs(managed.summary.agentKind, request.args)
    const baseRecovery = nativeSessionId ? managed.adapter.recoveryRecipe(request.executable, nativeSessionId) : undefined
    const recovery = baseRecovery ? { ...baseRecovery, args: [...args, ...baseRecovery.args.filter(arg => arg !== '--no-alt-screen' || !args.includes(arg))] } : undefined
    if (nativeSessionId && !recovery) throw new Error('无法构建会话恢复参数')
    const release = this.reserveNativeSession(managed.summary.agentKind, nativeSessionId ?? undefined, sessionId)
    managed.bindingChangeBusy = true
    try {
      this.clearBindingAutomation(managed)
      let transitionStopVersion = managed.stopRequestVersion
      if (managed.summary.status === 'needs_attention') {
        const stopping = this.stopSession(sessionId)
        transitionStopVersion = managed.stopRequestVersion
        await stopping
        if (managed.stopRequestVersion !== transitionStopVersion) return
      }
      await this.setApprovalMode(sessionId, 'manual')
      managed.startupAttempt = undefined
      // 先移除已结束 Host 的恢复元数据，避免 Manager 重启重新读回旧 ID。
      await this.releaseHostBeforeRestart(managed.handle.hostId)
      await this.manager.removeArtifacts(managed.handle.hostId)
      // A later Stop wins even if releasing the old Host was slow.
      if (managed.stopRequestVersion !== transitionStopVersion) return
      if (managed.nativeCapture?.timer) clearTimeout(managed.nativeCapture.timer)
      delete managed.nativeCapture
      managed.generation += 1
      const { nativeSessionId: _oldId, recovery: _oldRecovery, ...baseRequest } = request
      managed.request = { ...baseRequest, args, ...(nativeSessionId ? { nativeSessionId, recovery } : {}) }
      const { nativeSessionId: _summaryId, ...summary } = managed.summary
      managed.summary = { ...summary, approvalMode: 'manual', fullAutoEnabled: false, ...(nativeSessionId ? { nativeSessionId } : {}) }
      managed.unusedFreshSession = !nativeSessionId
      managed.bindingAwaitingUser = true
      managed.continueKeywordTail = ''
      delete managed.continueKeywordNativeText
      this.changed(sessionId)
      await this.flushCatalog()
      if (managed.stopRequestVersion !== transitionStopVersion) return
      await this.restartManagedSession(sessionId)
    } finally { managed.bindingChangeBusy = false; release() }
  }

  async restartSession(sessionId: string, stillRequested?: () => boolean): Promise<void> {
    const managed = this.required(sessionId)
    if (this.restartingSessions.has(sessionId) || managed.bindingChangeBusy) throw new Error('正在启动或切换 Agent，请稍后再试')
    const release = this.reserveNativeSession(managed.summary.agentKind, this.nativeSessionIdentity(managed.request, managed.summary), sessionId)
    this.restartingSessions.add(sessionId)
    try { await this.restartManagedSession(sessionId, stillRequested) }
    finally { this.restartingSessions.delete(sessionId); release() }
  }

  private async restartManagedSession(sessionId: string, stillRequested?: () => boolean, startupRetry = false): Promise<void> {
    if (stillRequested && !stillRequested()) return
    this.unattended.cancelApprovalEnter(sessionId)
    this.messageDelivery.interrupt(sessionId)
    const managed = this.required(sessionId)

    if (!isTerminalStatus(managed.summary.status)) throw new Error('Agent 仍在运行，无需重新启动')
    if (managed.hostTransitioning) throw new Error('正在启动 Agent，请稍后再试')
    if (!managed.request) throw new Error('缺少该 Agent 的启动信息，无法重新启动')
    const stopVersionBeforeCapture = managed.stopRequestVersion
    if (!managed.summary.nativeSessionId && managed.adapter.supportsNativeSessions && managed.nativeCapture) {
      await this.tryCaptureNativeSession(managed)
    }
    if (managed.stopRequestVersion !== stopVersionBeforeCapture || stillRequested && !stillRequested()) return
    const request = managed.request
    if (!startupRetry) {
      managed.startupAttempt = managed.summary.nativeSessionId || request.recovery ? 1 : undefined
      managed.startupStillRequested = stillRequested
      managed.summary = { ...managed.summary, startupFailureCount: 0, startupRecoveryRequired: false }
    }
    // A persisted recovery recipe is already a valid native-session binding.
    // The summary can lag behind it after a host exit or an app restart; do not
    // force the user through "new Agent -> restore" again in that case.
    if (!managed.summary.nativeSessionId && managed.adapter.supportsNativeSessions && !request.recovery && !managed.unusedFreshSession) {
      throw new Error('该窗口尚未绑定原生会话，无法确认已有历史。请先选择历史会话，或明确选择新会话。')
    }

    const oldHostId = managed.handle.hostId
    const freshCapture = !managed.summary.nativeSessionId && !request.recovery && managed.adapter.supportsNativeSessions
      ? await this.prepareNativeCapture(managed.summary.agentKind, managed.summary.workspace)
      : undefined
    if (managed.stopRequestVersion !== stopVersionBeforeCapture || stillRequested && !stillRequested()) return
    const nativeRecipe = !request.recovery && managed.summary.nativeSessionId
      ? managed.adapter.recoveryRecipe(request.executable, managed.summary.nativeSessionId)
      : undefined
    const recipe = request.recovery ?? (nativeRecipe ? {
      ...nativeRecipe,
      args: [...freshSessionArgs(managed.summary.agentKind, request.args), ...nativeRecipe.args.filter(arg => arg !== '--no-alt-screen')],
    } : undefined)
    if (managed.summary.nativeSessionId && managed.adapter.supportsNativeSessions && !recipe) {
      throw new Error('无法构建原生会话恢复参数，请重新选择历史会话')
    }
    const scrollableRecipe = recipe ? { ...recipe, args: terminalScrollbackArgs(managed.summary.agentKind, recipe.args) } : undefined
    const options: StartHostOptions = scrollableRecipe ? {
      displayName: managed.summary.displayName,
      agentKind: managed.summary.agentKind,
      executable: scrollableRecipe.executable,
      args: [...scrollableRecipe.args],
      cwd: managed.summary.workspace,
      cols: request.cols,
      rows: request.rows,
      maxContinueRetries: request.maxContinueRetries,
      ...(managed.summary.agentConfig ? { agentConfig: { ...managed.summary.agentConfig, extraArgs: [...managed.summary.agentConfig.extraArgs] } } : {}),
      ...(managed.summary.agentProxy?.enabled ? { agentProxy: { ...managed.summary.agentProxy } } : {}),
      ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
      ...(managed.summary.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
      recovery: scrollableRecipe,
    } : this.hostOptions(request)
    options.approvalMode = this.approvalMode(managed)
    if (options.approvalMode === 'agent-review' || options.approvalMode === 'rules-auto') options.fullAutoEnabled = true
    else delete options.fullAutoEnabled

    // Capture may have discovered an identity after the public restart began.
    const releaseNative = this.reserveNativeSession(managed.summary.agentKind, this.nativeSessionIdentity(request, managed.summary), sessionId)

    managed.recoveryToken += 1
    this.clearBindingAutomation(managed, false)
    managed.generation += 1
    const generation = managed.generation
    const stopRequestVersion = managed.stopRequestVersion
    managed.hostTransitioning = true
    managed.pendingHostInput = ''
    managed.handle.disconnect()
    managed.pendingUserInterrupt = false
    managed.awaitingRecoveryReady = false
    managed.agentReady = false
    managed.activityInputPending = false
    managed.activityInputState?.reset()
    managed.suppressTransientRetryUntilReady = Boolean(managed.summary.nativeSessionId)
    managed.adapter.resetForRecovery()
    delete managed.lastTerminalAutoApproval
    if (managed.nativeCapture?.timer) clearTimeout(managed.nativeCapture.timer)
    delete managed.nativeCapture
    if (freshCapture) managed.nativeCapture = freshCapture
    const {
      lastError: _lastError,
      pendingApprovalCommand: _pending,
      approvalRisk: _approvalRisk,
      approvalReason: _approvalReason,
      approvalToolName: _approvalToolName,
      approvalFilePath: _approvalFilePath,
      approvalTargetPaths: _approvalTargetPaths,
      approvalInputSummary: _approvalInputSummary,
      approvalSuggestion: _suggestion,
      recoveryAction: _recoveryAction,
      recoveryAttempted: _recoveryAttempted,
      recoveryRuleApplied: _recoveryRuleApplied,
      attentionKind: _attentionKind,
      webUrl: _webUrl,
      ...summary
    } = managed.summary
    managed.summary = {
      ...summary,
      status: 'starting',
      activity: 'starting',
      activitySince: Date.now(),
      activityUpdatedAt: undefined,
      activityError: undefined,
      recoveryAttempts: 0,
      userStopRequested: false,
    }
    delete managed.pendingApprovalCommand
    managed.approvalRequests.length = 0
    this.clearClaudeHookState(managed)
    this.changed(sessionId)

    try {
      await this.releaseHostBeforeRestart(oldHostId)
      if (stillRequested && !stillRequested()) throw new Error('审批模式已切换，已取消无监管的自动重启')
      if (managed.generation !== generation || managed.stopRequestVersion !== stopRequestVersion) {
        managed.hostTransitioning = false
        managed.pendingHostInput = ''
        return
      }
      options.sessionId = sessionId
      const handle = await this.manager.start(options)
      if (this.sessions.get(sessionId) !== managed || managed.generation !== generation
        || managed.stopRequestVersion !== stopRequestVersion || stillRequested && !stillRequested()) {
        await handle.stop().catch(() => undefined)
        handle.disconnect()
        await this.manager.removeArtifacts(handle.hostId).catch(() => undefined)
        managed.hostTransitioning = false
        managed.pendingHostInput = ''
        if (managed.generation === generation && !managed.summary.userStopRequested) {
          managed.summary = { ...managed.summary, status: 'stopped' }
          this.changed(sessionId)
        }
        return
      }
      managed.handle = handle
      managed.hostTransitioning = false
      managed.terminalReplay.clear()
      managed.outputSequence = 0
      managed.summary = { ...managed.summary, status: 'running' }
      this.flushPendingHostInput(managed)
      await this.manager.removeArtifacts(oldHostId).catch(() => undefined)
      this.changed(sessionId)
      void this.pump(managed, managed.generation)
      this.scheduleNativeCapture(managed)
    } catch (error) {
      if (managed.generation !== generation || managed.stopRequestVersion !== stopRequestVersion) {
        managed.hostTransitioning = false
        managed.pendingHostInput = ''
        return
      }
      managed.hostTransitioning = false
      managed.pendingHostInput = ''
      managed.summary = {
        ...managed.summary,
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      }
      this.changed(sessionId)
      if (await this.retryFailedStartup(managed, managed.summary.lastError ?? '启动失败', stillRequested)) return
      throw error
    } finally { releaseNative() }
  }

  /** 仅重试尚未就绪的历史会话；绝不把运行中途的异常当成启动失败。 */
  private async retryFailedStartup(managed: ManagedSession, reason: string, stillRequested = managed.startupStillRequested): Promise<boolean> {
    const release = this.reserveNativeSession(managed.summary.agentKind, this.nativeSessionIdentity(managed.request, managed.summary), managed.summary.sessionId)
    try { return await this.retryReservedStartup(managed, reason, stillRequested) }
    finally { release() }
  }

  private async retryReservedStartup(managed: ManagedSession, reason: string, stillRequested?: () => boolean): Promise<boolean> {
    if (!managed.startupAttempt || managed.agentReady || managed.pendingUserInterrupt || managed.summary.userStopRequested) return false
    if (stillRequested && !stillRequested()) {
      managed.startupAttempt = undefined
      managed.summary = { ...managed.summary, status: 'failed', lastError: reason }
      this.changed(managed.summary.sessionId)
      return false
    }
    const attempt = managed.startupAttempt
    managed.summary = { ...managed.summary, status: 'failed', lastError: reason,
      startupFailureCount: attempt, startupRecoveryRequired: attempt >= 3 }
    this.changed(managed.summary.sessionId)
    if (attempt >= 3) { managed.startupAttempt = undefined; return false }
    const generation = managed.generation
    await new Promise(resolve => setTimeout(resolve, 500))
    if (this.sessions.get(managed.summary.sessionId) !== managed || managed.generation !== generation || managed.startupAttempt !== attempt || managed.summary.userStopRequested
      || stillRequested && !stillRequested()) return true
    managed.startupAttempt = attempt + 1
    await this.restartManagedSession(managed.summary.sessionId, stillRequested, true)
    return true
  }

  private finishStartup(managed: ManagedSession): void {
    managed.agentReady = true
    managed.startupAttempt = undefined
    managed.startupStillRequested = undefined
    if (managed.summary.startupFailureCount || managed.summary.startupRecoveryRequired) {
      managed.summary = { ...managed.summary, startupFailureCount: 0, startupRecoveryRequired: false }
      this.changed(managed.summary.sessionId)
    }
  }

  private async releaseHostBeforeRestart(hostId: string): Promise<void> {
    if (!this.manager.release) return
    try {
      await this.manager.release(hostId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (!this.manager.forceRelease) throw error
      try {
        await this.manager.forceRelease(hostId)
      } catch (forceError) {
        if ((forceError as NodeJS.ErrnoException).code === 'ENOENT') return
        throw forceError
      }
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    this.unattended.disable(sessionId, 'Agent 已移除，无监管已关闭')
    const managed = this.required(sessionId)
    if (!isTerminalStatus(managed.summary.status)) throw new Error('请先停止 Agent，再将它从总览删除')
    managed.recoveryToken += 1
    this.cancelTransientRetry(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelKeywordContinue(managed)
    managed.generation += 1
    if (managed.nativeCapture?.timer) clearTimeout(managed.nativeCapture.timer)
    managed.handle.disconnect()
    await this.manager.removeArtifacts(managed.handle.hostId).catch(() => undefined)
    this.sessions.delete(sessionId)
    await this.catalog?.remove(sessionId)
    this.changed(sessionId)
  }

  private async pump(managed: ManagedSession, generation: number): Promise<void> {
    while (managed.generation === generation) {
      let event: HostEvent
      try {
        event = await managed.handle.nextEvent()
      } catch (error) {
        if (managed.generation !== generation) return
        if (isTimeout(error)) {
          try {
            await managed.handle.ping(HOST_HEALTH_PROBE_TIMEOUT_MS)
            managed.hostHealthFailures = 0
          } catch {
            managed.hostHealthFailures += 1
            if (managed.hostHealthFailures >= HOST_HEALTH_FAILURE_LIMIT) {
              this.markHostUnresponsive(managed)
              return
            }
          }
          continue
        }
        this.cancelSessionReviews(managed)
        const transientRetryPending = this.cancelTransientRetry(managed)
        const exit = await this.readExitFact(managed.handle.hostId)
        if (exit) await this.onExit(managed, generation, exit.exitCode)
        else if (managed.pendingUserInterrupt || managed.summary.userStopRequested) {
          managed.summary = reduceSession(managed.summary, {
            type: 'process-exited', exitCode: 1, userInitiated: true, adapterCompletion: false,
          }) as SessionSummary
          this.changed(managed.summary.sessionId)
        } else {
          managed.handle.disconnect()
          if (transientRetryPending && managed.summary.status === 'recovering' && managed.request?.recovery) {
            await this.startRecovery(managed)
          } else {
            await this.failOrRecover(managed, generation, 'Host connection lost')
          }
        }
        return
      }
      if (managed.generation !== generation) return
      managed.hostHealthFailures = 0
      if (event.type === 'output') {
        managed.terminalReplay.append(event.data)
        managed.outputSequence += 1
        this.emit({ sessionId: managed.summary.sessionId, ...event, sequence: managed.outputSequence })
        const observation = managed.adapter.observeOutput(event.data)
        this.observePendingTerminalAutoApproval(managed, observation, event.data)
        if (observation.ready && !managed.pendingTerminalAutoApproval) delete managed.lastTerminalAutoApproval
        if (observation.webUrl && managed.summary.webUrl !== observation.webUrl) {
          managed.summary = { ...managed.summary, webUrl: observation.webUrl }
          this.changed(managed.summary.sessionId)
        }
        if (observation.ready && managed.summary.activity === 'starting') {
          // Readiness is provisional; buffered native activity can still supersede it.
          this.setActivity(managed, 'idle', managed.summary.activitySince ?? 0)
        }
        if (observation.ready || observation.approvalRequired) this.finishStartup(managed)
        this.observeContinueKeyword(managed, event.data, observation)
        if (observation.approvalRequired) {
          managed.unusedFreshSession = false
          this.cancelTransientRetry(managed, true)
          this.cancelPendingContinueSubmit(managed)
        }
        if (observation.approvalRequired) {
          if (managed.summary.agentKind === 'claude') {
            this.scheduleClaudeTerminalApproval(managed, observation, event.data)
          } else if (managed.summary.agentKind === 'codex' && managed.handle.permissionHook === 'codex') {
            this.scheduleCodexTerminalApproval(managed, observation, event.data)
          } else {
            this.handleTerminalApproval(managed, observation, event.data)
          }
        } else if (managed.summary.agentKind === 'claude') {
          this.cancelClaudeTerminalApproval(managed)
        } else if (managed.summary.agentKind === 'codex') {
          this.cancelCodexTerminalApproval(managed)
          // A returned native prompt is evidence that the old terminal modal
          // no longer blocks. Never remove a still-pending structured Hook.
          if (observation.ready && managed.approvalRequests.some(request => request.source === 'terminal')) {
            this.cancelPendingTerminalAutoApproval(managed)
            this.removeTerminalApprovals(managed)
            this.changed(managed.summary.sessionId)
          }
        }
        const resumedNow = managed.awaitingRecoveryReady && observation.ready
        if (resumedNow) {
          managed.awaitingRecoveryReady = false
          managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
          this.submitContinue(managed)
          this.changed(managed.summary.sessionId)
        }
        if (!resumedNow && managed.activeRecoveryReason && observation.ready
          && !observation.recoverableError && managed.summary.status !== 'needs_attention') {
          this.clearRecoveryState(managed, 'running')
          this.changed(managed.summary.sessionId)
        }
        if (managed.suppressTransientRetryUntilReady && observation.ready) {
          managed.suppressTransientRetryUntilReady = false
        }
        this.scheduleNativeCapture(managed)
      } else if (event.type === 'permission-request') {
        // Authenticated parent-hook metadata can synchronize a manual /resume.
        // Transcript validation stays separate and never delays an approval.
        this.syncHookSessionBinding(managed, event)
        void this.bindHookNativeActivity(managed, event)
        this.finishStartup(managed)
        this.setActivity(managed, 'running')
        this.cancelClaudeTerminalApproval(managed)
        this.cancelCodexTerminalApproval(managed)
        const hookSource = event.hookSource ?? (managed.summary.agentKind === 'codex' ? 'codex' : 'claude')
        if (hookSource === 'codex') this.removeTerminalApproval(managed, event.command ?? 'tool:' + event.toolName)
        else this.removeTerminalApprovals(managed)
        if (!managed.approvalRequests.some((request) => request.source === 'terminal')) managed.adapter.acknowledgeUserInput(true)
        if (hookSource === 'claude') {
          const hookIdentity = this.rememberClaudeHookIdentity(managed, event)
          if (hookIdentity.agentId && this.resolveDuplicateClaudeHook(managed, hookIdentity)) {
            this.syncApprovalSummary(managed)
            this.changed(managed.summary.sessionId)
            continue
          }
        }
        const approvalSource = hookSource === 'codex' ? 'codex-hook' as const : 'claude-hook' as const
        const toolName = event.toolName.trim().slice(0, 256) || 'Unknown'
        const approvalCommand = event.command ?? `tool:${toolName}`
        const decision = this.approvalPolicy?.decide(approvalCommand)
        const approvalRisk = event.operation && event.operation !== 'unknown'
          ? event.operation
          : decision?.risk ?? 'unknown'
        const queued = this.queueApproval(managed, {
          requestId: event.requestId,
          source: approvalSource,
          risk: approvalRisk,
          reason: decision?.matchedDangerRule
            ? decision.reason
            : event.reason ?? decision?.reason ?? '该工具请求没有命中现有自动批准规则，需要人工确认',
          toolName,
          command: approvalCommand,
          ...(event.filePath ? { filePath: event.filePath } : {}),
          ...(event.targetPaths?.length ? { targetPaths: [...event.targetPaths] } : {}),
          ...(event.toolInputSummary ? { inputSummary: event.toolInputSummary } : {}),
          ...(event.inputTruncated ? { inputTruncated: true } : {}),
          ...approvalInputIssueFields(event.inputIssue),
          ...(event.reason ? { agentReason: event.reason } : {}),
          ...(event.turnId ? { nativeTurnId: event.turnId } : {}),
          ...(event.cwd ? { hookCwd: event.cwd } : {}),
          ...(event.model ? { hookModel: event.model } : {}),
          ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
          ...(event.transcriptPath ? { transcriptPath: event.transcriptPath } : {}),
          ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
          ...(event.rawPayload !== undefined ? { rawPayload: event.rawPayload } : {}),
          ...(decision?.matchedDangerRule ? {
            dangerRuleId: decision.matchedDangerRule.id,
            dangerRuleName: decision.matchedDangerRule.name,
          } : {}),
        })
        await this.processApproval(managed, queued)
        this.changed(managed.summary.sessionId)
      } else if (event.type === 'permission-hook-closed') {
        const closed = managed.approvalRequests.find((request) => request.requestId === event.requestId)
        if (closed) {
          this.removeApproval(managed, closed.requestId)
          this.syncApprovalSummary(managed)
          if (event.hookSource === 'codex') this.restoreCodexTerminalApprovalFromReplay(managed)
          this.changed(managed.summary.sessionId)
        }
      } else if (event.type === 'exit') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
        await this.onExit(managed, generation, event.exitCode)
        return
      } else if (event.type === 'error') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
        managed.summary = { ...managed.summary, lastError: event.message }
        this.setActivity(managed, 'error', Date.now(), event.message)
        this.changed(managed.summary.sessionId)
      } else if (event.type !== 'permission-response' && event.type !== 'replay') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
      }
    }
  }

  private async onExit(managed: ManagedSession, generation: number, exitCode: number): Promise<void> {
    if (managed.generation !== generation) return
    this.cancelSessionReviews(managed)
    const capture = managed.nativeCapture
    if (capture && !managed.summary.nativeSessionId) {
      if (capture.timer) { clearTimeout(capture.timer); capture.timer = undefined }
      capture.finalCaptureRequested = capture.inFlight
      if (!capture.inFlight) void this.tryCaptureNativeSession(managed, true)
    }
    const transientRetryPending = this.cancelTransientRetry(managed)
    this.cancelKeywordContinue(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelClaudeTerminalApproval(managed)
    this.cancelCodexTerminalApproval(managed)
    managed.approvalRequests.length = 0
    this.clearClaudeHookState(managed)
    this.syncApprovalSummary(managed)
    managed.handle.disconnect()
    if (exitCode !== 0 && !managed.agentReady && managed.startupAttempt && !managed.pendingUserInterrupt && !managed.summary.userStopRequested) {
      try { await this.retryFailedStartup(managed, `Process exited with code ${exitCode}`) } catch { /* 失败详情已发布到窗口 */ }
      return
    }
    if (managed.summary.userStopRequested) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited', exitCode, userInitiated: true, adapterCompletion: false,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }
    if (exitCode === 0) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited', exitCode: 0, userInitiated: false, adapterCompletion: false,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }
    if (managed.pendingUserInterrupt || managed.summary.userStopRequested) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited',
        exitCode,
        userInitiated: true,
        adapterCompletion: false,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }
    if (transientRetryPending && managed.summary.status === 'recovering' && managed.request?.recovery) {
      await this.startRecovery(managed)
      return
    }
    await this.failOrRecover(managed, generation, `Process exited with code ${exitCode}`)
  }

  private async failOrRecover(managed: ManagedSession, generation: number, reason: string): Promise<void> {
    if (managed.generation !== generation) return
    if (!managed.agentReady && managed.startupAttempt && !managed.pendingUserInterrupt && !managed.summary.userStopRequested) {
      try { await this.retryFailedStartup(managed, reason) } catch { /* 启动失败已发布，等待用户选择 */ }
      return
    }
    if (this.unattended.enabled(managed.summary.sessionId) || !managed.request?.recovery) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited', exitCode: 1, userInitiated: false, adapterCompletion: false,
      }) as SessionSummary
      managed.summary = { ...managed.summary, lastError: reason }
      this.changed(managed.summary.sessionId)
      return
    }
    this.requestRecovery(managed, reason, 'resume')
  }

  private async startRecovery(managed: ManagedSession): Promise<void> {
    if (this.unattended.enabled(managed.summary.sessionId)) return
    const recipe = managed.request?.recovery
    if (!recipe) return
    const generation = managed.generation
    const recoveryToken = ++managed.recoveryToken
    managed.hostTransitioning = true
    managed.pendingHostInput = ''
    if (managed.summary.webUrl) {
      const { webUrl: _webUrl, ...summary } = managed.summary
      managed.summary = summary
      this.changed(managed.summary.sessionId)
    }
    try {
      const scrollableRecipe = { ...recipe, args: terminalScrollbackArgs(managed.summary.agentKind, recipe.args) }
      const activitySince = Date.now()
      const handle = await this.manager.start({
        sessionId: managed.summary.sessionId,
        agentKind: managed.summary.agentKind,
        executable: scrollableRecipe.executable,
        args: scrollableRecipe.args,
        cwd: managed.summary.workspace,
        cols: managed.request?.cols ?? 80,
        rows: managed.request?.rows ?? 24,
        maxContinueRetries: managed.request?.maxContinueRetries,
        ...(managed.summary.agentConfig ? { agentConfig: { ...managed.summary.agentConfig, extraArgs: [...managed.summary.agentConfig.extraArgs] } } : {}),
        ...(managed.summary.agentProxy?.enabled ? { agentProxy: { ...managed.summary.agentProxy } } : {}),
        approvalMode: this.approvalMode(managed),
        ...(['agent-review', 'rules-auto'].includes(this.approvalMode(managed)) ? { fullAutoEnabled: true } : {}),
        ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
        recovery: scrollableRecipe,
      })
      if (managed.generation !== generation || managed.recoveryToken !== recoveryToken
        || managed.summary.userStopRequested || managed.summary.status === 'stopped') {
        await handle.stop().catch(() => undefined)
        handle.disconnect()
        managed.hostTransitioning = false
        managed.pendingHostInput = ''
        return
      }
      managed.handle = handle
      managed.hostTransitioning = false
      managed.generation += 1
      managed.terminalReplay.clear()
      managed.outputSequence = 0
      managed.pendingUserInterrupt = false
      managed.awaitingRecoveryReady = true
      managed.agentReady = false
      managed.activityInputPending = false
      managed.activityInputState?.reset()
      managed.summary = { ...managed.summary, activity: 'starting', activitySince, activityUpdatedAt: undefined, activityError: undefined }
      managed.suppressTransientRetryUntilReady = false
      managed.adapter.resetForRecovery()
      delete managed.lastTerminalAutoApproval
      this.flushPendingHostInput(managed)
      void this.pump(managed, managed.generation)
    } catch (error) {
      managed.hostTransitioning = false
      managed.pendingHostInput = ''
      if (managed.generation !== generation || managed.recoveryToken !== recoveryToken
        || managed.summary.userStopRequested || managed.summary.status === 'stopped') return
      await this.failOrRecover(managed, generation, error instanceof Error ? error.message : String(error))
    }
  }

  private flushPendingHostInput(managed: ManagedSession): void {
    const input = managed.pendingHostInput
    managed.pendingHostInput = ''
    if (!input || managed.pendingUserInterrupt || managed.summary.userStopRequested) return
    managed.handle.write(input)
    this.observeActivityInput(managed, input)
  }

  private requestRecovery(managed: ManagedSession, reason: string, action: 'continue' | 'resume'): void {
    if (this.unattended.enabled(managed.summary.sessionId)) {
      if (action === 'resume') {
        this.unattended.disable(managed.summary.sessionId, '会话连接异常，需人工确认后恢复：' + reason)
      } else {
        this.setActivity(managed, 'error', Date.now(), reason)
        return
      }
    }
    const alreadyAttempted = managed.activeRecoveryReason !== undefined
    managed.summary = {
      ...reduceSession(managed.summary, { type: 'retry-exhausted', reason }) as SessionSummary,
      recoveryAction: action,
      recoveryAttempted: alreadyAttempted,
      recoveryRuleApplied: false,
    }
    this.changed(managed.summary.sessionId)
    if (!alreadyAttempted && this.recoveryPolicy?.hasRule(reason)) {
      void this.performRecoveryOnce(managed, true)
    }
  }

  private markHostUnresponsive(managed: ManagedSession): void {
    this.cancelSessionReviews(managed)
    this.unattended.disable(managed.summary.sessionId, '终端进程无响应，已暂停无监管，避免重复提交')
    if (managed.pendingUserInterrupt || managed.summary.userStopRequested || isTerminalStatus(managed.summary.status)) return
    this.cancelTransientRetry(managed, true)
    this.cancelPendingContinueSubmit(managed)
    this.cancelKeywordContinue(managed)
    managed.summary = {
      ...reduceSession(managed.summary, { type: 'retry-exhausted', reason: '终端进程连续无响应' }) as SessionSummary,
      recoveryAction: 'resume',
      recoveryAttempted: false,
      recoveryRuleApplied: false,
      attentionKind: 'host-unresponsive',
    }
    this.changed(managed.summary.sessionId)
  }

  private async performRecoveryOnce(managed: ManagedSession, ruleApplied: boolean): Promise<void> {
    const reason = managed.summary.lastError
    const action = managed.summary.recoveryAction
    if (managed.summary.status !== 'needs_attention' || !reason || !action) {
      throw new Error('当前没有可恢复的异常')
    }
    if (managed.activeRecoveryReason) throw new Error('本次异常已经尝试恢复，Manager 不会再次重试')
    if (managed.summary.attentionKind === 'host-unresponsive') {
      await this.restartUnresponsiveHost(managed, reason)
      return
    }

    managed.activeRecoveryReason = reason
    managed.pendingUserInterrupt = false
    managed.adapter.acknowledgeUserInput()
    managed.summary = {
      ...managed.summary,
      status: 'recovering',
      recoveryAttempts: 1,
      recoveryAttempted: true,
      recoveryRuleApplied: ruleApplied,
    }
    this.changed(managed.summary.sessionId)

    if (action === 'continue') {
      managed.summary = { ...managed.summary, status: 'running' }
      this.changed(managed.summary.sessionId)
      this.submitContinue(managed)
      return
    }
    await this.startRecovery(managed)
  }

  private async restartUnresponsiveHost(managed: ManagedSession, reason: string): Promise<void> {
    if (!this.manager.forceRelease) throw new Error('当前版本不支持释放无响应终端，请重启 Manager 后再试')
    const sessionId = managed.summary.sessionId
    const oldHostId = managed.handle.hostId
    managed.activeRecoveryReason = reason
    managed.summary = { ...managed.summary, status: 'recovering', recoveryAttempts: 1, recoveryAttempted: true, recoveryRuleApplied: false }
    this.changed(sessionId)
    managed.generation += 1
    managed.handle.disconnect()
    try {
      await this.manager.forceRelease(oldHostId)
      managed.summary = { ...managed.summary, status: 'failed' }
      managed.activeRecoveryReason = undefined
      await this.restartSession(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      managed.hostTransitioning = false
      managed.pendingHostInput = ''
      managed.summary = { ...managed.summary, status: 'needs_attention', lastError: `重启失败：${message}`, recoveryAction: 'resume', recoveryAttempted: true, recoveryRuleApplied: false, attentionKind: 'host-unresponsive' }
      this.changed(sessionId)
      throw error
    }
  }

  private clearRecoveryState(
    managed: ManagedSession,
    status: SessionSummary['status'],
    keepError = false,
  ): void {
    const {
      recoveryAction: _action,
      recoveryAttempted: _attempted,
      recoveryRuleApplied: _ruleApplied,
      attentionKind: _attentionKind,
      lastError,
      ...summary
    } = managed.summary
    managed.activeRecoveryReason = undefined
    managed.summary = {
      ...summary,
      status,
      recoveryAttempts: 0,
      ...(keepError && lastError ? { lastError } : {}),
    }
  }

  private scheduleTransientRetry(
    managed: ManagedSession,
    error: NonNullable<AgentObservation['recoverableError']>,
  ): void {
    this.cancelTransientRetry(managed)
    this.cancelPendingContinueSubmit(managed)
    this.requestRecovery(managed, error.message, 'continue')

    /*
    if (managed.transientRetry || managed.pendingContinueSubmit || managed.pendingUserInterrupt
      || managed.summary.userStopRequested || managed.awaitingRecoveryReady
      || managed.summary.status !== 'running' || isTerminalStatus(managed.summary.status)) return

    const maxAttempts = managed.request?.maxContinueRetries ?? 3
    if (managed.summary.recoveryAttempts >= maxAttempts) {
      managed.summary = reduceSession(managed.summary, {
        type: 'retry-exhausted', reason: error.message,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }

    managed.summary = reduceSession(managed.summary, {
      type: 'abnormal-exit',
      reason: error.message,
      maxAttempts,
    }) as SessionSummary
    this.changed(managed.summary.sessionId)
    if (managed.summary.status !== 'recovering') return

    const generation = managed.generation
    const timer = setTimeout(() => {
      if (managed.transientRetry?.timer !== timer) return
      delete managed.transientRetry
      if (managed.generation !== generation || managed.pendingUserInterrupt || managed.summary.userStopRequested
        || managed.awaitingRecoveryReady || managed.summary.status !== 'running' || isTerminalStatus(managed.summary.status)) return
      managed.adapter.acknowledgeUserInput()
      managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
      this.submitContinue(managed)
      this.changed(managed.summary.sessionId)
    }, TRANSIENT_RETRY_DELAY_MS)
    timer.unref?.()
    managed.transientRetry = { timer, generation }
    */
  }

  private cancelTransientRetry(managed: ManagedSession, restoreRunning = false): boolean {
    const pending = managed.transientRetry
    if (!pending) return false
    clearTimeout(pending.timer)
    delete managed.transientRetry
    if (restoreRunning && managed.summary.status === 'recovering' && !managed.awaitingRecoveryReady) {
      managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
      this.changed(managed.summary.sessionId)
    }
    return true
  }

  private submitContinue(managed: ManagedSession): void {
    if (this.unattended.enabled(managed.summary.sessionId)) return
    if (this.messageDelivery.busy(managed.summary.sessionId)) return
    this.cancelPendingContinueSubmit(managed)
    const input = (managed.request?.recovery?.continueInput ?? 'continue').replace(/[\r\n]+$/g, '') || 'continue'
    if (managed.pendingUserInterrupt || managed.summary.userStopRequested || isTerminalStatus(managed.summary.status)) return
    // Keep text and Enter in one PTY write. Splitting them could leave a visible
    // but unsubmitted "continue" when state changed during the old 75 ms gap.
    managed.handle.write(`${input}\r`)
    this.observeActivityInput(managed, `${input}\r`)
  }

  private readonly hookApprovalContinues = new Map<string, ReturnType<typeof setTimeout>>()

  private cancelHookApprovalContinue(managed: ManagedSession): void {
    const key = managed.summary.sessionId
    const timer = this.hookApprovalContinues.get(key)
    if (timer) clearTimeout(timer)
    this.hookApprovalContinues.delete(key)
  }

  private scheduleHookApprovalContinue(managed: ManagedSession): void {
    if (managed.bindingAwaitingUser) return
    if (this.unattended.enabled(managed.summary.sessionId)) return
    this.cancelHookApprovalContinue(managed)
    const generation = managed.generation
    const key = managed.summary.sessionId
    const timer = setTimeout(() => {
      if (this.hookApprovalContinues.get(key) !== timer) return
      this.hookApprovalContinues.delete(key)
      if (this.sessions.get(key) !== managed || managed.generation !== generation
        || managed.summary.status !== 'running' || managed.summary.userStopRequested
        || managed.pendingUserInterrupt || managed.activityInputPending
        || managed.approvalRequests.length || managed.pendingTerminalAutoApproval
        || !['idle', 'completed'].includes(managed.summary.activity ?? '')
        || this.codexTerminalApprovalFromReplay(managed, true)) return
      try {
        managed.adapter.acknowledgeUserInput()
        this.submitHookContinue(managed)
      } catch { /* Keep idle if the host rejects input; never blindly retry. */ }
    }, 750)
    timer.unref?.()
    this.hookApprovalContinues.set(key, timer)
  }

  private submitHookContinue(managed: ManagedSession): void {
    if (this.messageDelivery.busy(managed.summary.sessionId)) return
    this.cancelPendingContinueSubmit(managed)
    const generation = managed.generation
    // Separate text from Enter so a TUI paste detector cannot turn CR into text.
    managed.handle.write('continue')
    const timer = setTimeout(() => {
      if (managed.pendingContinueSubmit?.timer !== timer) return
      delete managed.pendingContinueSubmit
      if (managed.generation !== generation || managed.summary.status !== 'running'
        || managed.pendingUserInterrupt || managed.summary.userStopRequested
        || managed.activityInputPending || managed.approvalRequests.length
        || !['idle', 'completed'].includes(managed.summary.activity ?? '')) return
      try {
        managed.handle.write('\r')
        this.setActivity(managed, 'running')
      } catch { /* Never retry Enter into an unknown terminal state. */ }
    }, 300)
    timer.unref?.()
    managed.pendingContinueSubmit = { timer, generation }
  }

  private observeContinueKeyword(managed: ManagedSession, data: string, observation: AgentObservation, fromActivity = false): void {
    if (managed.bindingAwaitingUser) return
    if (this.unattended.enabled(managed.summary.sessionId)) return
    if (!fromActivity && managed.continueKeywordNativeText !== undefined) return
    const policy = this.continueKeywordPolicy
    const settings = policy?.getSettings()
    const continueSuppressed = (managed.continueKeywordSuppressedUntil ?? 0) > Date.now()
    if (!policy || !settings?.enabled || settings.keywords.length === 0
      || continueSuppressed
      || managed.pendingUserInterrupt || managed.summary.userStopRequested
      || !['running', 'needs_attention'].includes(managed.summary.status) || observation.approvalRequired
      || managed.awaitingRecoveryReady) {
      this.cancelKeywordContinue(managed)
      managed.continueKeywordTail = ''
      return
    }
    delete managed.continueKeywordSuppressedUntil
    const maximum = fromActivity && managed.continueKeywordNativeText !== undefined
      ? 4096 : Math.min(4096, Math.max(256, policy.maxKeywordLength() * 2))
    data = data.slice(-maximum)
    // A native final reply/error is one bounded message. Raw PTY fallback only
    // considers its last nonempty line, never an earlier paragraph in scrollback.
    const latest = fromActivity && managed.continueKeywordNativeText !== undefined
      ? data : data.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '').trimEnd().split(/[\r\n]/).at(-1) ?? ''
    const matchedKeyword = policy.match(latest)
    if (!fromActivity) managed.continueKeywordTail = latest
    if (!matchedKeyword) {
      if (fromActivity && managed.continueKeywordNativeText && ['idle', 'completed'].includes(managed.summary.activity ?? '')) {
        managed.continueKeywordCount = 0
        managed.continueKeywordLimitLogged = false
        managed.continueKeywordAttempted.clear()
      }
      // Any fresh output after a match means the Agent continued by itself.
      // Never carry an old keyword forward until a later quiet period.
      this.cancelKeywordContinue(managed)
      return
    }
    const keyword = matchedKeyword
    if (managed.continueKeywordAttempted.has(keyword)) return
    this.cancelKeywordContinue(managed)
    const generation = managed.generation
    const outputSequence = managed.outputSequence
    const timer = setTimeout(() => {
      const pending = managed.pendingKeywordContinue
      if (!pending || pending.timer !== timer) return
      delete managed.pendingKeywordContinue
      if (managed.generation !== generation || (!fromActivity && managed.outputSequence !== outputSequence)
        || (fromActivity && (managed.continueKeywordNativeText ?? managed.continueKeywordTail) !== latest)
        || managed.pendingUserInterrupt || managed.summary.userStopRequested
        || !['running', 'needs_attention'].includes(managed.summary.status) || managed.awaitingRecoveryReady
        || !['idle', 'completed', 'error'].includes(managed.summary.activity ?? '')
        || managed.activityInputPending || managed.hostTransitioning || this.unattended.enabled(managed.summary.sessionId)
        || managed.summary.attentionKind === 'host-unresponsive' || this.messageDelivery.busy(managed.summary.sessionId)
        || managed.approvalRequests.length > 0 || isTerminalStatus(managed.summary.status)) return
      const currentSettings = policy.getSettings()
      if (!currentSettings.enabled || policy.match(latest) !== keyword) return
      const count = managed.continueKeywordCount ?? 0
      if (count >= (currentSettings.maxRetries ?? 3)) {
        if (!managed.continueKeywordLimitLogged) this.recoveryActivity?.keywordLimitReached?.(managed.summary.sessionId, count)
        managed.continueKeywordLimitLogged = true
        return
      }
      managed.continueKeywordCount = count + 1
      managed.continueKeywordAttempted.add(keyword)
      managed.adapter.acknowledgeUserInput()
      managed.continueKeywordNativeText = undefined
      managed.continueKeywordTail = ''
      const input = (managed.request?.recovery?.continueInput ?? 'continue').replace(/[\r\n]+$/g, '') || 'continue'
      void this.sendSessionMessage(managed.summary.sessionId, input, false).then(() => {
        this.recoveryActivity?.keywordContinued(managed.summary.sessionId, keyword)
      }).catch(error => {
        this.recoveryActivity?.keywordFailed?.(managed.summary.sessionId, error instanceof Error ? error.message : String(error))
      })
    }, 0)
    timer.unref?.()
    managed.pendingKeywordContinue = { timer, generation, keyword, outputSequence }
    this.recoveryActivity?.keywordMatched(managed.summary.sessionId, keyword)
  }

  private cancelKeywordContinue(managed: ManagedSession): boolean {
    const pending = managed.pendingKeywordContinue
    if (!pending) return false
    clearTimeout(pending.timer)
    delete managed.pendingKeywordContinue
    return true
  }

  private cancelPendingContinueSubmit(managed: ManagedSession): boolean {
    const pending = managed.pendingContinueSubmit
    if (!pending) return false
    clearTimeout(pending.timer)
    delete managed.pendingContinueSubmit
    return true
  }

  private hostOptions(request: StartSessionRequest, sessionId?: string): StartHostOptions {
    const args = terminalScrollbackArgs(request.agentKind, request.args)
    const recovery = request.recovery
      ? { ...request.recovery, args: terminalScrollbackArgs(request.agentKind, request.recovery.args) }
      : undefined
    return {
      ...(sessionId ? { sessionId } : {}),
      displayName: request.displayName,
      agentKind: request.agentKind,
      executable: request.executable,
      args,
      cwd: request.workspace,
      cols: request.cols,
      rows: request.rows,
      maxContinueRetries: request.maxContinueRetries,
      ...(request.agentConfig && 'hasApiKey' in request.agentConfig
        ? { agentConfig: { ...request.agentConfig, extraArgs: [...request.agentConfig.extraArgs] } }
        : {}),
      ...(request.agentProxy && 'hasPassword' in request.agentProxy && request.agentProxy.enabled
        ? { agentProxy: { ...request.agentProxy } }
        : {}),
      ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
      ...(recovery ? { recovery } : {}),
    }
  }

  private async readExitFact(hostId: string): Promise<HostExitFact | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const exit = await this.manager.readLastExit(hostId).catch(() => undefined)
      if (exit) return exit
      if (attempt < 2) await Promise.resolve()
    }
    return undefined
  }

  private async prepareNativeCapture(agentKind: AgentKind, workspace: string): Promise<NativeSessionCapture | undefined> {
    if (!this.discovery) return undefined
    try {
      const existing = await this.discovery.discover(agentKind, workspace)
      return {
        baselineIds: new Set(existing.map((session) => session.id)),
        startedAt: Date.now(),
        attempts: 0,
        inFlight: false,
      }
    } catch {
      return undefined
    }
  }

  private scheduleNativeCapture(managed: ManagedSession): void {
    const capture = managed.nativeCapture
    if (!capture || capture.inFlight || capture.timer || managed.summary.nativeSessionId || !this.discovery) return
    const delays = [0, 250, 750, 2_000, 5_000, 10_000, 20_000, 30_000]
    const delay = delays[capture.attempts]
    if (delay === undefined) return
    capture.timer = setTimeout(() => {
      capture.timer = undefined
      void this.tryCaptureNativeSession(managed)
    }, delay)
    capture.timer.unref?.()
  }

  private async tryCaptureNativeSession(managed: ManagedSession, finalCapture = false): Promise<void> {
    finalCapture ||= isTerminalStatus(managed.summary.status)
    const capture = managed.nativeCapture
    const discovery = this.discovery
    if (!capture || !discovery || capture.inFlight || managed.summary.nativeSessionId) return
    capture.inFlight = true
    const generation = managed.generation
    capture.attempts += 1
    try {
      const sessions = await discovery.discover(managed.summary.agentKind, managed.summary.workspace)
      if (managed.generation !== generation || managed.summary.nativeSessionId || managed.nativeCapture !== capture) return
      const claimed = new Set([...this.sessions.values()]
        .map((session) => session.summary.nativeSessionId)
        .filter((id): id is string => Boolean(id)))
      const candidates = sessions.filter((session) => !capture.baselineIds.has(session.id)
        && !claimed.has(session.id) && !this.nativeCaptureReservations.has(session.id)
        && (!this.nativeSessionReservations.has(JSON.stringify([managed.summary.agentKind, session.id]))
          || this.nativeSessionReservations.get(JSON.stringify([managed.summary.agentKind, session.id]))?.owner === managed.summary.sessionId)
        && session.updatedAt >= capture.startedAt - 5_000
        && session.updatedAt <= (finalCapture ? Date.now() + 5_000 : capture.startedAt + 5 * 60_000))
        .sort((left, right) => Math.abs(left.updatedAt - capture.startedAt) - Math.abs(right.updatedAt - capture.startedAt)
          || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      const candidate = candidates[0]
      // Exit-time discovery may span a long task. Never guess between other windows.
      if (finalCapture && candidates.length !== 1) return
      if (!candidate) return
      const nativeSessionId = candidate.id
      const request = managed.request
      if (!request) return
      const recovery = managed.adapter.recoveryRecipe(request.executable, nativeSessionId)
      if (!recovery) return
      this.nativeCaptureReservations.add(nativeSessionId)
      try {
        // The Host can already have exited. Retain the binding in the Manager catalog
        // even when its old host metadata is no longer writable.
        try { await this.manager.updateMetadata(managed.handle.hostId, { nativeSessionId, recovery }) } catch {
          if (!finalCapture && !isTerminalStatus(managed.summary.status)) return
        }
        if (managed.generation !== generation || managed.nativeCapture !== capture) return
        request.nativeSessionId = nativeSessionId
        request.recovery = recovery
        managed.summary = { ...managed.summary, nativeSessionId }
        delete managed.nativeCapture
        this.changed(managed.summary.sessionId)
      } finally {
        this.nativeCaptureReservations.delete(nativeSessionId)
      }
    } catch {
      // Native history is advisory. A failed read must not interrupt the live Agent.
    } finally {
      capture.inFlight = false
      if (managed.nativeCapture === capture && capture.finalCaptureRequested) {
        capture.finalCaptureRequested = false
        void this.tryCaptureNativeSession(managed, true)
        return
      }
      if (!finalCapture && managed.nativeCapture === capture) this.scheduleNativeCapture(managed)
    }
  }

  private scheduleClaudeTerminalApproval(managed: ManagedSession, observation: AgentObservation, eventData: string): void {
    // Claude local-agent mailbox approvals are rendered directly by the leader TUI
    // and bypass command PermissionRequest hooks. Fall back only for that explicit
    // prompt; all other Hook-enabled Claude output remains structure-only.
    if (managed.handle.permissionHook === 'claude' && !observation.forwardedSubagentApproval && !observation.nativeClaudeApprovalMenu) return
    if (Date.now() < (managed.claudeTerminalFallbackBlockedUntil ?? 0)) return
    if (managed.approvalRequests.some((request) => request.source === 'claude-hook')) return
    const pending = managed.pendingClaudeTerminalApproval
    if (pending) {
      pending.observation = observation
      pending.eventData = eventData
      return
    }
    const generation = managed.generation
    const scheduled = {
      generation,
      observation,
      eventData,
      timer: setTimeout(() => {
        if (managed.pendingClaudeTerminalApproval !== scheduled) return
        delete managed.pendingClaudeTerminalApproval
        if (managed.generation !== generation || managed.summary.userStopRequested
          || isTerminalStatus(managed.summary.status)
          || managed.approvalRequests.some((request) => request.source === 'claude-hook')) return
        this.handleTerminalApproval(managed, scheduled.observation, scheduled.eventData)
      }, CLAUDE_TERMINAL_APPROVAL_FALLBACK_MS),
    }
    managed.pendingClaudeTerminalApproval = scheduled
  }

  private cancelClaudeTerminalApproval(managed: ManagedSession): void {
    if (!managed.pendingClaudeTerminalApproval) return
    clearTimeout(managed.pendingClaudeTerminalApproval.timer)
    delete managed.pendingClaudeTerminalApproval
  }

  private scheduleCodexTerminalApproval(managed: ManagedSession, observation: AgentObservation, eventData: string): void {
    if (this.codexHookCoversTerminalApproval(managed, observation)) return
    const pending = managed.pendingCodexTerminalApproval
    if (pending) {
      pending.observation = observation
      pending.eventData = eventData
      return
    }
    const generation = managed.generation
    const scheduled = {
      generation,
      observation,
      eventData,
      timer: setTimeout(() => {
        if (managed.pendingCodexTerminalApproval !== scheduled) return
        delete managed.pendingCodexTerminalApproval
        if (managed.generation !== generation || managed.summary.userStopRequested
          || isTerminalStatus(managed.summary.status)
          || this.codexHookCoversTerminalApproval(managed, scheduled.observation)) return
        this.handleTerminalApproval(managed, scheduled.observation, scheduled.eventData)
      }, CODEX_TERMINAL_APPROVAL_FALLBACK_MS),
    }
    scheduled.timer.unref?.()
    managed.pendingCodexTerminalApproval = scheduled
  }

  private codexHookCoversTerminalApproval(managed: ManagedSession, observation: AgentObservation): boolean {
    const command = observation.approvalCommand
    if (!command || command.startsWith('tool:')) return false
    return managed.approvalRequests.some((request) => request.source === 'codex-hook'
      && request.command === command)
  }

  private cancelCodexTerminalApproval(managed: ManagedSession): void {
    if (!managed.pendingCodexTerminalApproval) return
    clearTimeout(managed.pendingCodexTerminalApproval.timer)
    delete managed.pendingCodexTerminalApproval
  }

  private codexTerminalApprovalFromReplay(managed: ManagedSession, currentScreenOnly = false, evidence?: string): { observation: AgentObservation; replay: string } | undefined {
    let replay = evidence ?? managed.terminalReplay.snapshot()
    if (currentScreenOnly) {
      // Replay includes scrollback and older frames. Keep that history intact for
      // the renderer, but never retry an approval erased by a full-screen clear.
      const clears = [...replay.matchAll(/\x1b\[(?:0?[23])J/g)]
      const lastClear = clears.at(-1)
      if (lastClear) replay = replay.slice(lastClear.index! + lastClear[0].length)
    }
    if (!replay) return undefined
    const observation = createAgentAdapter('codex').observeOutput(replay)
    return observation.approvalRequired ? { observation, replay } : undefined
  }

  private restoreCodexTerminalApprovalFromReplay(managed: ManagedSession): boolean {
    const fallback = this.codexTerminalApprovalFromReplay(managed)
    if (!fallback) return false
    this.handleTerminalApproval(managed, fallback.observation, fallback.replay)
    return true
  }

  private approveExpiredCodexHookViaTerminal(managed: ManagedSession, request: ApprovalRequest): boolean {
    const fallback = this.codexTerminalApprovalFromReplay(managed, true)
    if (!fallback || !request.command || fallback.observation.approvalCommand !== request.command) return false
    this.cancelCodexTerminalApproval(managed)
    this.removeTerminalApprovals(managed)
    managed.adapter.acknowledgeUserInput(true)
    managed.handle.write(managed.adapter.approvalInput())
    this.schedulePendingTerminalAutoApproval(managed, fallback.observation.approvalCommand ?? request.command, undefined, request)
    return true
  }

  private removeTerminalApprovals(managed: ManagedSession): void {
    for (const request of managed.approvalRequests) {
      if (request.source === 'terminal') this.cancelApprovalReview(request.requestId)
    }
    const remaining = managed.approvalRequests.filter((request) => request.source !== 'terminal')
    if (remaining.length === managed.approvalRequests.length) return
    managed.approvalRequests = remaining
    this.syncApprovalSummary(managed)
  }

  private handleTerminalApproval(managed: ManagedSession, observation: AgentObservation, eventData: string): void {
    // Every terminal observation represents the currently painted approval prompt.
    // Process it even when another request is already queued; a session can expose
    // several approvals during one turn and the queue must keep them addressable.
    if (observation.approvalRequired) {
      this.setActivity(managed, 'running')
      const approvalCommand = observation.approvalCommand ?? extractApprovalCommand(eventData)
      if (managed.pendingTerminalAutoApproval && managed.pendingTerminalAutoApproval.command === approvalCommand) return
      // Codex emits a short OSC "approval requested" notification before the
      // actual ratatui modal. It is only a signal, not an actionable command;
      // wait for the complete modal so a truncated repaint cannot create a
      // phantom approval request.
      if (managed.summary.agentKind === 'codex'
        && approvalCommand === 'tool:Shell'
        && !/(?:would you like to|allow\s+(?:the\s+)?[\w.-]+\s+mcp\s+server|yes,\s*proceed\b|do you want to (?:allow|run|execute))/i.test(eventData)) {
        return
      }
      const existing = managed.approvalRequests.find((request) => request.source === 'terminal'
        && request.command === approvalCommand)
      if (existing) {
        this.syncApprovalSummary(managed)
        return
      }
      const decision = this.approvalPolicy?.decide(approvalCommand)
      const queued = this.queueApproval(managed, {
        requestId: 'terminal:' + randomUUID(), source: 'terminal',
        risk: decision?.risk ?? 'unknown',
        reason: decision?.matchedDangerRule
          ? decision.reason
          : observation.approvalReason ?? decision?.reason ?? '未能识别授权请求的具体影响，需要人工确认',
        ...(approvalCommand ? { command: approvalCommand } : {}),
        ...(observation.approvalReason ? { agentReason: observation.approvalReason } : {}),
        ...(decision?.matchedDangerRule ? {
          dangerRuleId: decision.matchedDangerRule.id,
          dangerRuleName: decision.matchedDangerRule.name,
        } : {}),
      })
      void this.processApproval(managed, queued)
      this.changed(managed.summary.sessionId)
    }
  }

  private scheduleTerminalRejectionCheck(managed: ManagedSession, request: ApprovalRequest, delivery: ApprovalDeliveryContext): void {
    const current = (): boolean => this.sameApprovalDelivery(managed, delivery) && !managed.hostTransitioning
      && this.approvalModeVersions.get(managed.summary.sessionId) === delivery.modeVersion
      && !managed.summary.userStopRequested && !isTerminalStatus(managed.summary.status) && this.approvalMode(managed) !== 'manual'
    const timer = setTimeout(() => {
      void (async () => {
        if (!current()) return
        let replay: string
        try { replay = await delivery.handle.replay(2000) } catch {
          if (current()) await this.stopAfterApprovalDeliveryFailure(managed, request, delivery,
            '自动拒绝已发送，但无法读取终端确认审批已关闭，已停止原会话；未转人工审批')
          return
        }
        if (!current()) return
        const observation = createAgentAdapter(managed.summary.agentKind).observeOutput(replay)
        if (observation.approvalRequired && (!request.command || observation.approvalCommand === request.command)) {
          await this.stopAfterApprovalDeliveryFailure(managed, request, delivery,
            '自动拒绝按键已发送，但终端仍显示同一审批，已停止原会话；未转人工审批')
        }
      })()
    }, 1000)
    timer.unref?.()
  }

  private schedulePendingTerminalAutoApproval(managed: ManagedSession, command: string | undefined,
    onConfirmed?: () => void, request?: ApprovalRequest): void {
    // Only retry the exact Codex modal still present in the current terminal.
    // A notification or a successful socket write alone is not acknowledgement.
    if (managed.summary.agentKind !== 'codex' || !command) return
    this.cancelPendingTerminalAutoApproval(managed)
    const generation = managed.generation
    const delivery = this.approvalDeliveryContext(managed)
    let checks = 0
    let lastWriteSequence = -1
    const check = (): void => {
      if (managed.pendingTerminalAutoApproval !== pending) return
      if (managed.generation !== generation || isTerminalStatus(managed.summary.status)
        || managed.summary.userStopRequested) {
        this.cancelPendingTerminalAutoApproval(managed)
        return
      }
      const fallback = this.codexTerminalApprovalFromReplay(managed, true, pending.replay)
      if (!fallback || fallback.observation.approvalCommand !== command) {
        this.cancelPendingTerminalAutoApproval(managed)
        return
      }
      checks += 1
      // Give delayed raw-input setup more than a single 250ms opportunity.
      // Never send a blind Enter into an OSC notification or another command.
      if (checks < 4 && managed.outputSequence !== lastWriteSequence && /(?:yes,\s*proceed|(?:^|\n)\s*[›❯>]?\s*1[.)]\s*yes)/im.test(fallback.replay)) {
        try {
          managed.handle.write(managed.adapter.approvalInput())
          lastWriteSequence = managed.outputSequence
        } catch { checks = 4 }
      }
      if (checks >= 4) {
        this.cancelPendingTerminalAutoApproval(managed)
        delete managed.lastTerminalAutoApproval
        if (this.approvalMode(managed) !== 'manual') {
          const reason = '自动批准按键重试耗尽，终端仍显示同一审批，已停止原会话；未转人工审批'
          const failed = request ?? this.approvalForActivity(managed, {
            requestId: 'terminal:' + randomUUID(), source: 'terminal', command,
            risk: this.approvalPolicy?.decide(command).risk ?? 'unknown', reason,
          })
          void this.stopAfterApprovalDeliveryFailure(managed, failed, delivery, reason)
          return
        }
        this.queueApproval(managed, {
          requestId: 'terminal:' + randomUUID(), source: 'terminal', command,
          risk: this.approvalPolicy?.decide(command).risk ?? 'unknown',
          reason: '已发送批准按键，但终端仍显示同一审批；自动重试已停止，请人工确认',
        })
        this.changed(managed.summary.sessionId)
        return
      }
      pending.timer = setTimeout(check, 750)
      pending.timer.unref?.()
    }
    const pending: NonNullable<ManagedSession['pendingTerminalAutoApproval']> = {
      command, generation, onConfirmed,
      replay: managed.terminalReplay.tail(32 * 1024),
      timer: setTimeout(check, TERMINAL_AUTO_APPROVAL_CONFIRM_MS),
    }
    pending.timer.unref?.()
    managed.pendingTerminalAutoApproval = pending
  }

  private observePendingTerminalAutoApproval(managed: ManagedSession, observation: AgentObservation, data: string): void {
    const pending = managed.pendingTerminalAutoApproval
    if (!pending) return
    pending.replay = (pending.replay + data).slice(-32 * 1024)
    // Ordinary streaming output needs no synchronous reclassification.
    // The bounded timer checks the modal before any retry.
    if (!observation.ready && !observation.approvalRequired) return
    const current = this.codexTerminalApprovalFromReplay(managed, true, pending.replay)
    if (observation.ready && !current) {
      this.cancelPendingTerminalAutoApproval(managed)
      pending.onConfirmed?.()
    } else if (current?.observation.approvalCommand !== undefined
      && current.observation.approvalCommand !== pending.command) {
      this.cancelPendingTerminalAutoApproval(managed)
    }
  }

  private cancelPendingTerminalAutoApproval(managed: ManagedSession): void {
    const pending = managed.pendingTerminalAutoApproval
    if (!pending) return
    clearTimeout(pending.timer)
    delete managed.pendingTerminalAutoApproval
  }
  private isDuplicateTerminalAutoApproval(managed: ManagedSession, command: string | undefined): boolean {
    const now = Date.now()
    const key = command ?? 'approval:unknown'
    const previous = managed.lastTerminalAutoApproval
    managed.lastTerminalAutoApproval = {
      command: key,
      expiresAt: now + TERMINAL_AUTO_APPROVAL_REDRAW_GUARD_MS,
    }
    return Boolean(previous && previous.command === key && previous.expiresAt > now)
  }

  private rememberClaudeHookIdentity(
    managed: ManagedSession,
    event: Extract<HostEvent, { type: 'permission-request' }>,
  ): ClaudeHookIdentity {
    const structuredFingerprint = /^[a-f0-9]{64}$/i.test(event.toolInputFingerprint ?? '')
      ? event.toolInputFingerprint!.toLowerCase()
      : undefined
    const fingerprint = JSON.stringify({
      toolName: event.toolName,
      ...(structuredFingerprint
        ? { toolInputFingerprint: structuredFingerprint }
        : {
            command: event.command ?? null,
            filePath: event.filePath ?? null,
            targetPaths: event.targetPaths ?? null,
            toolInputSummary: event.toolInputSummary ?? null,
          }),
    })
    const identity: ClaudeHookIdentity = {
      requestId: event.requestId,
      fingerprint,
      createdAt: Date.now(),
      ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.agentType ? { agentType: event.agentType } : {}),
    }
    const identities = managed.claudeHookIdentities ?? new Map<string, ClaudeHookIdentity>()
    identities.set(identity.requestId, identity)
    managed.claudeHookIdentities = identities
    return identity
  }

  private resolveDuplicateClaudeHook(managed: ManagedSession, identity: ClaudeHookIdentity): boolean {
    const now = Date.now()
    const recent = (managed.recentClaudeHookApprovals ?? [])
      .filter((approval) => approval.approvedAt + CLAUDE_HOOK_DUPLICATE_WINDOW_MS > now)
    managed.recentClaudeHookApprovals = recent
    const approved = recent.find((approval) => this.sameClaudeHookIdentity(
      { ...approval, createdAt: approval.approvedAt },
      identity,
      true,
    ))
    if (approved) {
      this.respondToClaudeHook(managed, identity.requestId, 'allow')
      return true
    }

    for (const request of managed.approvalRequests) {
      if (request.source !== 'claude-hook') continue
      const pendingIdentity = managed.claudeHookIdentities?.get(request.requestId)
      if (!pendingIdentity || !this.sameClaudeHookIdentity(pendingIdentity, identity, true)) continue
      const aliases = managed.claudeHookAliases ?? new Map<string, Set<string>>()
      const requestAliases = aliases.get(request.requestId) ?? new Set<string>()
      requestAliases.add(identity.requestId)
      aliases.set(request.requestId, requestAliases)
      managed.claudeHookAliases = aliases
      return true
    }
    return false
  }

  private sameClaudeHookIdentity(
    existing: ClaudeHookIdentity,
    candidate: ClaudeHookIdentity,
    allowMainToSubagentClone: boolean,
  ): boolean {
    if (Math.abs(existing.createdAt - candidate.createdAt) > CLAUDE_HOOK_DUPLICATE_WINDOW_MS) return false
    if (existing.toolUseId && candidate.toolUseId && existing.toolUseId === candidate.toolUseId) return true
    if (existing.fingerprint !== candidate.fingerprint) return false
    // Two requests from the same subagent with different tool-use IDs are real,
    // independent calls even when their inputs happen to be identical. A main
    // request and its subagent clone can carry different tool-use IDs, however;
    // merge that exact-fingerprint pair into one user decision.
    if (existing.agentId && candidate.agentId) {
      return existing.agentId === candidate.agentId
        && (!existing.toolUseId || !candidate.toolUseId)
    }
    return allowMainToSubagentClone && Boolean(existing.agentId) !== Boolean(candidate.agentId)
  }

  private respondToClaudeHook(
    managed: ManagedSession,
    requestId: string,
    action: 'allow' | 'deny',
    reason?: string,
  ): void | Promise<void> {
    if (action === 'deny' && managed.handle.respondToPermissionChecked) {
      return this.respondToClaudeHookChecked(managed, requestId, 'deny', reason)
    }
    const identities = managed.claudeHookIdentities
    const aliases = managed.claudeHookAliases
    const primaryIdentity = identities?.get(requestId)
    const responseIds = new Set<string>([requestId, ...(aliases?.get(requestId) ?? [])])

    if (primaryIdentity && !primaryIdentity.agentId) {
      for (const request of [...managed.approvalRequests]) {
        if (request.requestId === requestId || request.source !== 'claude-hook') continue
        const candidate = identities?.get(request.requestId)
        if (!candidate?.agentId || !this.sameClaudeHookIdentity(primaryIdentity, candidate, true)) continue
        responseIds.add(request.requestId)
        for (const alias of aliases?.get(request.requestId) ?? []) responseIds.add(alias)
        this.removeApproval(managed, request.requestId)
      }
    }

    const approvedAt = Date.now()
    for (const responseId of responseIds) {
      managed.handle.respondToPermission(responseId, action, reason)
      const identity = identities?.get(responseId)
      if (action === 'allow' && identity) this.rememberApprovedClaudeHook(managed, identity, approvedAt)
      identities?.delete(responseId)
      aliases?.delete(responseId)
    }
    aliases?.delete(requestId)
  }

  private async respondToClaudeHookChecked(managed: ManagedSession, requestId: string, action: 'allow' | 'deny', reason?: string): Promise<void> {
    const delivery = this.approvalDeliveryContext(managed)
    const primaryIdentity = managed.claudeHookIdentities?.get(requestId)
    const deliveredIds = new Set<string>()
    const mergedRequests = new Set<string>()
    for (;;) {
      if (!this.sameApprovalDelivery(managed, delivery)) return
      const responseIds = new Set<string>([requestId, ...(managed.claudeHookAliases?.get(requestId) ?? [])])
      if (primaryIdentity && !primaryIdentity.agentId) {
        for (const candidateRequest of managed.approvalRequests) {
          if (candidateRequest.requestId === requestId || candidateRequest.source !== 'claude-hook') continue
          const identity = managed.claudeHookIdentities?.get(candidateRequest.requestId)
          if (!identity?.agentId || !this.sameClaudeHookIdentity(primaryIdentity, identity, true)) continue
          mergedRequests.add(candidateRequest.requestId)
          responseIds.add(candidateRequest.requestId)
          for (const alias of managed.claudeHookAliases?.get(candidateRequest.requestId) ?? []) responseIds.add(alias)
        }
      }
      const remaining = [...responseIds].filter(id => !deliveredIds.has(id))
      if (!remaining.length) break
      for (const id of remaining) {
        if (!this.sameApprovalDelivery(managed, delivery)) return
        if (!await delivery.handle.respondToPermissionChecked!(id, action, reason)) {
          throw new Error('Claude 审批响应未送达，Hook 已失效')
        }
        deliveredIds.add(id)
      }
      // A duplicate alias may arrive while an acknowledgement is in flight.
      // Pick it up before removing the primary request and its identity.
    }
    for (const id of deliveredIds) {
      const identity = managed.claudeHookIdentities?.get(id)
      if (action === 'allow' && identity) this.rememberApprovedClaudeHook(managed, identity, Date.now())
      managed.claudeHookIdentities?.delete(id)
      managed.claudeHookAliases?.delete(id)
    }
    for (const id of mergedRequests) this.removeApproval(managed, id)
  }

  private rememberApprovedClaudeHook(
    managed: ManagedSession,
    identity: ClaudeHookIdentity,
    approvedAt: number,
  ): void {
    const recent = (managed.recentClaudeHookApprovals ?? [])
      .filter((approval) => approval.approvedAt + CLAUDE_HOOK_DUPLICATE_WINDOW_MS > approvedAt)
    recent.push({ ...identity, approvedAt })
    managed.recentClaudeHookApprovals = recent.slice(-32)
  }

  private clearClaudeHookState(managed: ManagedSession): void {
    delete managed.claudeHookIdentities
    delete managed.claudeHookAliases
    delete managed.recentClaudeHookApprovals
  }

  private required(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error('Unknown session')
    return managed
  }

  private requiredApproval(requestId: string): { managed: ManagedSession; request: ApprovalRequest } {
    for (const managed of this.sessions.values()) {
      const request = managed.approvalRequests.find((item) => item.requestId === requestId)
      if (request) return { managed, request }
    }
    throw new Error('该授权请求已处理或已失效，请刷新后重试')
  }

  private queueApproval(
    managed: ManagedSession,
    input: Pick<ApprovalRequest, 'requestId' | 'source' | 'risk' | 'reason'>
      & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'inputTruncated' | 'inputIssue' | 'filePath' | 'targetPaths' | 'agentReason' | 'dangerRuleId' | 'dangerRuleName' | 'nativeTurnId' | 'hookCwd' | 'hookModel' | 'permissionMode' | 'transcriptPath' | 'toolInput' | 'rawPayload'>>,
  ): ApprovalRequest {
    const terminalIndex = input.source === 'terminal'
      ? this.findTerminalApprovalToUpdate(managed, input.command)
      : -1
    const requestIndex = terminalIndex >= 0
      ? terminalIndex
      : managed.approvalRequests.findIndex((request) => request.requestId === input.requestId)
    const previous = requestIndex >= 0 ? managed.approvalRequests[requestIndex] : undefined
    const preserveLlmReview = Boolean(previous && sameApprovalReviewSubject(previous, { ...input, workspace: managed.summary.workspace }))
    if (previous && !preserveLlmReview) this.cancelApprovalReview(previous.requestId)
    const request: ApprovalRequest = {
      requestId: previous?.requestId ?? input.requestId,
      sessionId: managed.summary.sessionId,
      displayName: managed.summary.displayName,
      agentKind: managed.summary.agentKind,
      workspace: managed.summary.workspace,
      ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
      source: input.source,
      risk: input.risk,
      reason: input.reason,
      ...(input.agentReason ? { agentReason: input.agentReason } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.inputSummary ? { inputSummary: input.inputSummary } : {}),
      ...(input.inputTruncated ? { inputTruncated: true } : {}),
      ...approvalInputIssueFields(input.inputIssue),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.targetPaths?.length ? { targetPaths: [...input.targetPaths] } : {}),
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      ...(input.hookCwd ? { hookCwd: input.hookCwd } : {}),
      ...(input.hookModel ? { hookModel: input.hookModel } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
      ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
      ...(input.dangerRuleId ? { dangerRuleId: input.dangerRuleId } : {}),
      ...(input.dangerRuleName ? { dangerRuleName: input.dangerRuleName } : {}),
      ...(preserveLlmReview && previous?.llmReviewStatus ? { llmReviewStatus: previous.llmReviewStatus } : {}),
      ...(preserveLlmReview && previous?.llmReview ? { llmReview: previous.llmReview } : {}),
      ...(preserveLlmReview && previous?.llmReviewError ? { llmReviewError: previous.llmReviewError } : {}),
      createdAt: previous?.createdAt ?? Date.now(),
      canBulkApprove: this.approvalPolicy?.canBulkApproveCommand?.(input.command) ?? canBulkApproveCommand(input.command),
    }
    if (requestIndex >= 0) managed.approvalRequests[requestIndex] = request
    else managed.approvalRequests.push(request)
    this.syncApprovalSummary(managed)
    // Hook requests may be refined or re-emitted with the same request id.
    // Re-arm the notifier for those updates; DingTalkStreamService deduplicates
    // successful sends by requestId, while this avoids losing the first alert.
    if (requestIndex < 0 || request.source !== 'terminal') {
      const mode = this.approvalMode(managed)
      if (mode === 'manual') this.fullAutoActivity?.pending?.(request)
    }
    return request
  }

  private findTerminalApprovalToUpdate(managed: ManagedSession, command: string | undefined): number {
    const terminalRequests = managed.approvalRequests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.source === 'terminal')
    if (terminalRequests.length === 0) return -1

    // Repaints of the same command update the existing entry. This also keeps
    // LLM review state attached to the request while its reason/details refine.
    const exact = terminalRequests.find(({ request }) => request.command === command)
    if (exact) return exact.index

    // Codex may first emit an OSC notification without the full command. Once
    // the complete line arrives, refine that placeholder instead of creating a
    // second entry. Never replace an already complete command with a placeholder.
    const isPlaceholder = !command || command === 'tool:Shell'
    if (!isPlaceholder) {
      const placeholder = terminalRequests.find(({ request }) => !request.command || request.command === 'tool:Shell')
      if (placeholder) return placeholder.index
    }
    return -1
  }

  private removeTerminalApproval(managed: ManagedSession, command: string | undefined): void {
    const index = this.findTerminalApprovalToUpdate(managed, command)
    if (index < 0) return
    this.cancelApprovalReview(managed.approvalRequests[index]!.requestId)
    managed.approvalRequests.splice(index, 1)
    this.syncApprovalSummary(managed)
  }

  private approvalForActivity(
    managed: ManagedSession,
    input: Pick<ApprovalRequest, 'requestId' | 'source' | 'risk' | 'reason'>
      & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'inputTruncated' | 'inputIssue' | 'filePath' | 'targetPaths' | 'agentReason' | 'dangerRuleId' | 'dangerRuleName' | 'nativeTurnId' | 'hookCwd' | 'hookModel' | 'permissionMode' | 'transcriptPath' | 'toolInput' | 'rawPayload'>>,
  ): ApprovalRequest {
    return {
      requestId: input.requestId,
      sessionId: managed.summary.sessionId,
      displayName: managed.summary.displayName,
      agentKind: managed.summary.agentKind,
      workspace: managed.summary.workspace,
      ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
      source: input.source,
      risk: input.risk,
      reason: input.reason,
      ...(input.agentReason ? { agentReason: input.agentReason } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.inputSummary ? { inputSummary: input.inputSummary } : {}),
      ...(input.inputTruncated ? { inputTruncated: true } : {}),
      ...approvalInputIssueFields(input.inputIssue),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.targetPaths?.length ? { targetPaths: [...input.targetPaths] } : {}),
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      ...(input.hookCwd ? { hookCwd: input.hookCwd } : {}),
      ...(input.hookModel ? { hookModel: input.hookModel } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
      ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
      ...(input.dangerRuleId ? { dangerRuleId: input.dangerRuleId } : {}),
      ...(input.dangerRuleName ? { dangerRuleName: input.dangerRuleName } : {}),
      createdAt: Date.now(),
      canBulkApprove: this.approvalPolicy?.canBulkApproveCommand?.(input.command) ?? canBulkApproveCommand(input.command),
    }
  }

  private removeApproval(managed: ManagedSession, requestId: string): void {
    this.cancelApprovalReview(requestId)
    const index = managed.approvalRequests.findIndex((request) => request.requestId === requestId)
    if (index >= 0) managed.approvalRequests.splice(index, 1)
  }

  private syncApprovalSummary(managed: ManagedSession): void {
    const {
      pendingApprovalCommand: _pending,
      approvalRisk: _approvalRisk,
      approvalReason: _approvalReason,
      approvalToolName: _approvalToolName,
      approvalFilePath: _approvalFilePath,
      approvalTargetPaths: _approvalTargetPaths,
      approvalInputSummary: _approvalInputSummary,
      pendingApprovalCount: _pendingCount,
      ...base
    } = managed.summary
    const request = managed.approvalRequests[0]
    if (!request) {
      managed.summary = managed.summary.status === 'needs_approval'
        ? reduceSession(base, { type: 'started' }) as SessionSummary
        : base
      delete managed.pendingApprovalCommand
      return
    }
    managed.pendingApprovalCommand = request.command
    managed.summary = {
      ...reduceSession(base, { type: 'approval-required' }) as SessionSummary,
      ...(request.command ? { pendingApprovalCommand: request.command } : {}),
      approvalRisk: request.risk,
      approvalReason: request.reason,
      ...(request.toolName ? { approvalToolName: request.toolName } : {}),
      ...(request.filePath ? { approvalFilePath: request.filePath } : {}),
      ...(request.targetPaths?.length ? { approvalTargetPaths: [...request.targetPaths] } : {}),
      ...(request.inputSummary ? { approvalInputSummary: request.inputSummary } : {}),
      pendingApprovalCount: managed.approvalRequests.length,
    }
  }

  private completeManualApproval(managed: ManagedSession, request: ApprovalRequest): void {
    this.completeApproval(managed, request, true)
  }

  private completeApproval(managed: ManagedSession, request: ApprovalRequest, recordManualApproval: boolean): void {
    const suggestion = recordManualApproval ? this.approvalPolicy?.noteManualApproval(request.command) : undefined
    this.removeApproval(managed, request.requestId)
    this.syncApprovalSummary(managed)
    if (suggestion) managed.summary = { ...managed.summary, approvalSuggestion: suggestion }
    this.changed(managed.summary.sessionId)
  }

  private async failAutomaticReview(managed: ManagedSession, request: ApprovalRequest, reason: string, routing?: LlmReviewRouting): Promise<void> {
    request.llmReviewStatus = 'failed'
    request.llmReviewError = reason
    request.llmReview = { ...unavailableReviewConclusion(reason), ...routing }
    this.fullAutoActivity?.reviewFailed?.(request, reason)
    await this.rejectAutomaticRequest(managed, request, reason, true)
    this.changed(managed.summary.sessionId)
  }

  private scheduleLlmReview(managed: ManagedSession, request: ApprovalRequest, assessment: LocalApprovalAssessment): void {
    if (this.approvalReviews.has(request.requestId)) return
    if (!this.llmReview?.getSettings().enabled) {
      void this.failAutomaticReview(managed, request, '审核器未启用，本次请求已拒绝；这不是命令危险性的结论')
      return
    }
    const review = { abort: new AbortController() }
    this.approvalReviews.set(request.requestId, review)
    const generation = managed.generation
    const modeVersion = this.approvalModeVersions.get(managed.summary.sessionId)
    const policyVersion = this.approvalPolicyVersion
    const snapshot = structuredClone(request)
    const currentRequest = (): ApprovalRequest | undefined => {
      if (review.abort.signal.aborted || this.approvalReviews.get(request.requestId) !== review
        || managed.summary.userStopRequested || managed.hostTransitioning || isTerminalStatus(managed.summary.status)
        || managed.generation !== generation || this.approvalMode(managed) !== 'agent-review'
        || this.approvalModeVersions.get(managed.summary.sessionId) !== modeVersion
        || this.approvalPolicyVersion !== policyVersion) return undefined
      const current = managed.approvalRequests.find(item => item.requestId === request.requestId)
      return current && sameApprovalReviewSubject(current, snapshot) ? current : undefined
    }
    request.llmReviewStatus = 'pending'
    delete request.llmReview
    delete request.llmReviewError
    this.fullAutoActivity?.reviewStarted?.(request)
    this.changed(managed.summary.sessionId)
    // A legacy/injected reviewer can throw before returning its promise. Route
    // synchronous failures through the same denial path as rejected promises.
    void Promise.resolve().then(() => {
      if (review.abort.signal.aborted) return undefined
      return this.llmReview!.reviewApproval(snapshot, assessment.reason, review.abort.signal)
    }).then(async rawConclusion => {
      const current = currentRequest()
      if (!current) return
      if (!this.llmReview?.getSettings().enabled) {
        await this.failAutomaticReview(managed, current, '审核器已停用，本次请求已拒绝；这不是命令危险性的结论')
        return
      }
      let conclusion = automaticReviewConclusion(rawConclusion!)
      // Reassess before recording the final outcome, so an incomplete request
      // can never be audited as allowed while receiving a denial.
      let latestAssessment: LocalApprovalAssessment
      try { latestAssessment = this.assessRequest(current) } catch {
        await this.failAutomaticReview(managed, current, '本地规则复核未能完成，本次请求已拒绝；这不是命令危险性的结论。请检查规则配置后重新提交完整请求')
        return
      }
      if (latestAssessment.status === 'incomplete') {
        conclusion = { ...conclusion, verdict: 'deny', requiresHumanApproval: false, summary: latestAssessment.reason }
      }
      current.llmReviewStatus = 'completed'
      current.llmReview = conclusion
      this.fullAutoActivity?.reviewed?.(current, conclusion)
      const delivery = this.approvalDeliveryContext(managed)
      try {
        if (conclusion.verdict === 'allow') {
          await this.approveRequest(current.requestId, false)
          if (this.sameApprovalDelivery(managed, delivery) && !managed.summary.userStopRequested) this.reportAutomaticApproval(managed, current)
        } else {
          await this.rejectAutomaticRequest(managed, current, conclusion.summary + '\n' + conclusion.reasons.join('；'))
        }
      } catch {
        await this.stopAfterApprovalDeliveryFailure(managed, current, delivery)
      }
      this.changed(managed.summary.sessionId)
    }).catch(async error => {
      const current = currentRequest()
      if (!current) return
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 800)
      const routing = error instanceof LlmReviewerPoolError
        ? { attempts: error.attempts.map(attempt => ({ ...attempt })) }
        : undefined
      await this.failAutomaticReview(managed, current, '审核服务未能给出有效结论：' + detail + '。本次已拒绝；审核不可用不代表该命令已被判定危险', routing)
    }).finally(() => {
      if (this.approvalReviews.get(request.requestId) === review) this.approvalReviews.delete(request.requestId)
    })
  }

  private changed(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed && this.catalog) {
      void this.catalog.upsert({
        sessionId,
        hostId: managed.handle.hostId,
        unusedFreshSession: managed.unusedFreshSession === true,
        summary: this.catalogSummary(managed.summary),
        ...(managed.request ? { request: this.catalogRequest(managed.request) } : {}),
        ...(managed.nativeCapture ? {
          nativeCapture: {
            baselineIds: [...managed.nativeCapture.baselineIds],
            startedAt: managed.nativeCapture.startedAt,
          },
        } : {}),
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined)
    }
    this.emit({
      type: 'sessions-changed',
      sessionId,
      session: managed ? this.copySessionSummary(managed.summary) : null,
      approvals: managed
        ? managed.approvalRequests.map((request) => this.copyApprovalRequest(request))
        : [],
    })
  }

  private copySessionSummary(summary: SessionSummary): SessionSummary {
    return {
      ...summary,
      ...(summary.unattended ? { unattended: { ...summary.unattended, ...(summary.unattended.endWords ? { endWords: [...summary.unattended.endWords] } : {}) } } : {}),
      ...(summary.agentConfig ? { agentConfig: { ...summary.agentConfig, extraArgs: [...summary.agentConfig.extraArgs] } } : {}),
    }
  }

  private copyApprovalRequest(request: ApprovalRequest): ApprovalRequest {
    return {
      ...request,
      ...approvalInputIssueFields(request.inputIssue),
      ...(request.targetPaths ? { targetPaths: [...request.targetPaths] } : {}),
      ...(request.llmReview ? {
        llmReview: {
          ...request.llmReview,
          reasons: [...request.llmReview.reasons],
          hazards: [...request.llmReview.hazards],
          assumptions: [...request.llmReview.assumptions],
        },
      } : {}),
    }
  }

  private catalogSummary(summary: SessionSummary): SessionSummary {
    const {
      webUrl: _webUrl,
      pendingApprovalCommand: _pendingApprovalCommand,
      approvalReason: _approvalReason,
      approvalToolName: _approvalToolName,
      approvalFilePath: _approvalFilePath,
      approvalTargetPaths: _approvalTargetPaths,
      approvalInputSummary: _approvalInputSummary,
      pendingApprovalCount: _pendingApprovalCount,
      approvalSuggestion: _approvalSuggestion,
      ...safe
    } = summary
    return { ...safe, approvalMode: this.approvalMode({ summary } as ManagedSession) === 'unattended' ? 'manual' : this.approvalMode({ summary } as ManagedSession), ...(safe.unattended ? { unattended: { ...safe.unattended, enabled: false, reason: 'Manager 重启后需手动开启无监管' } } : {}) }
  }

  private catalogRequest(request: StartSessionRequest): StartSessionRequest {
    const safe: StartSessionRequest = {
      displayName: request.displayName,
      agentKind: request.agentKind,
      workspace: request.workspace,
      executable: request.executable,
      args: [...request.args],
      cols: request.cols,
      rows: request.rows,
      ...(request.maxContinueRetries === undefined ? {} : { maxContinueRetries: request.maxContinueRetries }),
      ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
      ...(request.recovery ? { recovery: { ...request.recovery, args: [...request.recovery.args] } } : {}),
    }
    if (request.agentConfig && 'hasApiKey' in request.agentConfig) {
      safe.agentConfig = { ...request.agentConfig, extraArgs: [...request.agentConfig.extraArgs] }
    }
    if (request.agentProxy && 'hasPassword' in request.agentProxy) safe.agentProxy = { ...request.agentProxy }
    return safe
  }

  private detachedHandle(hostId: string): HostHandle {
    const unavailable = (): never => { throw new Error('Agent 已停止，请先重新启动') }
    return {
      hostId,
      nextEvent: () => Promise.reject(new Error('Agent 已停止')),
      ping: () => Promise.reject(new Error('Agent 已停止')),
      write: unavailable,
      resize: () => undefined,
      replay: () => Promise.resolve(''),
      respondToPermission: unavailable,
      stop: () => Promise.resolve(),
      preserveOnDisconnect: () => Promise.resolve(),
      updateManagerLeasePolicy: () => undefined,
      disconnect: () => undefined,
    }
  }
}
