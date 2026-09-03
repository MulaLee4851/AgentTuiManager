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
  | { type: 'permission-hook'; token: string; requestId: string; hookSource: 'claude' | 'codex'; toolName: string; command?: string; operation?: import('./manager-api').ApprovalRisk; filePath?: string; targetPaths?: string[]; toolInputSummary?: string; reason?: string; toolUseId?: string; agentId?: string; agentType?: string; toolInputFingerprint?: string; nativeSessionId?: string; turnId?: string; cwd?: string; model?: string; permissionMode?: string; transcriptPath?: string; toolInput?: unknown; rawPayload?: unknown }
  | { type: 'replay' }
  | { type: 'stop' }
  | { type: 'claim-manager'; managerId: string; leaseMs: number; preserveOnLeaseExpiry?: boolean }
  | { type: 'manager-heartbeat'; managerId: string }
  | { type: 'preserve-on-disconnect'; managerId: string }
  | { type: 'ping' }

export type HostEvent =
  | { type: 'ready'; hostId: string; permissionHook?: 'claude' | 'codex' }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'permission-request'; requestId: string; hookSource?: 'claude' | 'codex'; toolName: string; command?: string; operation?: import('./manager-api').ApprovalRisk; filePath?: string; targetPaths?: string[]; toolInputSummary?: string; reason?: string; toolUseId?: string; agentId?: string; agentType?: string; toolInputFingerprint?: string; nativeSessionId?: string; turnId?: string; cwd?: string; model?: string; permissionMode?: string; transcriptPath?: string; toolInput?: unknown; rawPayload?: unknown }
  | { type: 'permission-response'; requestId: string; action: 'allow' | 'ask' | 'deny' }
  | { type: 'permission-response-ack'; requestId: string; delivered: boolean }
  | { type: 'permission-hook-closed'; requestId: string; hookSource: 'claude' | 'codex' }
  | { type: 'replay'; data: string }
  | { type: 'manager-preserved'; managerId: string }
  | { type: 'pong'; ownership: 'managed' | 'preserved' | 'unclaimed' }

export interface HostExitFact {
  hostId: string
  exitCode: number
  signal?: number
  reason?: 'process-exit' | 'manager-lease-expired'
  exitedAt: string
}
