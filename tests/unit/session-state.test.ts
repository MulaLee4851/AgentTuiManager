import { describe, expect, it } from 'vitest'

import {
  reduceSession,
  type SessionState,
} from '../../src/shared/session-state'

const baseState = (): SessionState => ({
  sessionId: 'session-1',
  workspace: 'B:/workspace',
  status: 'starting',
  recoveryAttempts: 0,
  userStopRequested: false,
})

describe('reduceSession', () => {
  it('moves started sessions to running and approval requests to needs_approval', () => {
    const running = reduceSession(baseState(), { type: 'started' })
    const awaitingApproval = reduceSession(running, {
      type: 'approval-required',
    })

    expect(running.status).toBe('running')
    expect(awaitingApproval.status).toBe('needs_approval')
  })

  it('completes a normal exit without starting recovery', () => {
    const state = { ...baseState(), status: 'running' as const }

    const result = reduceSession(state, {
      type: 'process-exited',
      exitCode: 0,
      userInitiated: false,
      adapterCompletion: false,
    })

    expect(result).not.toBe(state)
    expect(result.status).toBe('completed')
    expect(result.recoveryAttempts).toBe(0)
  })

  it('preserves stop intent when the process later exits non-zero', () => {
    const stopped = reduceSession(
      { ...baseState(), status: 'running' },
      { type: 'user-stop-requested' },
    )

    const exited = reduceSession(stopped, {
      type: 'process-exited',
      exitCode: 137,
      userInitiated: false,
      adapterCompletion: false,
    })

    expect(stopped).toMatchObject({
      status: 'stopped',
      userStopRequested: true,
    })
    expect(exited.status).toBe('stopped')
  })

  it('recovers only from explicit abnormal evidence and fails at the third attempt', () => {
    const ordinaryFailure = reduceSession(
      { ...baseState(), status: 'running' },
      {
        type: 'process-exited',
        exitCode: 1,
        userInitiated: false,
        adapterCompletion: false,
      },
    )
    const firstAttempt = reduceSession(
      { ...baseState(), status: 'running' },
      { type: 'abnormal-exit', reason: 'pty disconnected' },
    )
    const secondAttempt = reduceSession(firstAttempt, {
      type: 'recovery-failed',
      reason: 'reattach failed',
    })
    const thirdAttempt = reduceSession(secondAttempt, {
      type: 'recovery-failed',
      reason: 'host unavailable',
    })

    expect(ordinaryFailure.status).toBe('failed')
    expect(ordinaryFailure.recoveryAttempts).toBe(0)
    expect(firstAttempt).toMatchObject({
      status: 'recovering',
      recoveryAttempts: 1,
    })
    expect(secondAttempt).toMatchObject({
      status: 'recovering',
      recoveryAttempts: 2,
    })
    expect(thirdAttempt).toMatchObject({
      status: 'failed',
      recoveryAttempts: 3,
      lastError: 'host unavailable',
    })
  })

  it('marks unknown evidence unknown and treats no output as non-actionable', () => {
    const running = { ...baseState(), status: 'running' as const }

    expect(reduceSession(running, { type: 'unknown' }).status).toBe('unknown')
    expect(reduceSession(running, { type: 'no-output-timeout' })).toMatchObject({
      status: 'running',
      recoveryAttempts: 0,
    })
  })
})
