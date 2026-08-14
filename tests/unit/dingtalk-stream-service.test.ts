import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  callback: undefined as ((message: unknown) => void) | undefined,
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  registerCallbackListener: vi.fn((_topic: string, callback: (message: unknown) => void) => { sdk.callback = callback }),
  registerAllEventListener: vi.fn(),
  on: vi.fn(),
}))

vi.mock('dingtalk-stream', () => ({
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
  DWClient: class {
    connect = sdk.connect
    disconnect = sdk.disconnect
    registerCallbackListener = sdk.registerCallbackListener
    registerAllEventListener = sdk.registerAllEventListener
    on = sdk.on
  },
}))

import { DingTalkStreamService } from '../../electron/dingtalk-stream-service'

describe('DingTalkStreamService', () => {
  beforeEach(() => { vi.clearAllMocks(); sdk.callback = undefined })

  it('subscribes robot messages as CALLBACK before connecting', async () => {
    const router = { execute: vi.fn(async () => 'ok') }
    const service = new DingTalkStreamService(router as never)
    await service.restart({ enabled: true, clientId: 'id', clientSecret: 'secret', allowedWorkspaces: ['B:/work'], commandsPerMinute: 20, bindingKey: 'key', agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897 })

    expect(sdk.registerCallbackListener).toHaveBeenCalledWith('/v1.0/im/bot/messages/get', expect.any(Function))
    expect(sdk.registerAllEventListener).not.toHaveBeenCalled()
    expect(sdk.registerCallbackListener.mock.invocationCallOrder[0]).toBeLessThan(sdk.connect.mock.invocationCallOrder[0]!)
  })
})
