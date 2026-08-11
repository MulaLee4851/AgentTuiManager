import type { HostEvent } from './protocol'
import type { SessionState } from './session-state'

export type AgentKind = 'generic' | 'codex' | 'claude' | 'pi'
export type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'

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
  approvalSuggestion?: ApprovalRuleSuggestion
  recoveryAction?: 'continue' | 'resume'
  recoveryAttempted?: boolean
  recoveryRuleApplied?: boolean
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

export type TerminalHistoryRole = 'user' | 'agent' | 'tool' | 'tool_result' | 'error' | 'system'

export interface TerminalHistoryEntry {
  role: TerminalHistoryRole
  text: string
  title?: string
}

export interface TerminalHistorySnapshot {
  entries: TerminalHistoryEntry[]
  truncated: boolean
}

export type ManagerEvent =
  | ({ sessionId: string; sequence?: number } & HostEvent)
  | { type: 'sessions-changed'; sessionId: string }
  | { type: 'audit-changed' }

export const IPC_CHANNELS = {
  listSessions: 'agent-manager:list-sessions',
  terminalReplay: 'agent-manager:terminal-replay',
  terminalHistory: 'agent-manager:terminal-history',
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
  approveSession: 'agent-manager:approve-session',
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
  terminalHistory(sessionId: string): Promise<TerminalHistorySnapshot>
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
  approveSession(sessionId: string): Promise<void>
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
