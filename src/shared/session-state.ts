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
  /** Task activity is independent from the PTY lifecycle used by recovery. */
  activity?: SessionActivity
  activityError?: string
  activitySince?: number
  activityUpdatedAt?: number
}

export type SessionActivity = 'starting' | 'idle' | 'running' | 'completed' | 'error'
export type SessionDisplayStatus = 'stopped' | 'running' | 'idle' | 'needs_approval' | 'error'

export const SESSION_STATUS_LABEL: Record<SessionDisplayStatus, string> = {
  stopped: '已停止', running: '运行中', idle: '待命', needs_approval: '待审批', error: '异常',
}

export function sessionDisplayStatus(session: Pick<SessionState, 'status' | 'activity'>): SessionDisplayStatus {
  // Presentation only: keep lifecycle/approval states intact for safety and recovery.
  switch (session.status) {
    case 'stopped': case 'completed': return 'stopped'
    case 'failed': case 'needs_attention': case 'unknown': return 'error'
    case 'needs_approval': return 'needs_approval'
    case 'recovering': return 'running'
    case 'starting': return 'idle'
    case 'running':
      if (session.activity === 'error') return 'error'
      return session.activity === 'running' ? 'running' : 'idle'
  }
}

export function parseSessionDisplayStatus(value: string): SessionDisplayStatus | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === '待授权' || normalized === '等待审批') return 'needs_approval'
  if (Object.prototype.hasOwnProperty.call(SESSION_STATUS_LABEL, normalized)) return normalized as SessionDisplayStatus
  const entry = Object.entries(SESSION_STATUS_LABEL).find(([, label]) => label === normalized)
  if (entry) return entry[0] as SessionDisplayStatus
  if (normalized === '错误') return 'error'
  if (normalized === '空闲' || normalized === '已启动') return 'idle'
  return undefined
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
