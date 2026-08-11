export type SessionStatus =
  | 'starting'
  | 'running'
  | 'needs_approval'
  | 'recovering'
  | 'needs_attention'
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
  | { type: 'abnormal-exit'; reason: string; maxAttempts?: number }
  | { type: 'recovery-failed'; reason: string; maxAttempts?: number }
  | { type: 'retry-exhausted'; reason: string }
  | { type: 'manual-continue' }
  | { type: 'unknown' }
  | { type: 'no-output-timeout' }
  | { type: 'user-stop-requested' }

const MAX_RECOVERY_ATTEMPTS = 3

function advanceRecovery(state: SessionState, reason: string, maxAttempts = MAX_RECOVERY_ATTEMPTS): SessionState {
  if (state.recoveryAttempts >= maxAttempts) {
    return {
      ...state,
      status: 'failed',
      recoveryAttempts: maxAttempts,
      lastError: reason,
    }
  }

  return {
    ...state,
    status: 'recovering',
    recoveryAttempts: state.recoveryAttempts + 1,
    lastError: reason,
  }
}

export function reduceSession(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  if (state.userStopRequested) {
    return { ...state, status: 'stopped' }
  }

  if (event.type === 'process-exited' && event.exitCode === 0) {
    return { ...state, status: 'completed', userStopRequested: false }
  }

  if (
    state.status === 'completed' ||
    state.status === 'stopped' ||
    state.status === 'failed'
  ) {
    return { ...state }
  }

  switch (event.type) {
    case 'started':
      return { ...state, status: 'running' }
    case 'manual-continue': {
      const { lastError: _lastError, ...rest } = state
      return { ...rest, status: 'running', recoveryAttempts: 0 }
    }
    case 'approval-required':
      return { ...state, status: 'needs_approval' }
    case 'process-exited':
      if (event.userInitiated || state.userStopRequested) {
        return { ...state, status: 'stopped' }
      }
      if (event.exitCode === 0) {
        return { ...state, status: 'completed' }
      }
      return {
        ...state,
        status: 'failed',
        lastError: `Process exited with code ${event.exitCode}`,
      }
    case 'user-stop-requested':
      return { ...state, status: 'stopped', userStopRequested: true }
    case 'abnormal-exit':
    case 'recovery-failed':
      return advanceRecovery(state, event.reason, event.maxAttempts)
    case 'retry-exhausted':
      return { ...state, status: 'needs_attention', lastError: event.reason }
    case 'unknown':
      return { ...state, status: 'unknown' }
    case 'no-output-timeout':
      return { ...state }
  }
}
