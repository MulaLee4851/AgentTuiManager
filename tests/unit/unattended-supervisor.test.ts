import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnattendedSupervisor, recoveryMessage } from '../../electron/unattended-supervisor'
import type { ApprovalRequest, SessionSummary } from '../../src/shared/manager-api'

const settings = { enabled: true, endWord: 'TASK-DONE', recoveryWord: 'continue' }
const supervisors: UnattendedSupervisor[] = []
afterEach(() => { for (const supervisor of supervisors.splice(0)) { supervisor.disable('a'); supervisor.disable('b') } })
function fixture() {
  let now = 10000
  const sessions = new Map<string, SessionSummary>(['a', 'b'].map(id => [id, {
    sessionId: id, agentKind: 'codex', nativeSessionId: 'native-' + id, status: 'running',
    activity: 'idle', activityUpdatedAt: 10000,
  } as SessionSummary]))
  let approvals: ApprovalRequest[] = []
  const port = {
    session: (id: string) => sessions.get(id),
    approvals: (id: string) => approvals.filter(item => item.sessionId === id),
    ready: vi.fn(() => true), approve: vi.fn(async () => undefined), send: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined), changed: vi.fn(), audit: vi.fn(),
    enter: vi.fn(async () => true), epoch: vi.fn(() => 1),
  }
  const supervisor = new UnattendedSupervisor(port, () => now)
  supervisors.push(supervisor)
  supervisor.enable('a', settings)
  return { supervisor, port, sessions, time: (value: number) => { now = value }, pending: (value: ApprovalRequest[]) => { approvals = value } }
}

describe('per-window unattended mode', () => {
  it('approves during recovery cooldown instead of waiting ten seconds', async () => {
    const f = fixture()
    f.time(16000); await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(1)
    f.pending([{ sessionId: 'a', requestId: 'hook-next', source: 'codex-hook' } as ApprovalRequest])
    f.time(17000); await f.supervisor.tick('a')
    expect(f.port.approve).toHaveBeenCalledWith('hook-next')
    expect(f.port.send).toHaveBeenCalledTimes(1)
  })

  it('does not hold new hooks behind delayed Enter or initial cooldown', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 10 })
    f.pending([{ sessionId: 'a', requestId: 'one', source: 'codex-hook' } as ApprovalRequest])
    f.time(11000); await f.supervisor.tick('a')
    expect(f.port.approve).toHaveBeenCalledWith('one')
    f.pending([{ sessionId: 'a', requestId: 'two', source: 'codex-hook' } as ApprovalRequest])
    f.time(12000); await f.supervisor.tick('a')
    expect(f.port.approve).toHaveBeenCalledWith('two')
    expect(f.port.enter).not.toHaveBeenCalled()
    expect(f.port.send).not.toHaveBeenCalled()
    f.pending([])
    f.time(20999); await f.supervisor.tick('a')
    expect(f.port.enter).not.toHaveBeenCalled()
    f.time(21000); await f.supervisor.tick('a')
    // A newer hook must not postpone the existing fallback deadline.
    expect(f.port.enter).toHaveBeenCalledTimes(1)
    expect(f.port.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unattended_approved',
      details: expect.objectContaining({ requestId: 'two', source: 'codex-hook' }),
    }))
  })

  it('drains simultaneous approvals without one Enter timer per request', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 7, approvalEnterCount: 5 })
    f.pending(['one', 'two', 'three'].map(requestId => ({ sessionId: 'a', requestId, source: 'codex-hook' } as ApprovalRequest)))
    f.time(11000); await f.supervisor.tick('a')
    expect(f.port.approve.mock.calls).toEqual([['one'], ['two'], ['three']])
    expect(f.port.audit.mock.calls.filter(([entry]) => entry.action === 'unattended_approval_enter_scheduled')).toHaveLength(1)
    expect(f.port.enter).not.toHaveBeenCalled()
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it('sends the configured count one second apart, without catch-up bursts', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 5, approvalEnterCount: 3 })
    f.pending([{ sessionId: 'a', requestId: 'r', risk: 'unknown' } as ApprovalRequest])
    f.time(15000); await f.supervisor.tick('a'); f.pending([])
    f.time(20000); await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(1)
    f.time(20999); await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(1)
    f.time(60000); await f.supervisor.tick('a'); await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(2)
    f.time(61000); await f.supervisor.tick('a'); await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(3)
    expect(f.port.enter.mock.calls).toEqual([['a'], ['a'], ['a']])
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it('cancels all remaining presses when the user intervenes after the first', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 5, approvalEnterCount: 3 })
    f.pending([{ sessionId: 'a', requestId: 'r', risk: 'unknown' } as ApprovalRequest])
    f.time(15000); await f.supervisor.tick('a'); f.pending([])
    f.time(20000); await f.supervisor.tick('a')
    f.supervisor.cancelApprovalEnter('a')
    f.time(21000); await f.supervisor.tick('a')
    f.time(22000); await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(1)
  })
  it('sends one delayed Enter even after the approval queue has disappeared', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 5 })
    f.pending([{ sessionId: 'a', requestId: 'r', risk: 'unknown' } as ApprovalRequest])
    f.time(15000)
    await f.supervisor.tick('a')
    f.pending([])
    f.time(19999)
    await f.supervisor.tick('a')
    expect(f.port.enter).not.toHaveBeenCalled()
    expect(f.port.send).not.toHaveBeenCalled()
    f.time(20000)
    await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(1)
    expect(f.port.enter).toHaveBeenCalledWith('a')
    await f.supervisor.tick('a')
    expect(f.port.enter).toHaveBeenCalledTimes(1)
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it.each(['disable', 'input', 'restart', 'done', 'exit'] as const)('cancels pending Enter on %s', async reason => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 5 })
    f.pending([{ sessionId: 'a', requestId: 'r', risk: 'unknown' } as ApprovalRequest])
    f.time(15000)
    await f.supervisor.tick('a')
    f.pending([])
    if (reason === 'disable') f.supervisor.disable('a')
    if (reason === 'input') f.supervisor.cancelApprovalEnter('a')
    if (reason === 'restart') f.port.epoch.mockReturnValue(2)
    if (reason === 'done') f.supervisor.observe('a', 'TASK-DONE', 16000)
    if (reason === 'exit') f.sessions.get('a')!.status = 'failed'
    f.time(20000)
    await f.supervisor.tick('a')
    expect(f.port.enter).not.toHaveBeenCalled()
  })

  it('does not arm a delayed Enter when input arrives during approval', async () => {
    const f = fixture()
    f.supervisor.enable('a', { ...settings, approvalEnterDelaySeconds: 5 })
    f.pending([{ sessionId: 'a', requestId: 'r', risk: 'unknown' } as ApprovalRequest])
    f.port.approve.mockImplementation(async () => { f.supervisor.cancelApprovalEnter('a') })
    f.time(15000)
    await f.supervisor.tick('a')
    f.pending([])
    f.time(20000)
    await f.supervisor.tick('a')
    expect(f.port.enter).not.toHaveBeenCalled()
  })
  it('keeps retrying native restart failures with capped backoff, not a shutdown', async () => {
    const f = fixture()
    f.sessions.get('a')!.status = 'failed'
    f.port.restart.mockRejectedValue(new Error('connection unavailable'))
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(true)
    f.time(45000)
    await f.supervisor.tick('a')
    expect(f.port.restart).toHaveBeenCalledTimes(1)
    f.time(46000)
    await f.supervisor.tick('a')
    expect(f.port.restart).toHaveBeenCalledTimes(2)
    f.time(105000)
    await f.supervisor.tick('a')
    expect(f.port.restart).toHaveBeenCalledTimes(2)
    f.time(106000)
    await f.supervisor.tick('a')
    expect(f.port.restart).toHaveBeenCalledTimes(3)
    expect(f.supervisor.enabled('a')).toBe(true)
  })

  it('backs off repeated model errors without logging or sending on every tick', async () => {
    const f = fixture()
    f.sessions.get('a')!.activity = 'error'
    f.time(16000)
    await f.supervisor.tick('a')
    f.time(27000)
    for (let i = 0; i < 60; i++) await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(1)
    expect(f.port.audit.mock.calls.filter(([entry]) => entry.action === 'unattended_waiting')).toHaveLength(1)
    f.time(46000)
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(2)
    expect(f.supervisor.enabled('a')).toBe(true)
    f.supervisor.disable('a')
    f.time(1000000)
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(2)
  })
  it('reports a blocked idle state once rather than logging on every tick', async () => {
    const f = fixture()
    f.port.ready.mockReturnValue(false)
    f.time(16000)
    for (let i = 0; i < 60; i++) await f.supervisor.tick('a')
    expect(f.port.audit.mock.calls.filter(([entry]) => entry.action === 'unattended_waiting')).toHaveLength(1)
    expect(f.port.changed).toHaveBeenLastCalledWith('a', expect.objectContaining({ enabled: true, reason: expect.stringContaining('等待') }))
    expect(f.port.send).not.toHaveBeenCalled()
    f.port.ready.mockReturnValue(true)
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(1)
    expect(f.port.changed).toHaveBeenLastCalledWith('a', expect.objectContaining({ enabled: true, reason: undefined }))
  })
  it.each(['TASK-DONE', 'ALL-DONE', '完成'])('stops on any configured end word: %s', async word => {
    const f = fixture()
    f.supervisor.enable('a', { enabled: true, endWords: ['TASK-DONE', 'ALL-DONE', '完成'], recoveryWord: 'continue' })
    f.supervisor.observe('a', word, 12000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(false)
    expect(f.port.changed).toHaveBeenLastCalledWith('a', expect.objectContaining({
      enabled: false, endWord: 'TASK-DONE', endWords: ['TASK-DONE', 'ALL-DONE', '完成'], reason: expect.stringContaining(word),
    }))
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it('includes only the selected end word in recovery and rejects mere mentions', async () => {
    const f = fixture()
    const multiple = { enabled: true, endWords: ['TASK-DONE', 'ALL-DONE'], recoveryEndWord: 'ALL-DONE', recoveryWord: 'continue' }
    f.supervisor.enable('a', multiple)
    f.supervisor.observe('a', 'Will output ALL-DONE when finished', 12000)
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(true)
    expect(f.port.send).toHaveBeenCalledWith('a', recoveryMessage(multiple))
    expect(recoveryMessage(multiple)).toContain('仅输出 ALL-DONE')
    expect(recoveryMessage(multiple)).not.toContain('TASK-DONE')
  })
  it('sends recovery instructions with the end word only after idle settles', async () => {
    const f = fixture()
    await f.supervisor.tick('a')
    expect(f.port.send).not.toHaveBeenCalled()
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledWith('a', recoveryMessage(settings))
    expect(recoveryMessage(settings)).toContain('仅输出 TASK-DONE')
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(1)
  })

  it('approves even high-risk requests only in the selected session, without sending recovery', async () => {
    const f = fixture()
    f.pending([{ sessionId: 'a', requestId: 'delete-a', risk: 'delete' }, { sessionId: 'b', requestId: 'delete-b', risk: 'delete' }] as ApprovalRequest[])
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.port.approve).toHaveBeenCalledTimes(1)
    expect(f.port.approve).toHaveBeenCalledWith('delete-a')
    expect(f.port.send).not.toHaveBeenCalled()
    expect(f.port.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'unattended_approved' }))
  })

  it('waits for approval acknowledgement instead of treating an empty queue as idle', async () => {
    const f = fixture()
    f.sessions.get('a')!.status = 'needs_approval'
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.port.send).not.toHaveBeenCalled()
    f.sessions.get('a')!.status = 'running'
    f.port.ready.mockReturnValue(false)
    await f.supervisor.tick('a')
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it('requires a fresh exact assistant reply and does not cross windows', async () => {
    const f = fixture()
    f.supervisor.observe('a', 'TASK-DONE', 9000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(true)
    f.supervisor.observe('b', 'TASK-DONE', 11000)
    f.supervisor.observe('a', 'When done output TASK-DONE', 11000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(true)
    f.supervisor.observe('a', ' TASK-DONE\n', 12000)
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(false)
    expect(f.port.send).not.toHaveBeenCalled()
    expect(f.port.approve).not.toHaveBeenCalled()
  })

  it('does not approve the next request after mode is disabled mid-decision', async () => {
    const f = fixture()
    f.pending([{ sessionId: 'a', requestId: 'one' }, { sessionId: 'a', requestId: 'two' }] as ApprovalRequest[])
    f.port.approve.mockImplementation(async () => { f.supervisor.disable('a') })
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.port.approve).toHaveBeenCalledTimes(1)
    expect(f.port.send).not.toHaveBeenCalled()
  })

  it('pauses on delivery uncertainty instead of repeatedly filling the input', async () => {
    const f = fixture()
    f.port.send.mockRejectedValue(new Error('未确认接收'))
    f.time(16000)
    await f.supervisor.tick('a')
    await f.supervisor.tick('a')
    expect(f.port.send).toHaveBeenCalledTimes(1)
    expect(f.supervisor.enabled('a')).toBe(false)
  })
  it('keeps a fast completion arriving together with the message receipt', async () => {
    const f = fixture()
    f.port.send.mockImplementation(async () => { f.supervisor.observe('a', 'TASK-DONE', 16001) })
    f.time(16000)
    await f.supervisor.tick('a')
    await f.supervisor.tick('a')
    expect(f.supervisor.enabled('a')).toBe(false)
    expect(f.port.send).toHaveBeenCalledTimes(1)
  })

  it('resumes the native session but limits restart loops', async () => {
    const f = fixture()
    f.sessions.get('a')!.status = 'failed'
    for (const now of [16000, 27000, 38000, 49000]) { f.time(now); await f.supervisor.tick('a') }
    expect(f.port.restart).toHaveBeenCalledTimes(3)
    expect(f.supervisor.enabled('a')).toBe(true)
    expect(f.port.send).not.toHaveBeenCalled()
    f.time(110000)
    await f.supervisor.tick('a')
    expect(f.port.restart).toHaveBeenCalledTimes(4)
  })

  it('does not invent a native session or restart after a manual stop', async () => {
    const f = fixture()
    f.sessions.get('a')!.status = 'failed'
    delete f.sessions.get('a')!.nativeSessionId
    f.time(16000)
    await f.supervisor.tick('a')
    expect(f.port.restart).not.toHaveBeenCalled()
    expect(f.supervisor.enabled('a')).toBe(false)
    const g = fixture()
    g.sessions.get('a')!.userStopRequested = true
    g.time(16000)
    await g.supervisor.tick('a')
    expect(g.supervisor.enabled('a')).toBe(false)
    expect(g.port.restart).not.toHaveBeenCalled()
  })
})
