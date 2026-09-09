import { describe, expect, it } from 'vitest'
import { SESSION_STATUS_LABEL, parseSessionDisplayStatus, sessionDisplayStatus, type SessionStatus, type SessionActivity } from '../../src/shared/session-state'

describe('five Agent display states', () => {
  it('exposes only the five requested Chinese labels', () => {
    expect(Object.values(SESSION_STATUS_LABEL)).toEqual(['已停止', '运行中', '待命', '待审批', '异常'])
  })

  it.each([
    ['starting', undefined, 'idle'],
    ['running', undefined, 'idle'],
    ['running', 'starting', 'idle'],
    ['running', 'idle', 'idle'],
    ['running', 'completed', 'idle'],
    ['running', 'running', 'running'],
    ['needs_approval', 'idle', 'needs_approval'],
    ['needs_approval', 'error', 'needs_approval'],
    ['recovering', 'error', 'running'],
    ['stopped', 'running', 'stopped'],
    ['stopped', 'error', 'stopped'],
    ['completed', 'completed', 'stopped'],
    ['failed', 'running', 'error'],
    ['needs_attention', 'idle', 'error'],
    ['unknown', undefined, 'error'],
    ['running', 'error', 'error'],
  ] as Array<[SessionStatus, SessionActivity | undefined, string]>)('%s / %s displays %s without mutating the lifecycle', (status, activity, expected) => {
    const session = Object.freeze({ status, activity })
    expect(sessionDisplayStatus(session)).toBe(expected)
    expect(session).toEqual({ status, activity })
  })

  it('accepts the five states and the Chinese error alias but not obsolete filters', () => {
    for (const [status, label] of Object.entries(SESSION_STATUS_LABEL)) {
      expect(parseSessionDisplayStatus(label)).toBe(status)
      expect(parseSessionDisplayStatus(status.toUpperCase())).toBe(status)
    }
    expect(parseSessionDisplayStatus('错误')).toBe('error')
    expect(parseSessionDisplayStatus('needs_approval')).toBe('needs_approval')
    expect(parseSessionDisplayStatus('completed')).toBeUndefined()
  })
})
