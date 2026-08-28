import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  callback: undefined as ((message: unknown) => void) | undefined,
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  registerCallbackListener: vi.fn((_topic: string, callback: (message: unknown) => void) => { sdk.callback = callback }),
  registerAllEventListener: vi.fn(),
  on: vi.fn(),
  client: undefined as { connected: boolean; config: { autoReconnect?: boolean } } | undefined,
}))

vi.mock('dingtalk-stream', () => ({
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
  DWClient: class {
    connected = false
    config = { autoReconnect: true }
    registerCallbackListener = sdk.registerCallbackListener
    registerAllEventListener = sdk.registerAllEventListener
    on = sdk.on

    constructor() {
      sdk.client = this
    }

    async connect(): Promise<void> {
      await sdk.connect()
      this.connected = true
    }

    disconnect(): void {
      this.connected = false
      sdk.disconnect()
    }
  },
}))

import { DingTalkStreamService, isDingTalkWorkspaceAllowed } from '../../electron/dingtalk-stream-service'

describe('DingTalkStreamService', () => {
  beforeEach(() => { vi.clearAllMocks(); sdk.callback = undefined; sdk.client = undefined })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('subscribes robot messages as CALLBACK before connecting', async () => {
    const router = { execute: vi.fn(async () => 'ok') }
    const service = new DingTalkStreamService(router as never)
    await service.restart({ enabled: true, clientId: 'id', clientSecret: 'secret', allowedWorkspaces: ['B:/work'], commandsPerMinute: 20, bindingKey: 'key', agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897 })

    expect(sdk.registerCallbackListener).toHaveBeenCalledWith('/v1.0/im/bot/messages/get', expect.any(Function))
    expect(sdk.registerAllEventListener).not.toHaveBeenCalled()
    expect(sdk.registerCallbackListener.mock.invocationCallOrder[0]).toBeLessThan(sdk.connect.mock.invocationCallOrder[0]!)
  })

  it('deduplicates offline errors and reconnects after the network recovers', async () => {
    vi.useFakeTimers()
    let online = false
    const activity = { connected: vi.fn(), disconnected: vi.fn(), error: vi.fn(), message: vi.fn() }
    const service = new DingTalkStreamService({ execute: vi.fn() } as never, activity, () => online)
    await service.restart({
      enabled: true, clientId: 'id', clientSecret: 'secret', allowedWorkspaces: [], commandsPerMinute: 20, bindingKey: 'key', agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897,
    })

    expect(service.getStatus()).toEqual({
      connectionStatus: 'error',
      connectionError: '钉钉 Stream 暂时离线，网络恢复后会自动重连',
    })
    expect(sdk.connect).not.toHaveBeenCalled()
    expect(sdk.client?.config.autoReconnect).toBe(false)

    await vi.advanceTimersByTimeAsync(9_000)
    expect(activity.disconnected).toHaveBeenCalledTimes(1)
    expect(sdk.connect).not.toHaveBeenCalled()

    online = true
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(service.getStatus()).toEqual({ connectionStatus: 'connected' })
    expect(activity.connected).toHaveBeenCalledTimes(1)
    service.stop()
  })

  it('pushes each allowed approval to the bound DingTalk account only once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const service = new DingTalkStreamService({ execute: vi.fn() } as never)
    const settings = { enabled: true, clientId: 'app-key', clientSecret: 'secret', allowedWorkspaces: ['B:/work'], commandsPerMinute: 20, boundStaffId: 'staff-1', agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897 }
    const request = { requestId: 'approval-1', sessionId: 'session-12345678', displayName: 'Code Agent', agentKind: 'codex', workspace: 'B:/work', source: 'terminal', risk: 'write', toolName: 'Edit', reason: '需要修改文件', command: 'Set-Content app.ts value', createdAt: 1, canBulkApprove: true }

    await expect(service.notifyApproval(request as never, settings)).resolves.toBe(true)
    await expect(service.notifyApproval(request as never, settings)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.dingtalk.com/v1.0/oauth2/accessToken', expect.any(Object))
    const sendOptions = fetchMock.mock.calls[1]![1] as { body: string }
    const payload = JSON.parse(sendOptions.body)
    expect(payload).toMatchObject({ robotCode: 'app-key', userIds: ['staff-1'], msgKey: 'sampleText' })
    expect(JSON.parse(payload.msgParam).content).toContain('/approve approval-1')
  })

  it('treats a newly discovered workspace as allowed until the user saves an opt-out', async () => {
    const settings = {
      enabled: true, clientId: 'app-key', clientSecret: 'secret',
      allowedWorkspaces: ['B:/work'], knownWorkspaces: ['B:/work'],
      commandsPerMinute: 20, boundStaffId: 'staff-1', agentModeEnabled: false,
      agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897,
    }

    expect(isDingTalkWorkspaceAllowed(settings, 'A:\\淘宝直播')).toBe(true)
    expect(isDingTalkWorkspaceAllowed({ ...settings, knownWorkspaces: ['B:/work', 'A:/淘宝直播'] }, 'A:\\淘宝直播')).toBe(false)
    expect(isDingTalkWorkspaceAllowed({ ...settings, knownWorkspaces: [] }, 'A:\\淘宝直播')).toBe(true)
  })
})
