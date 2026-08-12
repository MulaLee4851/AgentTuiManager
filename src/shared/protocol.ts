export type HostCommand =
  | {
      type: 'start'
      agentKind: import('./manager-api').AgentKind
      executable: string
      args: string[]
      cwd: string
      cols: number
      rows: number
      environment?: Record<string, string>
    }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'permission-response'; requestId: string; action: 'allow' | 'ask' | 'deny' }
  | { type: 'permission-hook'; token: string; requestId: string; toolName: string; command?: string; operation?: import('./manager-api').ApprovalRisk; filePath?: string; targetPaths?: string[]; toolInputSummary?: string; reason?: string }
  | { type: 'replay' }
  | { type: 'stop' }
  | { type: 'ping' }

export type HostEvent =
  | { type: 'ready'; hostId: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'permission-request'; requestId: string; toolName: string; command?: string; operation?: import('./manager-api').ApprovalRisk; filePath?: string; targetPaths?: string[]; toolInputSummary?: string; reason?: string }
  | { type: 'permission-response'; requestId: string; action: 'allow' | 'ask' | 'deny' }
  | { type: 'replay'; data: string }
  | { type: 'pong' }

export interface HostExitFact {
  hostId: string
  exitCode: number
  signal?: number
  exitedAt: string
}
