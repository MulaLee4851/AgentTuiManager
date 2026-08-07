export type SessionStatus =
  | 'starting'
  | 'running'
  | 'needs_approval'
  | 'recovering'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'unknown'

export interface SessionState {
  sessionId: string
  workspace: string
  status: SessionStatus
  recoveryAttempts: number
  userStopRequested: boolean
  lastError?: string
}

export type SessionEvent =
  | { type: 'started' }
  | { type: 'approval-required' }
  | {
      type: 'process-exited'
      exitCode: number
      userInitiated: boolean
      adapterCompletion: boolean
    }
  | { type: 'abnormal-exit'; reason: string }
  | { type: 'recovery-failed'; reason: string }
  | { type: 'unknown' }
  | { type: 'no-output-timeout' }
  | { type: 'user-stop-requested' }

const MAX_RECOVERY_ATTEMPTS = 3

export function reduceSession(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  switch (event.type) {
    case 'started':
      return { ...state, status: 'running' }
    case 'approval-required':
      return { ...state, status: 'needs_approval' }
    case 'process-exited':
      if (event.userInitiated || state.userStopRequested) {
        return { ...state, status: 'stopped' }
      }
      if (event.exitCode === 0 || event.adapterCompletion) {
        return { ...state, status: 'completed' }
      }
      return {
        ...state,
        status: 'failed',
        lastError: `Process exited with code ${event.exitCode}`,
      }
    case 'user-stop-requested':
      return { ...state, status: 'stopped', userStopRequested: true }
    case 'abnormal-exit': {
      const recoveryAttempts = Math.min(
        state.recoveryAttempts + 1,
        MAX_RECOVERY_ATTEMPTS,
      )
      return {
        ...state,
        status:
          recoveryAttempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'recovering',
        recoveryAttempts,
        lastError: event.reason,
      }
    }
    case 'recovery-failed': {
      const recoveryAttempts = Math.min(
        state.recoveryAttempts + 1,
        MAX_RECOVERY_ATTEMPTS,
      )
      return {
        ...state,
        status:
          recoveryAttempts >= MAX_RECOVERY_ATTEMPTS ? 'failed' : 'recovering',
        recoveryAttempts,
        lastError: event.reason,
      }
    }
    case 'unknown':
      return { ...state, status: 'unknown' }
    case 'no-output-timeout':
      return { ...state, status: 'running' }
  }
}
