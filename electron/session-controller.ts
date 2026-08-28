import { randomUUID } from 'node:crypto'

import type { HostHandle, HostMetadataUpdate, HostRecord, SessionHostManager, StartHostOptions } from './session-host-manager'
import type { HostEvent, HostExitFact } from '../src/shared/protocol'
import type { AgentConfigSummary, AgentKind, AgentProxySummary, ApprovalRequest, BulkApprovalResult, LlmReviewConclusion, LlmReviewLevel, ManagerEvent, NativeSessionSummary, SessionSummary, StartSessionRequest } from '../src/shared/manager-api'
import { reduceSession } from '../src/shared/session-state'
import { createAgentAdapter, extractApprovalCommand, type AgentAdapter, type AgentObservation } from './agent-adapters'
import { canBulkApproveCommand, canFullAutoApprove, type ApprovalDecision } from './approval-policy'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import { terminalScrollbackArgs } from './start-request-policy'
import type { StoredManagedSession } from './managed-session-catalog'
import { shouldReviewApproval } from './llm-security-reviewer'

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
  getSettings(): { enabled: boolean; quietSeconds: number; keywords: string[] }
  match(value: string): string | undefined
  matchIncremental?(previous: string, current: string): string | undefined
  maxKeywordLength(): number
}

export interface RecoveryActivityPort {
  keywordMatched(sessionId: string, keyword: string): void
  keywordContinued(sessionId: string, keyword: string): void
}

export interface FullAutoActivityPort {
  pending?(request: ApprovalRequest): void
  approved(request: ApprovalRequest): void
  blocked(request: ApprovalRequest, reason: string): void
  reviewStarted?(request: ApprovalRequest): void
  reviewed?(request: ApprovalRequest, conclusion: LlmReviewConclusion): void
  reviewFailed?(request: ApprovalRequest, error: string): void
}

export interface LlmApprovalReviewPort {
  getSettings(): { enabled: boolean; level: LlmReviewLevel }
  reviewApproval(request: ApprovalRequest, hardBlockedReason?: string): Promise<LlmReviewConclusion>
}

interface NativeSessionCapture {
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
  summary: SessionSummary
  request?: StartSessionRequest
  handle: HostHandle
  generation: number
  recoveryToken: number
  hostHealthFailures: number
  pendingUserInterrupt: boolean
  hostTransitioning: boolean
  pendingHostInput: string
  awaitingRecoveryReady: boolean
  agentReady: boolean
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
  continueKeywordSuppressedUntil?: number
  continueKeywordAttempted: Set<string>
  pendingKeywordContinue?: {
    timer: ReturnType<typeof setTimeout>
    generation: number
    keyword: string
    outputSequence: number
  }
}

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
  & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'filePath' | 'targetPaths' | 'dangerRuleId'>>

function sameApprovalReviewSubject(
  left: ApprovalReviewSubject,
  right: ApprovalReviewSubject,
): boolean {
  return left.risk === right.risk
    && left.toolName === right.toolName
    && left.command === right.command
    && left.inputSummary === right.inputSummary
    && left.filePath === right.filePath
    && left.dangerRuleId === right.dangerRuleId
    && JSON.stringify(left.targetPaths ?? []) === JSON.stringify(right.targetPaths ?? [])
}

function isTerminalProtocolResponse(data: string): boolean {
  // A user arrow key is ESC [ C/D. Require at least one parameter for the
  // device-attribute responses ending in c so ESC [ C is never swallowed.
  return /^(?:(?:\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]+c|\x1b\[>[\d;]+c|\x1b\[\?[\d;]+u)|(?:\x1b\](?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}(?:\x07|\x1b\\)))+$/i.test(data)
}

export class SessionController {
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

  listPendingApprovals(): ApprovalRequest[] {
    return [...this.sessions.values()]
      .flatMap(({ approvalRequests }) => approvalRequests.map((request) => this.copyApprovalRequest(request)))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  terminalReplay(sessionId: string): { data: string; sequence: number } {
    const managed = this.required(sessionId)
    return { data: managed.terminalReplay.snapshot(), sequence: managed.outputSequence }
  }

  isSessionReady(sessionId: string): boolean {
    return this.required(sessionId).agentReady
  }

  async startSession(request: StartSessionRequest): Promise<SessionSummary> {
    const adapter = createAgentAdapter(request.agentKind)
    const nativeCapture = !request.nativeSessionId && adapter.supportsNativeSessions
      ? await this.prepareNativeCapture(request.agentKind, request.workspace)
      : undefined
    const sessionId = randomUUID()
    const handle = await this.manager.start(this.hostOptions(request, sessionId))
    const managed: ManagedSession = {
      summary: {
        sessionId,
        displayName: request.displayName,
        agentKind: request.agentKind,
        workspace: request.workspace,
        status: 'running',
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
    if (!preserveWorkspaceOnCrash) {
      const preservedSessionIds = new Set(liveRecords.filter((record) => record.managerOwnership === 'preserved').map((record) => record.sessionId ?? record.hostId))
      for (const entry of storedEntries) {
        if (!preservedSessionIds.has(entry.sessionId)) await this.catalog?.remove(entry.sessionId)
      }
    }
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
            recoveryAttempts: 0,
            userStopRequested: false,
            ...(replayObservation.webUrl ? { webUrl: replayObservation.webUrl } : {}),
            ...(record.nativeSessionId ?? stored?.summary.nativeSessionId
              ? { nativeSessionId: record.nativeSessionId ?? stored!.summary.nativeSessionId }
              : {}),
          ...(record.agentConfig ? { agentConfig: { ...record.agentConfig, extraArgs: [...record.agentConfig.extraArgs] } } : {}),
          ...(record.agentProxy ? { agentProxy: { ...record.agentProxy } } : {}),
            ...(record.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
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
    if (isTerminalStatus(managed.summary.status)) throw new Error('Agent 已结束，请先重新启动')
    let handledClaudeHookApproval = false
    if (data.length > 0) {
      this.cancelKeywordContinue(managed)
      this.cancelPendingTerminalAutoApproval(managed)
      if (managed.summary.agentKind === 'claude') {
        this.cancelClaudeTerminalApproval(managed)
        managed.claudeTerminalFallbackBlockedUntil = 0
      } else if (managed.summary.agentKind === 'codex') {
        this.cancelCodexTerminalApproval(managed)
      }
      if (!isTerminalProtocolResponse(data)) managed.continueKeywordAttempted.clear()
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
        managed.adapter.acknowledgeUserInput(true)
        if (hookApproval.source === 'claude-hook') {
          managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
          this.respondToClaudeHook(managed, hookApproval.requestId, 'allow')
        } else {
          managed.handle.respondToPermission(hookApproval.requestId, 'allow')
        }
        this.completeManualApproval(managed, hookApproval)
        handledClaudeHookApproval = true
      } else if (terminalApproval && /[\r\n]/.test(data)) {
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
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const managed = this.required(sessionId)
    if (isTerminalStatus(managed.summary.status)) return
    this.cancelKeywordContinue(managed)
    managed.continueKeywordTail = ''
    managed.continueKeywordSuppressedUntil = Date.now() + 1_000
    managed.handle.resize(cols, rows)
  }

  approveSession(sessionId: string): void {
    const managed = this.required(sessionId)
    const request = managed.approvalRequests[0]
    if (!request) throw new Error('当前 Agent 没有等待处理的授权请求')
    this.approveRequest(request.requestId)
  }

  approveRequest(requestId: string, recordManualApproval = true): void {
    const { managed, request } = this.requiredApproval(requestId)
    if (request.source !== 'terminal') {
      this.cancelClaudeTerminalApproval(managed)
      managed.adapter.acknowledgeUserInput(true)
      if (request.source === 'claude-hook') {
        managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
        this.respondToClaudeHook(managed, request.requestId, 'allow')
      } else {
        managed.handle.respondToPermission(request.requestId, 'allow')
      }
    } else {
      managed.adapter.acknowledgeUserInput(true)
      managed.handle.write(managed.adapter.approvalInput())
    }
    this.completeApproval(managed, request, recordManualApproval)
  }

  async approveAndRememberRequest(requestId: string): Promise<void> {
    const { request } = this.requiredApproval(requestId)
    if (!request.command) throw new Error('Agent 没有提供完整命令或工具名称，无法记为安全命令')
    if (request.risk === 'write' || request.risk === 'delete') {
      throw new Error('写入和删除操作不能记为安全命令，仍需逐次确认')
    }
    if (!this.approvalPolicy) throw new Error('批准规则尚未加载，请稍后重试')
    await this.approvalPolicy.addRule(request.command)
    this.approveRequest(requestId)
  }

  rejectRequest(requestId: string): void {
    const { managed, request } = this.requiredApproval(requestId)
    if (request.source !== 'terminal') {
      this.cancelClaudeTerminalApproval(managed)
      managed.adapter.acknowledgeUserInput(true)
      if (request.source === 'claude-hook') {
        managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
        this.respondToClaudeHook(managed, request.requestId, 'deny')
      } else {
        managed.handle.respondToPermission(request.requestId, 'deny')
      }
    } else {
      managed.adapter.acknowledgeUserInput(true)
      managed.handle.write(managed.adapter.rejectionInput())
    }
    this.removeApproval(managed, request.requestId)
    this.syncApprovalSummary(managed)
    this.changed(managed.summary.sessionId)
  }

  approveAllPending(): BulkApprovalResult {
    const result: BulkApprovalResult = { approved: 0, skipped: 0, failed: 0, skippedRequestIds: [] }
    for (const request of this.listPendingApprovals()) {
      if (!(this.approvalPolicy?.canBulkApproveCommand?.(request.command) ?? canBulkApproveCommand(request.command))) {
        result.skipped += 1
        result.skippedRequestIds.push(request.requestId)
        continue
      }
      try {
        this.approveRequest(request.requestId)
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
    if (isTerminalStatus(managed.summary.status)) return
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
      await this.manager.updateMetadata(managed.handle.hostId, { agentConfig: normalized.enabled ? normalized : null })
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

  async setFullAutoMode(sessionId: string, enabled: boolean): Promise<void> {
    const managed = this.required(sessionId)
    if (!isTerminalStatus(managed.summary.status)) {
      await this.manager.updateMetadata(managed.handle.hostId, { fullAutoEnabled: enabled })
    }
    managed.summary = { ...managed.summary, fullAutoEnabled: enabled }
    if (enabled) {
      for (const request of [...managed.approvalRequests]) {
        const result = this.approvalPolicy?.canFullAutoApprove?.(request) ?? canFullAutoApprove(request)
        if (this.shouldReviewWithLlm(request)) {
          this.scheduleLlmReview(managed, request, result)
        } else if (result.allowed) {
          this.approveRequest(request.requestId, false)
          this.fullAutoActivity?.approved(request)
        } else {
          this.fullAutoActivity?.blocked(request, result.reason)
        }
      }
    }
    this.changed(sessionId)
  }

  async stopAllSessions(): Promise<number> {
    const active = [...this.sessions.values()]
      .filter((managed) => !isTerminalStatus(managed.summary.status))
      .map((managed) => managed.summary.sessionId)
    await Promise.all(active.map((sessionId) => this.stopSession(sessionId)))
    return active.length
  }

  async preserveAllSessions(): Promise<number> {
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

  async restartSession(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    if (!isTerminalStatus(managed.summary.status)) throw new Error('Agent 仍在运行，无需重新启动')
    const request = managed.request
    if (!request) throw new Error('缺少该 Agent 的启动信息，无法重新启动')
    if (!managed.summary.nativeSessionId && managed.adapter.supportsNativeSessions && managed.nativeCapture) {
      await this.tryCaptureNativeSession(managed)
    }
    if (!managed.summary.nativeSessionId && managed.adapter.supportsNativeSessions) {
      throw new Error('该窗口尚未绑定原生会话，已阻止启动新 Agent。请在“新增 Agent”中选择对应历史会话进行恢复。')
    }

    const oldHostId = managed.handle.hostId
    const recipe = request.recovery
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
      ...(managed.summary.agentConfig?.enabled ? { agentConfig: { ...managed.summary.agentConfig, extraArgs: [...managed.summary.agentConfig.extraArgs] } } : {}),
      ...(managed.summary.agentProxy?.enabled ? { agentProxy: { ...managed.summary.agentProxy } } : {}),
      ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
      ...(managed.summary.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
      recovery: scrollableRecipe,
    } : this.hostOptions(request)
    if (managed.summary.fullAutoEnabled) options.fullAutoEnabled = true

    managed.recoveryToken += 1
    this.cancelTransientRetry(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelKeywordContinue(managed)
    managed.generation += 1
    managed.hostTransitioning = true
    managed.pendingHostInput = ''
    managed.handle.disconnect()
    managed.pendingUserInterrupt = false
    managed.awaitingRecoveryReady = false
    managed.agentReady = false
    managed.suppressTransientRetryUntilReady = Boolean(managed.summary.nativeSessionId)
    managed.adapter.resetForRecovery()
    delete managed.lastTerminalAutoApproval
    if (managed.nativeCapture?.timer) clearTimeout(managed.nativeCapture.timer)
    delete managed.nativeCapture
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
      recoveryAttempts: 0,
      userStopRequested: false,
    }
    delete managed.pendingApprovalCommand
    managed.approvalRequests.length = 0
    this.clearClaudeHookState(managed)
    this.changed(sessionId)

    try {
      await this.releaseHostBeforeRestart(oldHostId)
      options.sessionId = sessionId
      const handle = await this.manager.start(options)
      managed.handle = handle
      managed.hostTransitioning = false
      managed.terminalReplay.clear()
      managed.outputSequence = 0
      managed.summary = { ...managed.summary, status: 'running' }
      this.flushPendingHostInput(managed)
      await this.manager.removeArtifacts(oldHostId).catch(() => undefined)
      this.changed(sessionId)
      void this.pump(managed, managed.generation)
    } catch (error) {
      managed.hostTransitioning = false
      managed.pendingHostInput = ''
      managed.summary = {
        ...managed.summary,
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      }
      this.changed(sessionId)
      throw error
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
        this.observePendingTerminalAutoApproval(managed, observation)
        if (observation.ready) delete managed.lastTerminalAutoApproval
        if (observation.webUrl && managed.summary.webUrl !== observation.webUrl) {
          managed.summary = { ...managed.summary, webUrl: observation.webUrl }
          this.changed(managed.summary.sessionId)
        }
        if (observation.ready || observation.approvalRequired) managed.agentReady = true
        this.observeContinueKeyword(managed, event.data, observation)
        if (observation.approvalRequired) {
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
        managed.agentReady = true
        this.cancelClaudeTerminalApproval(managed)
        this.cancelCodexTerminalApproval(managed)
        this.removeTerminalApprovals(managed)
        managed.adapter.acknowledgeUserInput(true)
        const hookSource = event.hookSource ?? (managed.summary.agentKind === 'codex' ? 'codex' : 'claude')
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
        const fullAutoInput = {
          command: approvalCommand,
          risk: approvalRisk,
          toolName,
          workspace: managed.summary.workspace,
          ...(event.filePath ? { filePath: event.filePath } : {}),
          ...(event.targetPaths?.length ? { targetPaths: [...event.targetPaths] } : {}),
        }
        const fullAuto = managed.summary.fullAutoEnabled
          ? this.approvalPolicy?.canFullAutoApprove?.(fullAutoInput) ?? canFullAutoApprove(fullAutoInput)
          : undefined
        const llmReviewRequired = decision?.action !== 'auto-approve' && this.shouldReviewWithLlm({
          risk: approvalRisk,
          ...(decision?.matchedDangerRule ? { dangerRuleId: decision.matchedDangerRule.id } : {}),
        })
        if (decision?.action === 'auto-approve' || fullAuto?.allowed && !llmReviewRequired) {
          if (approvalSource === 'claude-hook') {
            managed.claudeTerminalFallbackBlockedUntil = Date.now() + CLAUDE_TERMINAL_REDRAW_GUARD_MS
            this.respondToClaudeHook(managed, event.requestId, 'allow')
          } else {
            managed.handle.respondToPermission(event.requestId, 'allow')
          }
          if (fullAuto?.allowed && decision?.action !== 'auto-approve') {
            this.fullAutoActivity?.approved(this.approvalForActivity(managed, {
              requestId: event.requestId, source: approvalSource, risk: approvalRisk,
              reason: event.reason ?? fullAuto.reason, toolName, command: approvalCommand,
              ...(event.filePath ? { filePath: event.filePath } : {}),
              ...(event.targetPaths?.length ? { targetPaths: [...event.targetPaths] } : {}),
              ...(event.toolInputSummary ? { inputSummary: event.toolInputSummary } : {}),
              ...(event.reason ? { agentReason: event.reason } : {}),
              ...(event.turnId ? { nativeTurnId: event.turnId } : {}),
              ...(event.cwd ? { hookCwd: event.cwd } : {}),
              ...(event.model ? { hookModel: event.model } : {}),
              ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
              ...(event.transcriptPath ? { transcriptPath: event.transcriptPath } : {}),
              ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
              ...(event.rawPayload !== undefined ? { rawPayload: event.rawPayload } : {}),
            }))
          }
          this.syncApprovalSummary(managed)
        } else {
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
          if (managed.summary.fullAutoEnabled && fullAuto) {
            if (llmReviewRequired) this.scheduleLlmReview(managed, queued, fullAuto)
            else if (!fullAuto.allowed) this.fullAutoActivity?.blocked(queued, fullAuto.reason)
          }
        }
        this.changed(managed.summary.sessionId)
      } else if (event.type === 'exit') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
        await this.onExit(managed, generation, event.exitCode)
        return
      } else if (event.type === 'error') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
        managed.summary = { ...managed.summary, lastError: event.message }
        this.changed(managed.summary.sessionId)
      } else if (event.type !== 'permission-response' && event.type !== 'replay') {
        this.emit({ sessionId: managed.summary.sessionId, ...event })
      }
    }
  }

  private async onExit(managed: ManagedSession, generation: number, exitCode: number): Promise<void> {
    if (managed.generation !== generation) return
    const transientRetryPending = this.cancelTransientRetry(managed)
    this.cancelKeywordContinue(managed)
    this.cancelPendingContinueSubmit(managed)
    this.cancelClaudeTerminalApproval(managed)
    this.cancelCodexTerminalApproval(managed)
    managed.approvalRequests.length = 0
    this.clearClaudeHookState(managed)
    this.syncApprovalSummary(managed)
    managed.handle.disconnect()
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
    if (!managed.request?.recovery) {
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
      const handle = await this.manager.start({
        sessionId: managed.summary.sessionId,
        agentKind: managed.summary.agentKind,
        executable: scrollableRecipe.executable,
        args: scrollableRecipe.args,
        cwd: managed.summary.workspace,
        cols: managed.request?.cols ?? 80,
        rows: managed.request?.rows ?? 24,
        maxContinueRetries: managed.request?.maxContinueRetries,
        ...(managed.summary.agentConfig?.enabled ? { agentConfig: { ...managed.summary.agentConfig, extraArgs: [...managed.summary.agentConfig.extraArgs] } } : {}),
        ...(managed.summary.agentProxy?.enabled ? { agentProxy: { ...managed.summary.agentProxy } } : {}),
        ...(managed.summary.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
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
  }

  private requestRecovery(managed: ManagedSession, reason: string, action: 'continue' | 'resume'): void {
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
    this.cancelPendingContinueSubmit(managed)
    const input = (managed.request?.recovery?.continueInput ?? 'continue').replace(/[\r\n]+$/g, '') || 'continue'
    if (managed.pendingUserInterrupt || managed.summary.userStopRequested || isTerminalStatus(managed.summary.status)) return
    // Keep text and Enter in one PTY write. Splitting them could leave a visible
    // but unsubmitted "continue" when state changed during the old 75 ms gap.
    managed.handle.write(`${input}\r`)
  }

  private observeContinueKeyword(managed: ManagedSession, data: string, observation: AgentObservation): void {
    const policy = this.continueKeywordPolicy
    const settings = policy?.getSettings()
    const continueSuppressed = (managed.continueKeywordSuppressedUntil ?? 0) > Date.now()
    if (!policy || !settings?.enabled || settings.keywords.length === 0
      || continueSuppressed
      || managed.pendingUserInterrupt || managed.summary.userStopRequested
      || managed.summary.status !== 'running' || observation.approvalRequired
      || managed.awaitingRecoveryReady) {
      this.cancelKeywordContinue(managed)
      managed.continueKeywordTail = ''
      return
    }
    delete managed.continueKeywordSuppressedUntil
    const maximum = Math.max(256, policy.maxKeywordLength() * 2)
    const previousTail = managed.continueKeywordTail
    managed.continueKeywordTail = (previousTail + data).slice(-maximum)
    const matchedKeyword = policy.matchIncremental
      ? policy.matchIncremental(previousTail, data)
      : policy.match(data)
    if (!matchedKeyword) {
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
      if (managed.generation !== generation || managed.outputSequence !== outputSequence
        || managed.pendingUserInterrupt || managed.summary.userStopRequested
        || managed.summary.status !== 'running' || managed.awaitingRecoveryReady
        || managed.approvalRequests.length > 0 || isTerminalStatus(managed.summary.status)) return
      managed.continueKeywordAttempted.add(keyword)
      managed.adapter.acknowledgeUserInput()
      this.recoveryActivity?.keywordContinued(managed.summary.sessionId, keyword)
      this.submitContinue(managed)
    }, settings.quietSeconds * 1_000)
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
      ...(request.agentConfig && 'hasApiKey' in request.agentConfig && request.agentConfig.enabled
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

  private async tryCaptureNativeSession(managed: ManagedSession): Promise<void> {
    const capture = managed.nativeCapture
    const discovery = this.discovery
    if (!capture || !discovery || capture.inFlight || managed.summary.nativeSessionId) return
    capture.inFlight = true
    capture.attempts += 1
    try {
      const sessions = await discovery.discover(managed.summary.agentKind, managed.summary.workspace)
      const claimed = new Set([...this.sessions.values()]
        .map((session) => session.summary.nativeSessionId)
        .filter((id): id is string => Boolean(id)))
      const candidates = sessions.filter((session) => !capture.baselineIds.has(session.id)
        && !claimed.has(session.id) && !this.nativeCaptureReservations.has(session.id)
        && session.updatedAt >= capture.startedAt - 5_000
        && session.updatedAt <= capture.startedAt + 5 * 60_000)
        .sort((left, right) => Math.abs(left.updatedAt - capture.startedAt) - Math.abs(right.updatedAt - capture.startedAt)
          || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      const candidate = candidates[0]
      if (!candidate) return
      const nativeSessionId = candidate.id
      const request = managed.request
      if (!request) return
      const recovery = managed.adapter.recoveryRecipe(request.executable, nativeSessionId)
      if (!recovery) return
      this.nativeCaptureReservations.add(nativeSessionId)
      try {
        await this.manager.updateMetadata(managed.handle.hostId, { nativeSessionId, recovery })
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
      if (managed.nativeCapture === capture) this.scheduleNativeCapture(managed)
    }
  }

  private scheduleClaudeTerminalApproval(managed: ManagedSession, observation: AgentObservation, eventData: string): void {
    // Claude local-agent mailbox approvals are rendered directly by the leader TUI
    // and bypass command PermissionRequest hooks. Fall back only for that explicit
    // prompt; all other Hook-enabled Claude output remains structure-only.
    if (managed.handle.permissionHook === 'claude' && !observation.forwardedSubagentApproval) return
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
    if (managed.approvalRequests.some((request) => request.source === 'codex-hook')) return
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
          || managed.approvalRequests.some((request) => request.source === 'codex-hook')) return
        this.handleTerminalApproval(managed, scheduled.observation, scheduled.eventData)
      }, CODEX_TERMINAL_APPROVAL_FALLBACK_MS),
    }
    scheduled.timer.unref?.()
    managed.pendingCodexTerminalApproval = scheduled
  }

  private cancelCodexTerminalApproval(managed: ManagedSession): void {
    if (!managed.pendingCodexTerminalApproval) return
    clearTimeout(managed.pendingCodexTerminalApproval.timer)
    delete managed.pendingCodexTerminalApproval
  }

  private removeTerminalApprovals(managed: ManagedSession): void {
    const remaining = managed.approvalRequests.filter((request) => request.source !== 'terminal')
    if (remaining.length === managed.approvalRequests.length) return
    managed.approvalRequests = remaining
    this.syncApprovalSummary(managed)
  }

  private handleTerminalApproval(managed: ManagedSession, observation: AgentObservation, eventData: string): void {
    if (observation.approvalRequired && managed.summary.status !== 'needs_approval') {
      const approvalCommand = observation.approvalCommand ?? extractApprovalCommand(eventData)
      const decision = this.approvalPolicy?.decide(approvalCommand)
      const fullAuto = managed.summary.fullAutoEnabled
        ? this.approvalPolicy?.canFullAutoApprove?.({ command: approvalCommand, risk: decision?.risk ?? 'unknown', workspace: managed.summary.workspace })
          ?? canFullAutoApprove({ command: approvalCommand, risk: decision?.risk ?? 'unknown', workspace: managed.summary.workspace })
        : undefined
      const llmReviewRequired = decision?.action !== 'auto-approve' && this.shouldReviewWithLlm({
        risk: decision?.risk ?? 'unknown',
        ...(decision?.matchedDangerRule ? { dangerRuleId: decision.matchedDangerRule.id } : {}),
      })
      if (decision?.action === 'auto-approve' || fullAuto?.allowed && !llmReviewRequired) {
        const duplicate = this.isDuplicateTerminalAutoApproval(managed, approvalCommand)
        const activityRequest = !duplicate && fullAuto?.allowed && decision?.action !== 'auto-approve'
          ? this.approvalForActivity(managed, {
            requestId: 'terminal:auto-' + randomUUID(), source: 'terminal',
            risk: decision?.risk ?? 'unknown', reason: observation.approvalReason ?? fullAuto.reason,
            ...(approvalCommand ? { command: approvalCommand } : {}),
            ...(observation.approvalReason ? { agentReason: observation.approvalReason } : {}),
          })
          : undefined
        managed.adapter.acknowledgeUserInput(true)
        if (!duplicate) {
          try {
            managed.handle.write(managed.adapter.approvalInput())
          } catch {
            // Keep the request queued when the host rejects input.
            this.queueApproval(managed, {
              requestId: 'terminal:' + randomUUID(), source: 'terminal',
              risk: decision?.risk ?? 'unknown',
              reason: observation.approvalReason ?? fullAuto?.reason ?? '终端未确认自动批准，请人工确认',
              ...(approvalCommand ? { command: approvalCommand } : {}),
            })
            this.changed(managed.summary.sessionId)
            return
          }
          this.removeTerminalApproval(managed, approvalCommand)
          // Record only after the write was accepted by the live host socket.
          if (activityRequest) this.fullAutoActivity?.approved(activityRequest)
          this.schedulePendingTerminalAutoApproval(managed, approvalCommand)
        }
        managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
        this.emit({ type: 'terminal-refresh-requested', sessionId: managed.summary.sessionId })
      } else {
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
        if (managed.summary.fullAutoEnabled && fullAuto) {
          if (llmReviewRequired) this.scheduleLlmReview(managed, queued, fullAuto)
          else if (!fullAuto.allowed) this.fullAutoActivity?.blocked(queued, fullAuto.reason)
        }
      }
      this.changed(managed.summary.sessionId)
    }
    if (observation.approvalRequired && managed.summary.status === 'needs_approval') {
      const approvalCommand = observation.approvalCommand ?? extractApprovalCommand(eventData)
      if (approvalCommand && approvalCommand !== managed.pendingApprovalCommand) {
        const decision = this.approvalPolicy?.decide(approvalCommand)
        const fullAuto = managed.summary.fullAutoEnabled
          ? this.approvalPolicy?.canFullAutoApprove?.({ command: approvalCommand, risk: decision?.risk ?? 'unknown', workspace: managed.summary.workspace })
            ?? canFullAutoApprove({ command: approvalCommand, risk: decision?.risk ?? 'unknown', workspace: managed.summary.workspace })
          : undefined
        const llmReviewRequired = decision?.action !== 'auto-approve' && this.shouldReviewWithLlm({
          risk: decision?.risk ?? 'unknown',
          ...(decision?.matchedDangerRule ? { dangerRuleId: decision.matchedDangerRule.id } : {}),
        })
        if (decision?.action === 'auto-approve' || fullAuto?.allowed && !llmReviewRequired) {
          const duplicate = this.isDuplicateTerminalAutoApproval(managed, approvalCommand)
          const activityRequest = !duplicate && fullAuto?.allowed && decision?.action !== 'auto-approve'
            ? this.approvalForActivity(managed, {
              requestId: 'terminal:auto-' + randomUUID(), source: 'terminal',
              risk: decision?.risk ?? 'unknown', reason: observation.approvalReason ?? fullAuto.reason,
              command: approvalCommand,
              ...(observation.approvalReason ? { agentReason: observation.approvalReason } : {}),
            })
            : undefined
          managed.adapter.acknowledgeUserInput(true)
          if (!duplicate) {
            try {
              managed.handle.write(managed.adapter.approvalInput())
            } catch {
              // Keep the request queued when the host rejects input.
              this.queueApproval(managed, {
                requestId: 'terminal:' + randomUUID(), source: 'terminal',
                risk: decision?.risk ?? 'unknown',
                reason: observation.approvalReason ?? fullAuto?.reason ?? '终端未确认自动批准，请人工确认',
                ...(approvalCommand ? { command: approvalCommand } : {}),
              })
              this.changed(managed.summary.sessionId)
              return
            }
            this.removeTerminalApproval(managed, approvalCommand)
            // Record only after the write was accepted by the live host socket.
            if (activityRequest) this.fullAutoActivity?.approved(activityRequest)
            this.schedulePendingTerminalAutoApproval(managed, approvalCommand)
          }
          this.emit({ type: 'terminal-refresh-requested', sessionId: managed.summary.sessionId })
        } else {
          const queued = this.queueApproval(managed, {
            requestId: 'terminal:' + randomUUID(), source: 'terminal',
            risk: decision?.risk ?? 'unknown',
            reason: decision?.matchedDangerRule
              ? decision.reason
              : observation.approvalReason ?? decision?.reason ?? managed.summary.approvalReason ?? '未能识别授权请求的具体影响，需要人工确认',
            command: approvalCommand,
            ...(decision?.matchedDangerRule ? {
              dangerRuleId: decision.matchedDangerRule.id,
              dangerRuleName: decision.matchedDangerRule.name,
            } : {}),
          })
          if (managed.summary.fullAutoEnabled && fullAuto) {
            if (llmReviewRequired) this.scheduleLlmReview(managed, queued, fullAuto)
            else if (!fullAuto.allowed) this.fullAutoActivity?.blocked(queued, fullAuto.reason)
          }
        }
        this.changed(managed.summary.sessionId)
      }
    }
  }

  private schedulePendingTerminalAutoApproval(managed: ManagedSession, command: string | undefined): void {
    // The bounded confirmation retry exists only for Codex OSC notifications,
    // which can arrive before its raw prompt starts reading. Claude dialogs are
    // already interactive when painted; a second Enter can leak into the next UI.
    if (managed.summary.agentKind !== 'codex' || !command) return
    this.cancelPendingTerminalAutoApproval(managed)
    const generation = managed.generation
    const pending: ManagedSession['pendingTerminalAutoApproval'] = {
      command,
      generation,
      timer: setTimeout(() => {
        if (managed.pendingTerminalAutoApproval !== pending) return
        delete managed.pendingTerminalAutoApproval
        if (managed.generation !== generation || isTerminalStatus(managed.summary.status)
          || managed.summary.userStopRequested) return
        // A Codex OSC notification can arrive just before the raw-input prompt
        // starts reading. One bounded retry avoids relying on a later resize.
        try { managed.handle.write(managed.adapter.approvalInput()) } catch { /* host pump reports connection failures */ }
      }, TERMINAL_AUTO_APPROVAL_CONFIRM_MS),
    }
    pending.timer.unref?.()
    managed.pendingTerminalAutoApproval = pending
  }

  private observePendingTerminalAutoApproval(managed: ManagedSession, observation: AgentObservation): void {
    const pending = managed.pendingTerminalAutoApproval
    if (!pending) return
    if (observation.ready
      || (observation.approvalRequired && observation.approvalCommand !== undefined
        && observation.approvalCommand !== pending.command)) {
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
  ): void {
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
      managed.handle.respondToPermission(responseId, action)
      const identity = identities?.get(responseId)
      if (action === 'allow' && identity) this.rememberApprovedClaudeHook(managed, identity, approvedAt)
      identities?.delete(responseId)
      aliases?.delete(responseId)
    }
    aliases?.delete(requestId)
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
      & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'filePath' | 'targetPaths' | 'agentReason' | 'dangerRuleId' | 'dangerRuleName' | 'nativeTurnId' | 'hookCwd' | 'hookModel' | 'permissionMode' | 'transcriptPath' | 'toolInput' | 'rawPayload'>>,
  ): ApprovalRequest {
    const terminalIndex = input.source === 'terminal'
      ? this.findTerminalApprovalToUpdate(managed, input.command)
      : -1
    const requestIndex = terminalIndex >= 0
      ? terminalIndex
      : managed.approvalRequests.findIndex((request) => request.requestId === input.requestId)
    const previous = requestIndex >= 0 ? managed.approvalRequests[requestIndex] : undefined
    const preserveLlmReview = Boolean(previous && sameApprovalReviewSubject(previous, input))
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
    if (requestIndex < 0 || request.source !== 'terminal') this.fullAutoActivity?.pending?.(request)
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
    managed.approvalRequests.splice(index, 1)
    this.syncApprovalSummary(managed)
  }

  private approvalForActivity(
    managed: ManagedSession,
    input: Pick<ApprovalRequest, 'requestId' | 'source' | 'risk' | 'reason'>
      & Partial<Pick<ApprovalRequest, 'toolName' | 'command' | 'inputSummary' | 'filePath' | 'targetPaths' | 'agentReason' | 'dangerRuleId' | 'dangerRuleName' | 'nativeTurnId' | 'hookCwd' | 'hookModel' | 'permissionMode' | 'transcriptPath' | 'toolInput' | 'rawPayload'>>,
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

  private shouldReviewWithLlm(request: Pick<ApprovalRequest, 'risk' | 'dangerRuleId'>): boolean {
    const settings = this.llmReview?.getSettings()
    return Boolean(settings?.enabled && shouldReviewApproval(settings.level, request))
  }

  private scheduleLlmReview(
    managed: ManagedSession,
    request: ApprovalRequest,
    hardDecision: { allowed: boolean; reason: string },
  ): void {
    if (!this.llmReview || request.llmReviewStatus === 'pending') return
    request.llmReviewStatus = 'pending'
    delete request.llmReview
    delete request.llmReviewError
    const generation = managed.generation
    const reviewSnapshot: ApprovalRequest = {
      ...request,
      ...(request.targetPaths ? { targetPaths: [...request.targetPaths] } : {}),
    }
    this.syncApprovalSummary(managed)
    this.fullAutoActivity?.reviewStarted?.(request)
    this.changed(managed.summary.sessionId)
    void this.llmReview.reviewApproval(reviewSnapshot, hardDecision.allowed ? undefined : hardDecision.reason).then((conclusion) => {
      const current = managed.approvalRequests.find((item) => item.requestId === request.requestId)
      if (!current || managed.generation !== generation || !sameApprovalReviewSubject(current, reviewSnapshot)) return
      current.llmReviewStatus = 'completed'
      current.llmReview = conclusion
      delete current.llmReviewError
      this.fullAutoActivity?.reviewed?.(current, conclusion)
      if (managed.summary.fullAutoEnabled && this.llmReview?.getSettings().enabled && hardDecision.allowed
        && conclusion.verdict === 'allow' && !conclusion.requiresHumanApproval) {
        this.approveRequest(current.requestId, false)
        this.fullAutoActivity?.approved(current)
        return
      }
      this.fullAutoActivity?.blocked(current, hardDecision.allowed ? conclusion.summary : hardDecision.reason)
      this.changed(managed.summary.sessionId)
    }).catch((error) => {
      const current = managed.approvalRequests.find((item) => item.requestId === request.requestId)
      if (!current || managed.generation !== generation || !sameApprovalReviewSubject(current, reviewSnapshot)) return
      const message = error instanceof Error ? error.message : String(error)
      current.llmReviewStatus = 'failed'
      current.llmReviewError = message
      this.fullAutoActivity?.reviewFailed?.(current, message)
      this.fullAutoActivity?.blocked(current, 'LLM 审查失败，已转人工处理')
      this.changed(managed.summary.sessionId)
    })
  }

  private changed(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed && this.catalog) {
      void this.catalog.upsert({
        sessionId,
        hostId: managed.handle.hostId,
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
      ...(summary.agentConfig ? { agentConfig: { ...summary.agentConfig, extraArgs: [...summary.agentConfig.extraArgs] } } : {}),
    }
  }

  private copyApprovalRequest(request: ApprovalRequest): ApprovalRequest {
    return {
      ...request,
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
    return safe
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
