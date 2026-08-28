import { describe, expect, it, vi } from 'vitest'

import { SessionController, type NativeSessionDiscoveryPort, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostEvent } from '../../src/shared/protocol'
import type { StartSessionRequest } from '../../src/shared/manager-api'
import type { HostHandle, HostRecord, StartHostOptions } from '../../electron/session-host-manager'
import { ApprovalPolicyEngine } from '../../electron/approval-policy'

class FakeHandle implements HostHandle {
  readonly writes: string[] = []
  readonly permissionResponses: Array<{ requestId: string; action: 'allow' | 'ask' | 'deny' }> = []
  permissionHook?: 'claude' | 'codex'
  stops = 0
  disconnects = 0
  preserveOnDisconnect = vi.fn(async (): Promise<void> => undefined)
  resumeManagement = vi.fn()
  updateManagerLeasePolicy = vi.fn()
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
  ping = vi.fn(async (): Promise<'managed'> => 'managed')
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
  async replay(): Promise<string> { return '' }
  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny'): void {
    this.permissionResponses.push({ requestId, action })
  }
  async stop(): Promise<void> { this.stops += 1 }
  disconnect(): void { this.disconnects += 1 }
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
    release: vi.fn(async () => undefined),
    forceRelease: vi.fn(async () => undefined),
    setPreserveOnLeaseExpiry: vi.fn(),
    readLastExit: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async () => undefined),
    removeArtifacts: vi.fn(async () => undefined),
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
  it('renames a managed Agent without restarting its Host and persists the display name', async () => {
    const { controller, manager, starts } = fixture()
    const session = await controller.startSession(request())
    await controller.renameSession(session.sessionId, 'Renamed Agent')

    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.displayName).toBe('Renamed Agent')
    expect(manager.updateMetadata).toHaveBeenCalledWith('host-1', { displayName: 'Renamed Agent' })
    expect(starts).toHaveLength(1)
  })

  it('only reports a resumed native Agent ready after a real prompt or approval arrives', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession({ ...request(true), nativeSessionId: 'native-1' })
    expect(controller.isSessionReady(session.sessionId)).toBe(false)

    handles[0]!.emit({ type: 'output', data: 'loading history…' })
    await settle()
    expect(controller.isSessionReady(session.sessionId)).toBe(false)

    handles[0]!.emit({ type: 'output', data: 'OpenAI Codex\r\n›\r\n' })
    await settle()
    expect(controller.isSessionReady(session.sessionId)).toBe(true)
  })

  it('treats a restored Agent approval prompt as interactive readiness', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession({ ...request(true), nativeSessionId: 'native-1' })
    handles[0]!.emit({ type: 'output', data: 'OpenAI Codex\r\nWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No' })
    await settle()

    expect(controller.isSessionReady(session.sessionId)).toBe(true)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')
  })

  it('publishes the official DeepSeek Harness URL and clears it before restart', async () => {
    const { controller, handles, manager } = fixture()
    const session = await controller.startSession({
      ...request(true),
      agentKind: 'deepseek',
      executable: 'dsh',
      args: ['web', '--host', '127.0.0.1', '--port', '0'],
      recovery: { executable: 'dsh', args: ['web', '--host', '127.0.0.1', '--port', '0'] },
    })
    handles[0]!.emit({ type: 'output', data: 'dsh web: http://127.0.0.1:43127\r\n' })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.webUrl).toBe('http://127.0.0.1:43127')

    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-14T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    await controller.restartSession(session.sessionId)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.webUrl).toBeUndefined()
  })

  it('updates an Agent configuration without restarting its Host', async () => {
    const { controller, manager, starts } = fixture()
    const session = await controller.startSession(request())
    const config = {
      enabled: true as const,
      source: 'custom' as const,
      profileId: 'profile-1',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-x',
      extraArgs: ['--feature'],
      hasApiKey: true,
    }
    await controller.updateSessionConfig(session.sessionId, config)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.agentConfig).toEqual(config)
    expect(manager.updateMetadata).toHaveBeenCalledWith('host-1', { agentConfig: config })
    expect(starts).toHaveLength(1)
  })

  it('surfaces a live model-capacity error without automatically sending continue', async () => {
    vi.useFakeTimers()
    try {
      const { controller, handles } = fixture()
      const session = await controller.startSession(request(true))
      handles[0]!.emit({ type: 'output', data: 'Selected model is at capacity. Please try a different model.' })
      await vi.advanceTimersByTimeAsync(0)

      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({
        status: 'running',
        recoveryAttempts: 0,
      })
      expect(handles[0]!.writes).toEqual([])

      await vi.advanceTimersByTimeAsync(10_000)
      expect(handles[0]!.writes).toEqual([])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores historical capacity text while an explicitly restored native session loads', async () => {
    vi.useFakeTimers()
    try {
      const { controller, handles } = fixture()
      const session = await controller.startSession({
        ...request(true),
        args: ['resume', 'native-1'],
        nativeSessionId: 'native-1',
      })
      handles[0]!.emit({
        type: 'output',
        data: 'Selected model is at capacity. Please try a different model.\r\nOpenAI Codex\r\n›\r\n',
      })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(handles[0]!.writes).toEqual([])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({
        status: 'running',
        recoveryAttempts: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['\x03', '\x1b'])('cancels a pending capacity retry after user input %j', async (input) => {
    vi.useFakeTimers()
    try {
      const { controller, handles } = fixture()
      const session = await controller.startSession(request(true))
      handles[0]!.emit({ type: 'output', data: 'Selected model is at capacity. Please try a different model.' })
      await vi.advanceTimersByTimeAsync(0)
      controller.write(session.sessionId, input)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(handles[0]!.writes).toEqual([input])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never loops automatic continue for repeated live capacity errors', async () => {
    vi.useFakeTimers()
    try {
      const { controller, handles } = fixture()
      const session = await controller.startSession(request(true))
      for (const delay of [3_075, 3_075, 3_075]) {
        handles[0]!.emit({ type: 'output', data: 'Selected model is at capacity. Please try a different model.' })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(delay)
      }
      handles[0]!.emit({ type: 'output', data: 'Selected model is at capacity. Please try a different model.' })
      await vi.advanceTimersByTimeAsync(0)

      expect(handles[0]!.writes).toEqual([])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({
        status: 'running',
        recoveryAttempts: 0,
      })
      expect(handles[0]!.stops).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it('keeps an explicit stop stopped even when the process reports exit 0', async () => {
    const { controller, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
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

  it('surfaces abnormal exit and waits for an explicit one-shot recovery', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.emit({ type: 'exit', exitCode: 1 })
    await settle()

    expect(starts).toHaveLength(1)
    expect(handles[0]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_attention')
  })

  it('allows user stop while an abnormal exit is awaiting attention', async () => {
    const { controller, handles, starts } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.emit({ type: 'exit', exitCode: 1 })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_attention')

    await controller.stopSession(session.sessionId)
    expect(starts).toHaveLength(1)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('stopped')
  })

  it('surfaces a non-user connection loss when no exit fact appears', async () => {
    const { controller, handles, starts } = fixture()
    await controller.startSession(request(true))
    handles[0]!.fail(new Error('pipe closed'))
    await settle()
    await settle()
    expect(starts).toHaveLength(1)
    expect(controller.listSessions()[0]).toMatchObject({ status: 'needs_attention', recoveryAction: 'resume' })
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

  it('restores persisted agent recovery metadata and surfaces a later crash', async () => {
    const { controller, handles, starts, manager } = fixture()
    const restoredHandle = new FakeHandle('restored-host')
    vi.mocked(manager.listLiveHosts).mockResolvedValue([{
      hostId: 'restored-host', agentKind: 'claude', cwd: 'B:\\work', nativeSessionId: 'claude-native',
      pid: 42, endpoint: 'pipe', lifecycle: 'running', createdAt: 'now', updatedAt: 'now', cols: 90, rows: 28,
      recovery: { executable: 'claude', args: ['--resume', 'claude-native'] },
      managerOwnership: 'preserved',
    }])
    vi.mocked(manager.reconnect).mockResolvedValue(restoredHandle)
    await controller.restoreLiveHosts()
    expect(controller.listSessions()[0]).toMatchObject({ agentKind: 'claude', nativeSessionId: 'claude-native' })

    restoredHandle.emit({ type: 'exit', exitCode: 1 })
    await settle()
    expect(starts).toHaveLength(0)
    expect(restoredHandle.writes).toEqual([])
    expect(controller.listSessions()[0]).toMatchObject({ status: 'needs_attention', recoveryAction: 'resume' })
  })

  it('projects an explicit approval prompt into the session summary', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession(request())
    handles[0]!.emit({ type: 'output', data: 'Would you like to run the following command?\r\n1. Yes, proceed\r\n2. No' })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')

    controller.write(session.sessionId, '\r')
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('approves only a session with explicit approval evidence', async () => {
    const { controller, handles } = fixture()
    const session = await controller.startSession(request())
    expect(() => controller.approveSession(session.sessionId)).toThrow(/没有等待处理的授权请求/)

    handles[0]!.emit({ type: 'output', data: 'Approval required\r\n1. Yes, proceed\r\n2. No' })
    await settle()
    controller.approveSession(session.sessionId)
    expect(handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    expect(() => controller.approveSession(session.sessionId)).toThrow(/没有等待处理的授权请求/)
  })

  it('auto-approves only a recognized command allowed by policy', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession(request())
    base.handles[0]!.emit({ type: 'output', data: '$ git status --short\r\nWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No' })
    await settle()
    expect(base.handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')

    base.handles[0]!.emit({ type: 'output', data: 'command completed' })
    await settle()
    base.handles[0]!.emit({ type: 'output', data: '$ Remove-Item -Recurse build\r\nWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No' })
    await settle()
    expect(base.handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')
  })

  it('keeps a silent Agent running while its Host answers health probes', async () => {
    const { controller, handles } = fixture()
    await controller.startSession(request(true))
    handles[0]!.fail(new Error('Timed out waiting for host event from host host-1'))
    await settle()
    expect(handles[0]!.ping).toHaveBeenCalled()
    expect(controller.listSessions()[0]).toMatchObject({ status: 'running' })
  })

  it('asks before restarting after three consecutive Host probe failures', async () => {
    const { controller, handles, starts } = fixture()
    await controller.startSession(request(true))
    handles[0]!.ping.mockRejectedValue(new Error('pong timeout'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      handles[0]!.fail(new Error('Timed out waiting for host event from host host-1'))
      await settle()
    }
    expect(starts).toHaveLength(1)
    expect(handles[0]!.writes).toEqual([])
    expect(controller.listSessions()[0]).toMatchObject({
      status: 'needs_attention',
      attentionKind: 'host-unresponsive',
      lastError: '终端进程连续无响应',
    })
  })

  it('releases only the unresponsive managed Host after the user confirms restart', async () => {
    const { controller, handles, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    handles[0]!.ping.mockRejectedValue(new Error('pong timeout'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      handles[0]!.fail(new Error('Timed out waiting for host event from host host-1'))
      await settle()
    }
    await controller.tryRecoveryOnce(session.sessionId)
    expect(manager.forceRelease).toHaveBeenCalledWith('host-1')
    expect(starts).toHaveLength(2)
    expect(controller.listSessions()[0]).toMatchObject({ status: 'running' })
    expect(controller.listSessions()[0]!.attentionKind).toBeUndefined()
  })

  it('takes over a live Host after an abnormal Manager exit when crash retention is enabled', async () => {
    const { controller, manager } = fixture()
    const restoredHandle = new FakeHandle('managed-host')
    vi.mocked(manager.listLiveHosts).mockResolvedValue([{
      hostId: 'managed-host', sessionId: 'session-1', displayName: 'Still running', agentKind: 'codex', cwd: 'B:\\work',
      pid: 42, endpoint: 'pipe', lifecycle: 'running', createdAt: 'now', updatedAt: 'now', managerOwnership: 'managed',
    }])
    vi.mocked(manager.reconnect).mockResolvedValue(restoredHandle)

    await controller.restoreSessions(true)

    expect(manager.reconnect).toHaveBeenCalledWith('managed-host')
    expect(manager.release).not.toHaveBeenCalled()
    expect(controller.listSessions()[0]).toMatchObject({ sessionId: 'session-1', displayName: 'Still running', status: 'running' })
  })

  it('releases a live Host after an abnormal Manager exit when crash retention is disabled', async () => {
    const { controller, manager } = fixture()
    manager.release = vi.fn(async () => undefined)
    vi.mocked(manager.listLiveHosts).mockResolvedValue([{
      hostId: 'managed-host', sessionId: 'session-1', agentKind: 'codex', cwd: 'B:\\work',
      pid: 42, endpoint: 'pipe', lifecycle: 'running', createdAt: 'now', updatedAt: 'now', managerOwnership: 'managed',
    }])

    await controller.restoreSessions(false)

    expect(manager.release).toHaveBeenCalledWith('managed-host')
    expect(manager.reconnect).not.toHaveBeenCalled()
  })

  it('updates the lease policy of all currently running Hosts', async () => {
    const { controller, handles, manager } = fixture()
    await controller.startSession(request())

    controller.updateCrashRetentionPolicy(false)

    expect(manager.setPreserveOnLeaseExpiry).toHaveBeenCalledWith(false)
    expect(handles[0]!.updateManagerLeasePolicy).toHaveBeenCalledWith(false)
  })

  it('waits for the complete Codex modal command instead of classifying a truncated OSC signal', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession(request())
    base.handles[0]!.emit({ type: 'output', data: '\x1b]9;Approval requested: git status --short\x07' })
    await settle()
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')

    base.handles[0]!.emit({ type: 'output', data: 'Would you like to run the following command?\r\n$ git status --short\r\n1. Yes, proceed (y)' })
    await settle()
    expect(base.handles[0]!.writes).toEqual(['\r'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('uses structured Claude permission events for automatic Read approval', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'read-1', toolName: 'Read' })
    await settle()
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'read-1', action: 'allow' }])
    expect(base.handles[0]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('uses Codex PermissionRequest payloads without terminal input', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession(request())
    base.handles[0]!.permissionHook = 'codex'
    base.handles[0]!.emit({
      type: 'permission-request',
      hookSource: 'codex',
      requestId: 'codex-shell-1',
      toolName: 'Shell',
      command: 'Set-Content package.json updated',
      operation: 'write',
      nativeSessionId: 'thread-1',
      turnId: 'turn-1',
      cwd: 'B:\\work',
      model: 'gpt-5.6',
      permissionMode: 'on-request',
      transcriptPath: 'C:\\codex\\rollout.jsonl',
      toolInput: { command: 'Set-Content package.json updated' },
      rawPayload: { hook_event_name: 'PermissionRequest', turn_id: 'turn-1' },
    })
    await settle()

    expect(controller.listPendingApprovals()).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        source: 'codex-hook',
        requestId: 'codex-shell-1',
        nativeTurnId: 'turn-1',
        hookCwd: 'B:\\work',
        hookModel: 'gpt-5.6',
        permissionMode: 'on-request',
        toolInput: { command: 'Set-Content package.json updated' },
      }),
    ])
    controller.approveRequest('codex-shell-1')
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'codex-shell-1', action: 'allow' }])
    expect(base.handles[0]!.writes).toEqual([])
  })

  it('falls back to a complete Codex command prompt when its Hook does not arrive', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession(request())
      base.handles[0]!.permissionHook = 'codex'
      base.handles[0]!.emit({
        type: 'output',
        data: [
          '• Running git apply --recount --ignore-space-change --ignore-whitespace .rc2-governance-v2.patch',
          'Would you like to run the following command?',
          'Environment: local',
          'Reason: 是否允许我在沙箱外应用同一份 RC2 治理补丁，并兼容现有文档的 CRLF 行尾？',
          '$ git apply --recount --ignore-space-change --ignore-whitespace .rc2-governance-v2.patch',
          '› 1. Yes, proceed (y)',
          '2. Yes, and don\'t ask again',
          '3. No, and tell Codex what to do differently (esc)',
        ].join('\r\n'),
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(controller.listPendingApprovals()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(controller.listPendingApprovals()).toEqual([
        expect.objectContaining({
          source: 'terminal',
          command: 'git apply --recount --ignore-space-change --ignore-whitespace .rc2-governance-v2.patch',
          agentReason: '是否允许我在沙箱外应用同一份 RC2 治理补丁，并兼容现有文档的 CRLF 行尾？',
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the Codex terminal fallback when the structured Hook arrives', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession(request())
      base.handles[0]!.permissionHook = 'codex'
      base.handles[0]!.emit({
        type: 'output',
        data: '$ git apply fix.patch\r\nWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(500)
      base.handles[0]!.emit({
        type: 'permission-request', requestId: 'codex-hook-wins', hookSource: 'codex',
        toolName: 'Shell', command: 'git apply fix.patch', operation: 'write',
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(controller.listPendingApprovals()).toEqual([
        expect.objectContaining({ requestId: 'codex-hook-wins', source: 'codex-hook', command: 'git apply fix.patch' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat Claude subagent repaint text as approval when its Hook is active', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.permissionHook = 'claude'
      base.handles[0]!.emit({
        type: 'output',
        data: 'Subagent tool call: Bash git status\r\nAllow this tool use?\r\n1. Yes\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(5_000)

      expect(controller.listPendingApprovals()).toEqual([])
      expect(base.handles[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back for a real Claude forwarded subagent permission prompt when its Hook is active', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.permissionHook = 'claude'
      base.handles[0]!.emit({
        type: 'output',
        data: [
          'Write file · from the Explore agent',
          'Write(F:\\puwo\\native-api\\MigrationReview.md)',
          'Do you want to proceed?',
          '❯ 1. Yes',
          '2. Yes, allow reading during this session',
          '3. No',
        ].join('\r\n'),
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(controller.listPendingApprovals()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(controller.listPendingApprovals()).toEqual([
        expect.objectContaining({ source: 'terminal', command: 'tool:Write' }),
      ])
      expect(base.handles[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-approves a real Claude forwarded subagent prompt once without repaint duplicates', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const activity = { approved: vi.fn(), blocked: vi.fn() }
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity)
      const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.permissionHook = 'claude'
      await controller.setFullAutoMode(session.sessionId, true)
      const prompt = [
        'Read file · from the Explore agent',
        'Read(F:\\puwo\\native-api\\FoshanBillService.cs · lines 340-549)',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '2. Yes, allow reading during this session',
        '3. No',
      ].join('\r\n')

      base.handles[0]!.emit({ type: 'output', data: prompt })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(base.handles[0]!.writes).toEqual(['\r'])
      expect(activity.approved).not.toHaveBeenCalled()

      base.handles[0]!.emit({ type: 'output', data: prompt })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(base.handles[0]!.writes).toEqual(['\r'])
      expect(activity.approved).not.toHaveBeenCalled()
      expect(controller.listPendingApprovals()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a forwarded Claude terminal fallback when a structured Hook arrives', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.permissionHook = 'claude'
      base.handles[0]!.emit({
        type: 'output',
        data: [
          'Write file · from the Explore agent',
          'Write(F:\\puwo\\native-api\\MigrationReview.md)',
          'Do you want to proceed?',
          '❯ 1. Yes',
          '2. Yes, allow writing during this session',
          '3. No',
        ].join('\r\n'),
      })
      await vi.advanceTimersByTimeAsync(500)
      base.handles[0]!.emit({
        type: 'permission-request', requestId: 'forwarded-hook-wins', hookSource: 'claude',
        toolName: 'Write', operation: 'write', agentId: 'subagent-1', agentType: 'Explore',
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(controller.listPendingApprovals()).toEqual([
        expect.objectContaining({ requestId: 'forwarded-hook-wins', source: 'claude-hook', command: 'tool:Write' }),
      ])
      expect(base.handles[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges an exact main/subagent Claude Hook clone even when tool-use IDs differ', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    const fingerprint = 'a'.repeat(64)
    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'claude-main-1', hookSource: 'claude',
      toolName: 'PowerShell', command: 'Set-Content package.json updated', operation: 'write',
      toolUseId: 'tool-main-1', toolInputFingerprint: fingerprint,
    })
    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'claude-child-1', hookSource: 'claude',
      toolName: 'PowerShell', command: 'Set-Content package.json updated', operation: 'write',
      toolUseId: 'tool-child-1', toolInputFingerprint: fingerprint,
      agentId: 'subagent-1', agentType: 'Explore',
    })
    await settle()

    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['claude-main-1'])
    controller.approveRequest('claude-main-1')
    expect(base.handles[0]!.permissionResponses).toEqual([
      { requestId: 'claude-main-1', action: 'allow' },
      { requestId: 'claude-child-1', action: 'allow' },
    ])
  })

  it('lets a structured Claude Hook replace an earlier terminal-text candidate', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.emit({
        type: 'output',
        data: 'Write file\r\nAllow this tool use?\r\n1. Yes\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.listPendingApprovals()).toEqual([])

      await vi.advanceTimersByTimeAsync(300)
      base.handles[0]!.emit({
        type: 'permission-request', requestId: 'hook-command-1', toolName: 'PowerShell',
        command: 'Set-Content package.json updated', operation: 'write',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['hook-command-1'])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['hook-command-1'])
      controller.approveRequest('hook-command-1')
      expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'hook-command-1', action: 'allow' }])
      expect(base.handles[0]!.writes).toEqual([])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')

      base.handles[0]!.emit({
        type: 'output',
        data: 'Write file\r\nAllow this tool use?\r\n1. Yes\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(controller.listPendingApprovals()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes a structured Claude Hook when the user approves with Enter in the terminal', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'hook-terminal-enter', toolName: 'Write', operation: 'write',
    })
    await settle()
    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['hook-terminal-enter'])

    controller.write(session.sessionId, '\r')

    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'hook-terminal-enter', action: 'allow' }])
    expect(base.handles[0]!.writes).toEqual([])
    expect(controller.listPendingApprovals()).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('falls back to Claude terminal approval only when no Hook arrives', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
      await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      base.handles[0]!.emit({
        type: 'output',
        data: 'Write file\r\nAllow this tool use?\r\n1. Yes\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(controller.listPendingApprovals()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(controller.listPendingApprovals()).toHaveLength(1)
      expect(controller.listPendingApprovals()[0]).toMatchObject({ source: 'terminal', command: 'tool:Write' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-approves a Claude Hook once without also pressing Enter through terminal fallback', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const activity = { approved: vi.fn(), blocked: vi.fn() }
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity)
      const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
      await controller.setFullAutoMode(session.sessionId, true)
      base.handles[0]!.emit({ type: 'output', data: 'Bash command\r\n git status\r\nAllow this tool use?\r\n1. Yes' })
      await vi.advanceTimersByTimeAsync(250)
      base.handles[0]!.emit({
        type: 'permission-request', requestId: 'hook-auto-1', toolName: 'PowerShell',
        command: 'Set-Content package.json updated', operation: 'write',
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'hook-auto-1', action: 'allow' }])
      expect(base.handles[0]!.writes).toEqual([])
      expect(activity.approved).toHaveBeenCalledTimes(1)
      expect(controller.listPendingApprovals()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the complete Claude Bash command to auto-approve a read-only ls request', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    base.handles[0]!.emit({
      type: 'permission-request',
      requestId: 'bash-ls-1',
      toolName: 'Bash',
      command: 'ls -la',
      operation: 'unknown',
      toolInputSummary: 'ls -la',
    })
    await settle()
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'bash-ls-1', action: 'allow' }])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('keeps multiple structured tool approvals independently addressable', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    base.handles[0]!.emit({
      type: 'permission-request',
      requestId: 'edit-1',
      toolName: 'Edit',
      operation: 'write',
      filePath: 'B:/workspace/src/App.tsx',
      toolInputSummary: 'B:/workspace/src/App.tsx',
    })
    await settle()
    expect(base.handles[0]!.permissionResponses).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({
      status: 'needs_approval',
      pendingApprovalCommand: 'tool:Edit',
      approvalRisk: 'write',
      approvalToolName: 'Edit',
      approvalFilePath: 'B:/workspace/src/App.tsx',
      approvalInputSummary: 'B:/workspace/src/App.tsx',
    })
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'write-2', toolName: 'Write' })
    await settle()
    expect(controller.listPendingApprovals().map((request) => request.requestId)).toEqual(['edit-1', 'write-2'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({ status: 'needs_approval', pendingApprovalCount: 2 })

    controller.approveRequest('edit-1')
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'edit-1', action: 'allow' }])
    expect(controller.listPendingApprovals().map((request) => request.requestId)).toEqual(['write-2'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({ status: 'needs_approval', pendingApprovalCommand: 'tool:Write', pendingApprovalCount: 1 })

    controller.rejectRequest('write-2')
    expect(base.handles[0]!.permissionResponses.at(-1)).toEqual({ requestId: 'write-2', action: 'deny' })
    expect(controller.listPendingApprovals()).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it('keeps approvals from two Agents in one global queue without cross-clearing', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const first = await controller.startSession({ ...request(), displayName: 'Claude A', agentKind: 'claude', executable: 'claude' })
    const second = await controller.startSession({ ...request(), displayName: 'Claude B', agentKind: 'claude', executable: 'claude' })

    base.handles[0]!.emit({ type: 'permission-request', requestId: 'agent-a-write', toolName: 'Write', operation: 'write' })
    base.handles[1]!.emit({ type: 'permission-request', requestId: 'agent-b-edit', toolName: 'Edit', operation: 'write' })
    await settle()

    expect(controller.listPendingApprovals().map((item) => [item.requestId, item.sessionId])).toEqual([
      ['agent-a-write', first.sessionId],
      ['agent-b-edit', second.sessionId],
    ])
    controller.approveRequest('agent-a-write')
    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['agent-b-edit'])
    expect(controller.listSessions().find((item) => item.sessionId === second.sessionId)?.status).toBe('needs_approval')
  })

  it('bulk-approves ordinary writes and unknown tools but preserves severe commands', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })

    base.handles[0]!.emit({ type: 'permission-request', requestId: 'safe-write', toolName: 'Edit', operation: 'write' })
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'safe-unknown', toolName: 'InspectResource', operation: 'unknown' })
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'danger-delete', toolName: 'Bash', command: 'rm -rf fixtures', operation: 'delete' })
    await settle()

    expect(controller.approveAllPending()).toEqual({
      approved: 2,
      skipped: 1,
      failed: 0,
      skippedRequestIds: ['danger-delete'],
    })
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'safe-write', action: 'allow' }, { requestId: 'safe-unknown', action: 'allow' }])
    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['danger-delete'])
  })

  it('auto-approves an in-workspace edit after full-auto is enabled and preserves deletion requests', async () => {
    const base = fixture()
    const activity = { approved: vi.fn(), blocked: vi.fn() }
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity)
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    await controller.setFullAutoMode(session.sessionId, true)

    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'edit-auto', toolName: 'Edit', operation: 'write',
      filePath: 'B:/work/src/App.tsx', toolInputSummary: 'B:/work/src/App.tsx', reason: '更新界面',
    })
    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'delete-blocked', toolName: 'Bash',
      command: 'rm -rf fixtures', operation: 'delete',
    })
    await settle()

    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'edit-auto', action: 'allow' }])
    expect(activity.approved).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'edit-auto', agentReason: '更新界面' }))
    expect(activity.blocked).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'delete-blocked' }), expect.stringContaining('删除'))
    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['delete-blocked'])
    expect(base.manager.updateMetadata).toHaveBeenCalledWith('host-1', { fullAutoEnabled: true })
  })

  it('auto-approves ordinary Claude tools without a saved rule or target path', async () => {
    const base = fixture()
    const activity = { approved: vi.fn(), blocked: vi.fn() }
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity)
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    await controller.setFullAutoMode(session.sessionId, true)
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'task-auto', toolName: 'Task', operation: 'unknown' })
    base.handles[0]!.emit({ type: 'permission-request', requestId: 'write-auto', toolName: 'Write', operation: 'write' })
    await settle()
    expect(base.handles[0]!.permissionResponses).toEqual([
      { requestId: 'task-auto', action: 'allow' },
      { requestId: 'write-auto', action: 'allow' },
    ])
    expect(controller.listPendingApprovals()).toEqual([])
    expect(activity.approved).toHaveBeenCalledTimes(2)
  })

  it('retries a Codex full-auto Enter once when the approval prompt does not advance', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const activity = { approved: vi.fn(), blocked: vi.fn() }
      const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity)
      const session = await controller.startSession(request())
      await controller.setFullAutoMode(session.sessionId, true)

      base.handles[0]!.emit({
        type: 'output',
        data: '\x1b]9;Approval requested: build\x07Would you like to run the following command?\r\n$ pnpm --dir frontend build\r\n1. Yes, proceed\r\n2. No',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(base.handles[0]!.writes).toEqual(['\r'])
      expect(activity.approved).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(249)
      expect(base.handles[0]!.writes).toEqual(['\r'])
      await vi.advanceTimersByTimeAsync(1)
      expect(base.handles[0]!.writes).toEqual(['\r', '\r'])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(base.handles[0]!.writes).toEqual(['\r', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('immediately processes eligible pending requests when full-auto is enabled', async () => {
    const base = fixture()
    const controller = new SessionController(base.manager, undefined, undefined, new ApprovalPolicyEngine())
    const session = await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })
    base.handles[0]!.emit({
      type: 'permission-request', requestId: 'pending-edit', toolName: 'Edit',
      operation: 'write', filePath: 'B:/work/src/App.tsx',
    })
    await settle()
    expect(controller.listPendingApprovals()).toHaveLength(1)

    await controller.setFullAutoMode(session.sessionId, true)
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'pending-edit', action: 'allow' }])
    expect(controller.listPendingApprovals()).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)).toMatchObject({
      status: 'running', fullAutoEnabled: true,
    })
  })

  it('approves and remembers an explicitly confirmed custom safe tool', async () => {
    const base = fixture()
    const policy = new ApprovalPolicyEngine()
    const controller = new SessionController(base.manager, undefined, undefined, policy)
    await controller.startSession({ ...request(), agentKind: 'claude', executable: 'claude' })

    base.handles[0]!.emit({ type: 'permission-request', requestId: 'inspect-1', toolName: 'InspectResource', operation: 'unknown' })
    await settle()
    expect(controller.listPendingApprovals().map((item) => item.requestId)).toEqual(['inspect-1'])

    await controller.approveAndRememberRequest('inspect-1')
    expect(base.handles[0]!.permissionResponses).toEqual([{ requestId: 'inspect-1', action: 'allow' }])

    base.handles[0]!.emit({ type: 'permission-request', requestId: 'inspect-2', toolName: 'InspectResource', operation: 'unknown' })
    await settle()
    expect(base.handles[0]!.permissionResponses.at(-1)).toEqual({ requestId: 'inspect-2', action: 'allow' })
    expect(controller.listPendingApprovals()).toEqual([])
  })

  it('suggests a read-only command after three manual approvals and accepts the exact rule', async () => {
    const base = fixture()
    const policy = new ApprovalPolicyEngine()
    const decide = vi.spyOn(policy, 'decide')
    const controller = new SessionController(base.manager, undefined, undefined, policy)
    const session = await controller.startSession(request())

    for (let index = 0; index < 3; index += 1) {
      base.handles[0]!.emit({ type: 'output', data: '$ git log --oneline\r\nWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No' })
      await settle()
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('needs_approval')
      expect(decide).toHaveBeenLastCalledWith('git log --oneline')
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.pendingApprovalCommand).toBe('git log --oneline')
      controller.approveSession(session.sessionId)
      base.handles[0]!.emit({ type: 'output', data: 'command completed' })
      await settle()
    }

    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.approvalSuggestion).toEqual({
      command: 'git log --oneline', approvalCount: 3,
    })
    await controller.acceptApprovalSuggestion(session.sessionId)
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.approvalSuggestion).toBeUndefined()
    expect(policy.decide('git log --oneline').action).toBe('auto-approve')
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
      recovery: { executable: 'codex', args: ['--no-alt-screen', 'resume', 'captured-native'] },
    })
  })

  it('manually restarts with native resume but never sends continue', async () => {
    const { controller, handles, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    await controller.restartSession(session.sessionId)

    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ executable: 'codex', args: ['--no-alt-screen', 'resume', 'native-1'] })
    expect(handles[1]!.writes).toEqual([])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    expect(manager.removeArtifacts).toHaveBeenCalledWith('host-1')
  })

  it('sends Continue once only after a configured keyword remains quiet', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['please retry'] }),
        match: (value: string) => value.toLowerCase().includes('please retry') ? 'please retry' : undefined,
        maxKeywordLength: () => 12,
      }
      const activity = { keywordMatched: vi.fn(), keywordContinued: vi.fn() }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy, activity)
      const session = await controller.startSession(request(true))
      base.handles[0]!.emit({ type: 'output', data: 'Temporary condition: please retry' })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(base.handles[0]!.writes).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(base.handles[0]!.writes).toEqual(['continue\r'])
      expect(activity.keywordMatched).toHaveBeenCalledWith(session.sessionId, 'please retry')
      expect(activity.keywordContinued).toHaveBeenCalledWith(session.sessionId, 'please retry')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(base.handles[0]!.writes).toEqual(['continue\r'])
    } finally {
      vi.useRealTimers()
    }
  })


  it('only allows capacity Continue when the user explicitly configures that keyword', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['Selected model is at capacity'] }),
        match: (value: string) => value.toLowerCase().includes('selected model is at capacity') ? 'Selected model is at capacity' : undefined,
        maxKeywordLength: () => 32,
      }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy)
      await controller.startSession(request(true))
      base.handles[0]!.emit({ type: 'output', data: 'Selected model is at capacity. Please try a different model.' })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(base.handles[0]!.writes).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(base.handles[0]!.writes).toEqual(['continue\r'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not start keyword Continue from output repainted immediately after resize', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['exceeded retry limit, last status: 429 too many requests'] }),
        match: (value: string) => value.toLowerCase().includes('exceeded retry limit, last status: 429 too many requests')
          ? 'exceeded retry limit, last status: 429 too many requests' : undefined,
        maxKeywordLength: () => 58,
      }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy)
      const session = await controller.startSession(request(true))

      controller.resize(session.sessionId, 140, 45)
      base.handles[0]!.emit({ type: 'output', data: 'exceeded retry limit, last status: 429 too many requests' })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(base.handles[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not start keyword Continue from a full-screen terminal clear/redraw frame', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['exceeded retry limit, last status: 429 too many requests'] }),
        match: (value: string) => value.toLowerCase().includes('exceeded retry limit, last status: 429 too many requests')
          ? 'exceeded retry limit, last status: 429 too many requests' : undefined,
        maxKeywordLength: () => 58,
      }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy)
      const session = await controller.startSession(request(true))
      controller.resize(session.sessionId, 140, 45)

      // A resize/full-screen repaint may deliver old scrollback through PTY.
      // It must never be treated as fresh progress for Continue rules.
      base.handles[0]!.emit({ type: 'output', data: '\x1b[2J\x1b[Hexceeded retry limit, last status: 429 too many requests' })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(base.handles[0]!.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('cancels keyword Continue when the Agent keeps producing output', async () => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['please retry'] }),
        match: (value: string) => value.toLowerCase().includes('please retry') ? 'please retry' : undefined,
        maxKeywordLength: () => 12,
      }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy)
      const session = await controller.startSession(request(true))
      base.handles[0]!.emit({ type: 'output', data: 'please retry' })
      await vi.advanceTimersByTimeAsync(2_000)
      base.handles[0]!.emit({ type: 'output', data: 'Agent is retrying itself' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(base.handles[0]!.writes).toEqual([])
      expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['\x03', '\x1b'])('cancels keyword Continue after user interrupt %j', async (interrupt) => {
    vi.useFakeTimers()
    try {
      const base = fixture()
      const keywordPolicy = {
        getSettings: () => ({ enabled: true, quietSeconds: 3, keywords: ['please retry'] }),
        match: (value: string) => value.toLowerCase().includes('please retry') ? 'please retry' : undefined,
        maxKeywordLength: () => 12,
      }
      const controller = new SessionController(base.manager, undefined, undefined, undefined, undefined, undefined, keywordPolicy)
      const session = await controller.startSession(request(true))
      base.handles[0]!.emit({ type: 'output', data: 'please retry' })
      await vi.advanceTimersByTimeAsync(1_000)
      controller.write(session.sessionId, interrupt)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(base.handles[0]!.writes).toEqual([interrupt])
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues input during restart and flushes it only to the replacement Host', async () => {
    const { controller, handles, starts, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    let resolveRestart: ((handle: HostHandle) => void) | undefined
    vi.mocked(manager.start).mockImplementationOnce((options) => {
      starts.push(options)
      return new Promise((resolve) => { resolveRestart = resolve })
    })

    const restarting = controller.restartSession(session.sessionId)
    await settle()
    controller.write(session.sessionId, 'queued input')
    expect(handles[0]!.writes).toEqual([])
    const replacement = new FakeHandle('replacement-host')
    resolveRestart?.(replacement)
    await restarting

    expect(replacement.writes).toEqual(['queued input'])
    expect(controller.listSessions().find((item) => item.sessionId === session.sessionId)?.status).toBe('running')
  })

  it.each(['\x03', '\x1b'])('does not replay queued input after restart is interrupted with %j', async (interrupt) => {
    const { controller, manager } = fixture()
    const session = await controller.startSession(request(true))
    vi.mocked(manager.readLastExit).mockResolvedValue({ hostId: 'host-1', exitCode: 0, exitedAt: '2026-08-09T00:00:00.000Z' })
    await controller.stopSession(session.sessionId)
    let resolveRestart: ((handle: HostHandle) => void) | undefined
    vi.mocked(manager.start).mockImplementationOnce(() => new Promise((resolve) => { resolveRestart = resolve }))

    const restarting = controller.restartSession(session.sessionId)
    await settle()
    controller.write(session.sessionId, 'do not replay')
    controller.write(session.sessionId, interrupt)
    const replacement = new FakeHandle('replacement-host')
    resolveRestart?.(replacement)
    await restarting

    expect(replacement.writes).toEqual([])
  })

  it('removes only a completed Manager entry and its host artifacts', async () => {
    const { controller, handles, manager } = fixture()
    const session = await controller.startSession(request())
    handles[0]!.emit({ type: 'exit', exitCode: 0 })
    await settle()
    await controller.removeSession(session.sessionId)

    expect(controller.listSessions()).toEqual([])
    expect(manager.removeArtifacts).toHaveBeenCalledWith('host-1')
  })

  it('disconnects no Agent until every running Host confirms preserved state', async () => {
    const { controller, handles } = fixture()
    await controller.startSession(request())
    await controller.startSession({ ...request(), displayName: 'Second Agent' })
    let confirmFirst: (() => void) | undefined
    let confirmSecond: (() => void) | undefined
    handles[0]!.preserveOnDisconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { confirmFirst = resolve }))
    handles[1]!.preserveOnDisconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { confirmSecond = resolve }))

    const preserving = controller.preserveAllSessions()
    await settle()
    expect(handles.map((handle) => handle.disconnects)).toEqual([0, 0])
    confirmFirst?.()
    await settle()
    expect(handles.map((handle) => handle.disconnects)).toEqual([0, 0])
    confirmSecond?.()
    await expect(preserving).resolves.toBe(2)
    expect(handles.map((handle) => handle.disconnects)).toEqual([1, 1])
  })
})
