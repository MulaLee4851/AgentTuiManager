export type HostCommand =
  | {
      type: 'start'
      executable: string
      args: string[]
      cwd: string
      cols: number
      rows: number
    }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'stop' }
  | { type: 'ping' }

export type HostEvent =
  | { type: 'ready'; hostId: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export interface HostExitFact {
  hostId: string
  exitCode: number
  signal?: number
  exitedAt: string
}
