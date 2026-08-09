import type { HostEvent } from './protocol'
import type { SessionState } from './session-state'

export type AgentKind = 'generic' | 'codex' | 'claude' | 'pi'

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
  nativeSessionId?: string
  recovery?: RecoveryRecipe
}

export interface SessionSummary extends SessionState {
  displayName: string
  agentKind: AgentKind
  nativeSessionId?: string
}

export type ManagerEvent =
  | ({ sessionId: string } & HostEvent)
  | { type: 'sessions-changed'; sessionId: string }

export const IPC_CHANNELS = {
  listSessions: 'agent-manager:list-sessions',
  startSession: 'agent-manager:start-session',
  write: 'agent-manager:write',
  resize: 'agent-manager:resize',
  stopSession: 'agent-manager:stop-session',
  event: 'agent-manager:event',
} as const

export interface AgentManagerApi {
  listSessions(): Promise<SessionSummary[]>
  startSession(request: StartSessionRequest): Promise<SessionSummary>
  write(sessionId: string, data: string): Promise<void> | void
  resize(sessionId: string, cols: number, rows: number): Promise<void> | void
  stopSession(sessionId: string): Promise<void>
  subscribe(listener: (event: ManagerEvent) => void): () => void
}
