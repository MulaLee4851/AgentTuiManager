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
    const userInitiatedExit = reduceSession(
      { ...baseState(), status: 'running' },
      {
        type: 'process-exited',
        exitCode: 130,
        userInitiated: true,
        adapterCompletion: false,
      },
    )
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
    expect(userInitiatedExit).toMatchObject({
      status: 'stopped',
      recoveryAttempts: 0,
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
        adapterCompletion: true,
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
    const exhausted = reduceSession(thirdAttempt, {
      type: 'recovery-failed',
      reason: 'recovery exhausted',
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
      status: 'recovering',
      recoveryAttempts: 3,
    })
    expect(exhausted).toMatchObject({
      status: 'failed',
      recoveryAttempts: 3,
      lastError: 'recovery exhausted',
    })
  })

  it('marks unknown evidence unknown and treats no output as non-actionable', () => {
    const awaitingApproval = {
      ...baseState(),
      status: 'needs_approval' as const,
    }

    expect(reduceSession(awaitingApproval, { type: 'unknown' }).status).toBe(
      'unknown',
    )
    expect(
      reduceSession(awaitingApproval, { type: 'no-output-timeout' }),
    ).toMatchObject({
      status: 'needs_approval',
      recoveryAttempts: 0,
    })
  })

  it('keeps stop intent and terminal states absorbing during late abnormal events', () => {
    const stopped = {
      ...baseState(),
      status: 'stopped' as const,
      userStopRequested: true,
    }
    const completed = { ...baseState(), status: 'completed' as const }

    const stoppedAfterAbnormal = reduceSession(stopped, {
      type: 'abnormal-exit',
      reason: 'late host exit',
    })
    const completedAfterAbnormal = reduceSession(completed, {
      type: 'abnormal-exit',
      reason: 'late host exit',
    })

    expect(stoppedAfterAbnormal).not.toBe(stopped)
    expect(stoppedAfterAbnormal).toEqual(stopped)
    expect(completedAfterAbnormal).not.toBe(completed)
    expect(completedAfterAbnormal).toEqual(completed)
  })
})
