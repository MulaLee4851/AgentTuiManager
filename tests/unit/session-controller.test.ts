import { describe, expect, it, vi } from 'vitest'

import { SessionController, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostEvent } from '../../src/shared/protocol'
import type { StartSessionRequest } from '../../src/shared/manager-api'
import type { HostHandle, HostRecord, StartHostOptions } from '../../electron/session-host-manager'

class FakeHandle implements HostHandle {
  readonly writes: string[] = []
  readonly hostId: string
  private readonly events: HostEvent[] = []
  private readonly waiters: Array<(event: HostEvent) => void> = []

  constructor(hostId: string) { this.hostId = hostId }
  nextEvent(): Promise<HostEvent> {
    const event = this.events.shift()
    if (event) return Promise.resolve(event)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  emit(event: HostEvent): void { this.waiters.shift()?.(event) ?? this.events.push(event) }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  async stop(): Promise<void> {}
  disconnect(): void {}
}

function fixture() {
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
    readLastExit: vi.fn(),
  }
  return { controller: new SessionController(manager), handles, starts }
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

  it.each(['\x03', '\x1b'])('treats %j followed by non-zero exit as a user stop', async (input) => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    controller.write(session.sessionId, input)
    handles[0]!.emit({ type: 'exit', exitCode: 130 })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
    expect(starts).toHaveLength(1)
  })

  it('starts the resume host only after abnormal exit and continues only after first output', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.emit({ type: 'exit', exitCode: 1 })
    await settle()

    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ executable: 'codex', args: ['resume', 'native-1'] })
    expect(handles[1]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('recovering')

    handles[1]!.emit({ type: 'output', data: 'codex ready' })
    await settle()
    expect(handles[1]!.writes).toEqual(['continue\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })
})
