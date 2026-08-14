import type { HostEvent } from './protocol'
import type { SessionState } from './session-state'

export type AgentKind = 'generic' | 'codex' | 'claude' | 'pi' | 'deepseek'
export type NpmRegistryChoice = 'configured' | 'official' | 'npmmirror' | 'tencent' | 'huawei'

export interface AgentEnvironmentSummary {
  agentKind: AgentKind
  executable: string
  packageName?: string
  nodeAvailable: boolean
  npmAvailable: boolean
  nodeVersion?: string
  npmVersion?: string
  agentInstalled: boolean
  executableVersion?: string
  ripgrepAvailable?: boolean
  ripgrepVersion?: string
  ripgrepInstallCommand?: string
  installCommand?: string
  nodeInstallCommand?: string
}
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

export interface SessionSafetySettings {
  preserveWorkspaceOnCrash: boolean
}

export interface DingTalkSettingsInput {
  enabled: boolean
  clientId?: string
  clientSecret?: string
  clearClientSecret?: boolean
  allowedWorkspaces: string[]
  commandsPerMinute: number
  agentModeEnabled: boolean
  agentBaseUrl?: string
  agentApiKey?: string
  clearAgentApiKey?: boolean
  agentModel?: string
  agentRetryCount: number
  agentProxyEnabled: boolean
  agentProxyHost?: string
  agentProxyPort?: number
  agentProxyUsername?: string
  agentProxyPassword?: string
  clearAgentProxyPassword?: boolean
}

export interface DingTalkSettingsSummary {
  enabled: boolean
  clientId?: string
  hasClientSecret: boolean
  allowedWorkspaces: string[]
  commandsPerMinute: number
  bindingKey?: string
  boundStaffId?: string
  boundSenderName?: string
  agentModeEnabled: boolean
  agentBaseUrl?: string
  hasAgentApiKey: boolean
  agentModel?: string
  agentRetryCount: number
  agentProxyEnabled: boolean
  agentProxyHost: string
  agentProxyPort: number
  agentProxyUsername?: string
  hasAgentProxyPassword: boolean
  connectionStatus?: 'disabled' | 'connecting' | 'connected' | 'error'
  connectionError?: string
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

export interface ExternalTerminalDragProjection {
  transactionId: string
  phase: 'hovering' | 'dropped'
  terminalTitle: string
  terminalKind: 'windows-terminal' | 'console'
  suggestedAgentKind?: 'codex' | 'claude'
  suggestedWorkspace?: string
  suggestedNativeSessionId?: string
  issue?: string
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
  attentionKind?: 'abnormal-exit' | 'host-unresponsive'
  recoveryAttempted?: boolean
  recoveryRuleApplied?: boolean
  agentConfig?: AgentConfigSummary
  agentProxy?: AgentProxySummary
  fullAutoEnabled?: boolean
  /** Local browser surface exposed by a managed Web Agent such as DeepSeek Harness. */
  webUrl?: string
}

export type AuditLevel = 'info' | 'warning' | 'error'
export type AuditCategory = 'session' | 'approval' | 'recovery' | 'rule' | 'remote'

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

export interface AgentInstallProgress {
  target: 'node' | 'agent' | 'dependency'
  agentKind?: AgentKind
  phase: 'starting' | 'running' | 'completed' | 'failed'
  elapsedMs: number
  message?: string
  level?: 'info' | 'warning' | 'error'
}

export type ManagerEvent =
  | ({ sessionId: string; sequence?: number } & HostEvent)
  | { type: 'sessions-changed'; sessionId: string }
  | { type: 'audit-changed' }
  | { type: 'external-terminal-drag'; projection: ExternalTerminalDragProjection | null }
  | { type: 'agent-install-progress'; progress: AgentInstallProgress }

export const IPC_CHANNELS = {
  listSessions: 'agent-manager:list-sessions',
  terminalReplay: 'agent-manager:terminal-replay',
  listAuditEntries: 'agent-manager:list-audit-entries',
  exportAuditEntries: 'agent-manager:export-audit-entries',
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
  detachSession: 'agent-manager:detach-session',
  renameSession: 'agent-manager:rename-session',
  updateSessionConfig: 'agent-manager:update-session-config',
  updateSessionProxy: 'agent-manager:update-session-proxy',
  setFullAutoMode: 'agent-manager:set-full-auto-mode',
  listCCSwitchProviders: 'agent-manager:list-ccswitch-providers',
  getContinueKeywordSettings: 'agent-manager:get-continue-keyword-settings',
  updateContinueKeywordSettings: 'agent-manager:update-continue-keyword-settings',
  getSessionSafetySettings: 'agent-manager:get-session-safety-settings',
  updateSessionSafetySettings: 'agent-manager:update-session-safety-settings',
  getDingTalkSettings: 'agent-manager:get-dingtalk-settings',
  updateDingTalkSettings: 'agent-manager:update-dingtalk-settings',
  resetDingTalkBinding: 'agent-manager:reset-dingtalk-binding',
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
  chooseExecutable: 'agent-manager:choose-executable',
  discoverSessions: 'agent-manager:discover-sessions',
  detectAgentEnvironment: 'agent-manager:detect-agent-environment',
  installNodeAndNpm: 'agent-manager:install-node-and-npm',
  installAgent: 'agent-manager:install-agent',
  installRipgrep: 'agent-manager:install-ripgrep',
  readClipboardText: 'agent-manager:read-clipboard-text',
  writeClipboardText: 'agent-manager:write-clipboard-text',
  event: 'agent-manager:event',
} as const

export interface AgentManagerApi {
  listSessions(): Promise<SessionSummary[]>
  terminalReplay(sessionId: string): Promise<TerminalReplaySnapshot>
  listAuditEntries(): Promise<AuditEntry[]>
  exportAuditEntries(entryIds: string[]): Promise<string | undefined>
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
  detachSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, displayName: string): Promise<void>
  updateSessionConfig(sessionId: string, config: AgentConfigInput): Promise<void>
  updateSessionProxy(sessionId: string, proxy: AgentProxyInput): Promise<void>
  setFullAutoMode(sessionId: string, enabled: boolean): Promise<void>
  listCCSwitchProviders(agentKind: AgentKind): Promise<CCSwitchProviderSummary[]>
  getContinueKeywordSettings(): Promise<ContinueKeywordSettings>
  updateContinueKeywordSettings(settings: ContinueKeywordSettings): Promise<ContinueKeywordSettings>
  getSessionSafetySettings(): Promise<SessionSafetySettings>
  updateSessionSafetySettings(settings: SessionSafetySettings): Promise<SessionSafetySettings>
  getDingTalkSettings(): Promise<DingTalkSettingsSummary>
  updateDingTalkSettings(settings: DingTalkSettingsInput): Promise<DingTalkSettingsSummary>
  resetDingTalkBinding(): Promise<DingTalkSettingsSummary>
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
  chooseExecutable?(agentKind: AgentKind): Promise<string | undefined>
  discoverSessions(agentKind: AgentKind, workspace: string): Promise<NativeSessionSummary[]>
  detectAgentEnvironment?(agentKind: AgentKind, executable: string): Promise<AgentEnvironmentSummary>
  installNodeAndNpm?(): Promise<void>
  installAgent?(agentKind: AgentKind, registry?: NpmRegistryChoice): Promise<void>
  installRipgrep?(): Promise<void>
  readClipboardText(): Promise<string>
  writeClipboardText(text: string): Promise<void>
  subscribe(listener: (event: ManagerEvent) => void): () => void
}
