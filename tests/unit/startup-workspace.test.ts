import { describe, expect, it, vi } from 'vitest'
import { restoreStartupWorkspace, workspaceRestoreCandidates } from '../../electron/startup-workspace'
import type { SessionSummary } from '../../src/shared/manager-api'

const entry = (sessionId: string, status: SessionSummary['status'] = 'stopped'): SessionSummary => ({
  sessionId, displayName: sessionId, nativeSessionId: 'native-' + sessionId,
  agentKind: 'codex', workspace: 'demo', status, recoveryAttempts: 0, userStopRequested: false,
})

describe('startup workspace native resume', () => {
  it('only offers the prior active snapshot, skipping already live windows and unrelated stopped entries', () => {
    expect(workspaceRestoreCandidates(['a', 'b'], [entry('a'), entry('b', 'running'), entry('old')]).map(item => item.sessionId)).toEqual(['a'])
  })

  it('resumes sequentially without changing automation; one failure does not block the next window', async () => {
    const sessions = [{ ...entry('a'), fullAutoEnabled: true }, { ...entry('b'), fullAutoEnabled: false }, entry('c'), { ...entry('missing'), nativeSessionId: undefined }]
    const calls: string[] = []
    const port = {
      listSessions: () => sessions,
      setFullAutoMode: vi.fn(async (id: string, enabled: boolean) => { calls.push('safe-' + id); expect(enabled).toBe(false) }),
      restartSession: vi.fn(async (id: string) => { calls.push('start-' + id); if (id === 'b') throw new Error('connection failed') }),
    }
    const result = await restoreStartupWorkspace(['a', 'b', 'c', 'missing', 'a'], port)
    expect(calls).toEqual(['start-a', 'start-b', 'start-c'])
    expect(port.setFullAutoMode).not.toHaveBeenCalled()
    expect(sessions[0]!.fullAutoEnabled).toBe(true)
    expect(sessions[1]!.fullAutoEnabled).toBe(false)
    expect(result.restored).toEqual(['a', 'c'])
    expect(result.failed.map(item => item.sessionId)).toEqual(['b', 'missing'])
    expect(result.failed[0]!.reason).toBe('connection failed')
  })

  it('never opens a duplicate native conversation or restarts an already live window', async () => {
    const sessions = [entry('a'), { ...entry('duplicate'), nativeSessionId: 'native-a' }, entry('live', 'running')]
    const port = { listSessions: () => sessions, setFullAutoMode: vi.fn(async () => undefined), restartSession: vi.fn(async () => undefined) }
    const result = await restoreStartupWorkspace(['a', 'duplicate', 'live'], port)
    expect(port.restartSession).toHaveBeenCalledTimes(1)
    expect(result.failed[0]!.sessionId).toBe('duplicate')
  })
})
