import { describe, expect, it, vi } from 'vitest'

import { SessionController, type NativeSessionDiscoveryPort, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostEvent } from '../../src/shared/protocol'
import type { StartSessionRequest } from '../../src/shared/manager-api'
import type { HostHandle, HostRecord, StartHostOptions } from '../../electron/session-host-manager'
import { ApprovalPolicyEngine } from '../../electron/approval-policy'

class FakeHandle implements HostHandle {
  readonly writes: string[] = []
  stops = 0
  readonly hostId: string
  private readonly events: Array<HostEvent | Error> = []
  private readonly waiters: Array<{ resolve: (event: HostEvent) => void; reject: (error: Error) => void }> = []

  constructor(hostId: string) { this.hostId = hostId }
  nextEvent(): Promise<HostEvent> {
    const event = this.events.shift()
    if (event instanceof Error) return Promise.reject(event)
    if (event) return Promise.resolve(event)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  emit(event: HostEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }
  fail(error: Error): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.reject(error)
    else this.events.push(error)
  }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  async stop(): Promise<void> { this.stops += 1 }
  disconnect(): void {}
}

function fixture(discovery?: NativeSessionDiscoveryPort) {
  const handles: FakeHandle[] = []
  const starts: StartHostOptions[] = []
  const manager: SessionHostManagerPort = {
    start: vi.fn(async (options) => {
      starts.push(options)
      const handle = new FakeHandle(`host-${handles.length + 1}`)
      handles.push(handle)
      return handle
    }),
    reconnect: vi.fn(),
    listLiveHosts: vi.fn(async (): Promise<HostRecord[]> => []),
    readLastExit: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async () => undefined),
  }
  return { controller: new SessionController(manager, undefined, discovery), handles, starts, manager }
}

const request = (recovery = false): StartSessionRequest => ({
  displayName: 'Codex work',
  agentKind: 'codex',
  workspace: 'B:\\work',
  executable: 'codex',
  args: [],
  cols: 100,
  rows: 30,
  ...(recovery ? { recovery: { executable: 'codex', args: ['resume', 'native-1'], continueInput: 'continue\r' } } : {}),
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionController recovery evidence', () => {
  it('marks exit 0 completed and never recovers', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.emit({ type: 'exit', exitCode: 0 })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('completed')
    expect(starts).toHaveLength(1)
  })

  it.each(['\x03', '\x1b'])('still completes exit 0 after user input %j', async (input) => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    controller.write(session.sessionId, input)
    handles[0]!.emit({ type: 'exit', exitCode: 0 })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('completed')
    expect(starts).toHaveLength(1)
  })

  it('still completes exit 0 after an explicit stop request', async () => {
    const { controller, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('completed')
    expect(starts).toHaveLength(1)
  })

  it.each(['\x03', '\x1b'])('treats %j followed by non-zero exit as a user stop', async (input) => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    controller.write(session.sessionId, input)
    handles[0]!.emit({ type: 'exit', exitCode: 130 })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
    expect(starts).toHaveLength(1)
  })

  it('starts the resume host only after abnormal exit and continues only after adapter readiness', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.emit({ type: 'exit', exitCode: 1 })
    await settle()

    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ executable: 'codex', args: ['resume', 'native-1'] })
    expect(handles[1]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('recovering')

    handles[1]!.emit({ type: 'output', data: 'loading session' })
    await settle()
    expect(handles[1]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('recovering')

    handles[1]!.emit({ type: 'output', data: 'OpenAI Codex\r\n›\r\n' })
    await settle()
    expect(handles[1]!.writes).toEqual(['continue\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('stops a late recovery host when the user stops while start is pending', async () => {
    const { controller, handles, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    let resolveRecovery: ((handle: HostHandle) => void) | undefined
    vi.mocked(manager.start).mockImplementationOnce((options) => {
      starts.push(options)
      return new Promise((resolve) => { resolveRecovery = resolve })
    })
    handles[0]!.emit({ type: 'exit', exitCode: 1 })
    await settle()
    expect(resolveRecovery).toBeTypeOf('function')

    await controller.stopSession(session.sessionId)
    const late = new FakeHandle('late-recovery')
    resolveRecovery?.(late)
    await settle()

    expect(late.stops).toBe(1)
    expect(late.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
  })

  it('recovers a non-user connection loss when no exit fact appears', async () => {
    const { controller, handles, starts } = fixture()
    await controller.startSession(request(true))
    handles[0]!.fail(new Error('pipe closed'))
    await settle()
    await settle()
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ executable: 'codex', args: ['resume', 'native-1'] })
  })

  it('does not recover a user-stopped connection loss', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    await controller.stopSession(session.sessionId)
    handles[0]!.fail(new Error('pipe closed'))
    await settle()
    await settle()
    expect(starts).toHaveLength(1)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
  })

  it('uses a slightly delayed factual exit 0 before classifying connection loss', async () => {
    const { controller, handles, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    handles[0]!.fail(new Error('pipe closed'))
    await settle()
    await settle()
    expect(starts).toHaveLength(1)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('completed')
  })

  it('restores persisted agent recovery metadata and can resume after a later crash', async () => {
    const { controller, handles, starts, manager } = fixture()
    const restoredHandle = new FakeHandle('restored-host')
    vi.mocked(manager.listLiveHosts).mockResolvedValue([{
      hostId: 'restored-host', agentKind: 'claude', cwd: 'B:\\work', nativeSessionId: 'claude-native',
      pid: 42, endpoint: 'pipe', lifecycle: 'running', createdAt: 'now', updatedAt: 'now', cols: 90, rows: 28,
      recovery: { executable: 'claude', args: ['--resume', 'claude-native'] },
    }])
    vi.mocked(manager.reconnect).mockResolvedValue(restoredHandle)
    await controller.restoreLiveHosts()
    expect(controller.listSessions()[0]).toMatchObject({ agentKind: 'claude', nativeSessionId: 'claude-native' })

    restoredHandle.emit({ type: 'exit', exitCode: 1 })
    await settle()
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ agentKind: 'claude', executable: 'claude', args: ['--resume', 'claude-native'] })
    expect(handles.at(-1)?.writes).toEqual([])
    handles.at(-1)?.emit({ type: 'output', data: 'Claude Code\r\n❯\r\n' })
    await settle()
    expect(handles.at(-1)?.writes).toEqual(['continue\r'])
  })

  it('projects an explicit approval prompt into the session summary', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession(request())
    handles[0]!.emit({ type: 'output', data: 'Would you like to run the following command?' })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')

    controller.write(session.sessionId, '\r')
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('approves only a session with explicit approval evidence', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession(request())
    expect(() => controller.approveSession(session.sessionId)).toThrow(/not awaiting approval/i)

    handles[0]!.emit({ type: 'output', data: 'Approval required' })
    await settle()
    controller.approveSession(session.sessionId)
    expect(handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    expect(() => controller.approveSession(session.sessionId)).toThrow(/not awaiting approval/i)
  })

  it('auto-approves only a recognized command allowed by policy', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession(request())
    base.handles[0]!.emit({ type: 'output', data: '$ git status --short\r\nWould you like to run the following command?' })
    await settle()
    expect(base.handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')

    base.handles[0]!.emit({ type: 'output', data: 'command completed' })
    await settle()
    base.handles[0]!.emit({ type: 'output', data: '$ Remove-Item -Recurse build\r\nWould you like to run the following command?' })
    await settle()
    expect(base.handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')
  })

  it('captures one new native session and persists an exact recovery recipe', async () => {
    let discoveryCalls = 0
    const discovery: NativeSessionDiscoveryPort = {
      discover: vi.fn(async () => {
        discoveryCalls += 1
        return discoveryCalls === 1 ? [] : [{
          id: 'captured-native', title: 'Captured', updatedAt: Date.now(), workspace: 'B:\\work',
        }]
      }),
    }
    const { controller, handles, manager } = fixture(discovery)
    const session = await controller.startSession(request())
    handles[0]!.emit({ type: 'output', data: 'OpenAI Codex\r\n›\r\n' })
    await settle()
    await settle()

    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.nativeSessionId).toBe('captured-native')
    expect(manager.updateMetadata).toHaveBeenCalledWith('host-1', {
      nativeSessionId: 'captured-native',
      recovery: { executable: 'codex', args: ['resume', 'captured-native'] },
    })
  })
})
