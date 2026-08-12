import type { HostEvent } from './protocol'
import type { SessionState } from './session-state'

export type AgentKind = 'generic' | 'codex' | 'claude' | 'pi'
export type AgentConfigSource = 'local' | 'custom' | 'ccswitch'

export interface AgentConfigInput {
  enabled: boolean
  source: AgentConfigSource
  baseUrl?: string
  apiKey?: string
  clearApiKey?: boolean
  model?: string
  extraArgs?: string[]
  providerId?: string
  providerName?: string
}

export interface AgentConfigSummary {
  enabled: boolean
  source: AgentConfigSource
  profileId?: string
  baseUrl?: string
  model?: string
  extraArgs: string[]
  hasApiKey: boolean
  providerId?: string
  providerName?: string
}

export interface AgentProxyInput {
  enabled: boolean
  protocol?: 'http'
  host: string
  port: number
  username?: string
  password?: string
  clearPassword?: boolean
}

export interface AgentProxySummary {
  enabled: true
  proxyId: string
  protocol: 'http'
  host: string
  port: number
  username?: string
  hasPassword: boolean
}

export interface ContinueKeywordSettings {
  enabled: boolean
  quietSeconds: number
  keywords: string[]
}

export interface CCSwitchProviderSummary {
  id: string
  name: string
  agentKind: 'codex' | 'claude'
  baseUrl?: string
  model?: string
  isCurrent: boolean
  hasApiKey: boolean
  issue?: string
}
export type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'
export type ApprovalSource = 'terminal' | 'claude-hook'

export interface ApprovalRequest {
  requestId: string
  sessionId: string
  displayName: string
  agentKind: AgentKind
  workspace: string
  nativeSessionId?: string
  source: ApprovalSource
  risk: ApprovalRisk
  toolName?: string
  command?: string
  inputSummary?: string
  reason: string
  agentReason?: string
  filePath?: string
  targetPaths?: string[]
  createdAt: number
  canBulkApprove: boolean
}

export interface BulkApprovalResult {
  approved: number
  skipped: number
  failed: number
  skippedRequestIds: string[]
}

export interface NativeSessionSummary {
  id: string
  title: string
  updatedAt: number
  workspace: string
  subtitle?: string
}

export interface RecoveryRecipe {
  executable: string
  args: string[]
  continueInput?: string
}

export interface StartSessionRequest {
  displayName: string
  agentKind: AgentKind
  workspace: string
  executable: string
  args: string[]
  cols: number
  rows: number
  maxContinueRetries?: number
  nativeSessionId?: string
  recovery?: RecoveryRecipe
  agentConfig?: AgentConfigInput | AgentConfigSummary
  agentProxy?: AgentProxyInput | AgentProxySummary
}

export interface ApprovalRuleSuggestion {
  command: string
  approvalCount: number
}

export interface SessionSummary extends SessionState {
  displayName: string
  agentKind: AgentKind
  nativeSessionId?: string
  pendingApprovalCommand?: string
  approvalRisk?: ApprovalRisk
  approvalReason?: string
  approvalToolName?: string
  approvalFilePath?: string
  approvalTargetPaths?: string[]
  approvalInputSummary?: string
  pendingApprovalCount?: number
  approvalSuggestion?: ApprovalRuleSuggestion
  recoveryAction?: 'continue' | 'resume'
  recoveryAttempted?: boolean
  recoveryRuleApplied?: boolean
  agentConfig?: AgentConfigSummary
  agentProxy?: AgentProxySummary
  fullAutoEnabled?: boolean
}

export type AuditLevel = 'info' | 'warning' | 'error'
export type AuditCategory = 'session' | 'approval' | 'recovery' | 'rule'

export interface AuditEntry {
  id: string
  timestamp: number
  level: AuditLevel
  category: AuditCategory
  action: string
  message: string
  sessionId?: string
  details?: Record<string, string | number | boolean>
}

export interface TerminalReplaySnapshot {
  data: string
  sequence: number
}

export type ManagerEvent =
  | ({ sessionId: string; sequence?: number } & HostEvent)
  | { type: 'sessions-changed'; sessionId: string }
  | { type: 'audit-changed' }

export const IPC_CHANNELS = {
  listSessions: 'agent-manager:list-sessions',
  terminalReplay: 'agent-manager:terminal-replay',
  listAuditEntries: 'agent-manager:list-audit-entries',
  startSession: 'agent-manager:start-session',
  write: 'agent-manager:write',
  resize: 'agent-manager:resize',
  stopSession: 'agent-manager:stop-session',
  restartSession: 'agent-manager:restart-session',
  continueSession: 'agent-manager:continue-session',
  tryRecoveryOnce: 'agent-manager:try-recovery-once',
  acceptRecoverySuggestion: 'agent-manager:accept-recovery-suggestion',
  dismissRecoverySuggestion: 'agent-manager:dismiss-recovery-suggestion',
  removeSession: 'agent-manager:remove-session',
  renameSession: 'agent-manager:rename-session',
  updateSessionConfig: 'agent-manager:update-session-config',
  updateSessionProxy: 'agent-manager:update-session-proxy',
  setFullAutoMode: 'agent-manager:set-full-auto-mode',
  listCCSwitchProviders: 'agent-manager:list-ccswitch-providers',
  getContinueKeywordSettings: 'agent-manager:get-continue-keyword-settings',
  updateContinueKeywordSettings: 'agent-manager:update-continue-keyword-settings',
  approveSession: 'agent-manager:approve-session',
  listPendingApprovals: 'agent-manager:list-pending-approvals',
  approveRequest: 'agent-manager:approve-request',
  approveAndRememberRequest: 'agent-manager:approve-and-remember-request',
  rejectRequest: 'agent-manager:reject-request',
  approveAllPending: 'agent-manager:approve-all-pending',
  acceptApprovalSuggestion: 'agent-manager:accept-approval-suggestion',
  dismissApprovalSuggestion: 'agent-manager:dismiss-approval-suggestion',
  listApprovalRules: 'agent-manager:list-approval-rules',
  addApprovalRule: 'agent-manager:add-approval-rule',
  removeApprovalRule: 'agent-manager:remove-approval-rule',
  chooseWorkspace: 'agent-manager:choose-workspace',
  discoverSessions: 'agent-manager:discover-sessions',
  readClipboardText: 'agent-manager:read-clipboard-text',
  writeClipboardText: 'agent-manager:write-clipboard-text',
  event: 'agent-manager:event',
} as const

export interface AgentManagerApi {
  listSessions(): Promise<SessionSummary[]>
  terminalReplay(sessionId: string): Promise<TerminalReplaySnapshot>
  listAuditEntries(): Promise<AuditEntry[]>
  startSession(request: StartSessionRequest): Promise<SessionSummary>
  write(sessionId: string, data: string): Promise<void> | void
  resize(sessionId: string, cols: number, rows: number): Promise<void> | void
  stopSession(sessionId: string): Promise<void>
  restartSession(sessionId: string): Promise<void>
  continueSession(sessionId: string): Promise<void> | void
  tryRecoveryOnce(sessionId: string): Promise<void>
  acceptRecoverySuggestion(sessionId: string): Promise<void>
  dismissRecoverySuggestion(sessionId: string): Promise<void> | void
  removeSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, displayName: string): Promise<void>
  updateSessionConfig(sessionId: string, config: AgentConfigInput): Promise<void>
  updateSessionProxy(sessionId: string, proxy: AgentProxyInput): Promise<void>
  setFullAutoMode(sessionId: string, enabled: boolean): Promise<void>
  listCCSwitchProviders(agentKind: AgentKind): Promise<CCSwitchProviderSummary[]>
  getContinueKeywordSettings(): Promise<ContinueKeywordSettings>
  updateContinueKeywordSettings(settings: ContinueKeywordSettings): Promise<ContinueKeywordSettings>
  approveSession(sessionId: string): Promise<void>
  listPendingApprovals(): Promise<ApprovalRequest[]>
  approveRequest(requestId: string): Promise<void>
  approveAndRememberRequest(requestId: string): Promise<void>
  rejectRequest(requestId: string): Promise<void>
  approveAllPending(): Promise<BulkApprovalResult>
  acceptApprovalSuggestion(sessionId: string): Promise<void>
  dismissApprovalSuggestion(sessionId: string): Promise<void> | void
  listApprovalRules(): Promise<string[]>
  addApprovalRule(command: string): Promise<void>
  removeApprovalRule(command: string): Promise<void>
  chooseWorkspace(): Promise<string | undefined>
  discoverSessions(agentKind: AgentKind, workspace: string): Promise<NativeSessionSummary[]>
  readClipboardText(): Promise<string>
  writeClipboardText(text: string): Promise<void>
  subscribe(listener: (event: ManagerEvent) => void): () => void
}
