import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../../src/shared/manager-api'

const mocks = vi.hoisted(() => ({ windows: [] as any[], openExternal: vi.fn(async () => undefined), fail: false }))
vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      session: Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      }),
    })
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = () => false
    isDestroyed = () => this.destroyed
    loadURL = vi.fn(async () => { if (mocks.fail) throw new Error('failed secret-token') })
    destroy = () => { this.destroyed = true; this.emit('closed') }
    constructor(public options: unknown) { super(); mocks.windows.push(this) }
  },
}))
import { DeepSeekWebWindows, managedDeepSeekUrl } from '../../electron/deepseek-web-window'

const session: SessionSummary = {
  sessionId: 'dsh-1', displayName: 'DSH demo', agentKind: 'deepseek', workspace: 'demo',
  status: 'running', activity: 'running', recoveryAttempts: 0, userStopRequested: false,
  webUrl: 'http://127.0.0.1:43127/?token=fixture-token',
}
beforeEach(() => { mocks.windows.length = 0; mocks.fail = false; mocks.openExternal.mockClear() })

it('opens authenticated URL in an isolated top-level window and reuses it', async () => {
  const manager = new DeepSeekWebWindows()
  await manager.open(session, {} as any)
  await manager.open(session, {} as any)
  expect(mocks.windows).toHaveLength(1)
  const window = mocks.windows[0]
  expect(window.loadURL).toHaveBeenCalledWith(session.webUrl)
  expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
  expect(window.options.webPreferences.preload).toBeUndefined()
  expect(window.options.webPreferences.partition).not.toMatch(/^persist:/)
  expect(window.focus).toHaveBeenCalledOnce()
})

it('isolates agents and closes stale windows on stop, removal and URL change', async () => {
  const manager = new DeepSeekWebWindows()
  await manager.open(session, {} as any)
  await manager.open({ ...session, sessionId: 'dsh-2' }, {} as any)
  expect(mocks.windows[0].options.webPreferences.partition).not.toBe(mocks.windows[1].options.webPreferences.partition)
  manager.sync(session.sessionId, { ...session, status: 'stopped' })
  expect(mocks.windows[0].destroyed).toBe(true)
  expect(mocks.windows[1].destroyed).toBe(false)
  manager.sync('dsh-2', undefined)
  expect(mocks.windows[1].destroyed).toBe(true)
  await manager.open(session, {} as any)
  manager.sync(session.sessionId, { ...session, webUrl: 'http://127.0.0.1:43200/' })
  expect(mocks.windows[2].destroyed).toBe(true)
})

it('retains cookies when reopening the same service, but changes partition on restart', async () => {
  const manager = new DeepSeekWebWindows()
  await manager.open(session, {} as any)
  const partition = mocks.windows[0].options.webPreferences.partition
  mocks.windows[0].destroy()
  await manager.open(session, {} as any)
  expect(mocks.windows[1].options.webPreferences.partition).toBe(partition)
  await manager.open({ ...session, webUrl: 'http://127.0.0.1:43200/?token=new-token' }, {} as any)
  expect(mocks.windows[2].options.webPreferences.partition).not.toBe(partition)
})

it('rejects non-DSH, stopped, missing and external targets', () => {
  for (const value of [undefined, { ...session, agentKind: 'codex' as const }, { ...session, status: 'stopped' as const }, { ...session, webUrl: 'https://example.com/' }]) {
    expect(managedDeepSeekUrl(value)).toBeUndefined()
  }
})

it('does not leak credential URLs on loading failures', async () => {
  mocks.fail = true
  const manager = new DeepSeekWebWindows()
  await expect(manager.open(session, {} as any)).rejects.toThrow('DeepSeek Web 页面加载失败')
  expect(mocks.windows[0].destroyed).toBe(true)
})

it('keeps DSH internal navigation, sends public links to browser and rejects file windows', async () => {
  await new DeepSeekWebWindows().open(session, {} as any)
  const contents = mocks.windows[0].webContents
  const event = { preventDefault: vi.fn() }
  contents.emit('will-navigate', event, 'http://127.0.0.1:43127/settings')
  expect(event.preventDefault).not.toHaveBeenCalled()
  contents.emit('will-navigate', event, 'https://example.com/')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/')
  const handler = contents.setWindowOpenHandler.mock.calls[0][0]
  expect(handler({ url: 'file:///C:/demo.txt' })).toEqual({ action: 'deny' })
  expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  event.preventDefault.mockClear()
  contents.emit('will-redirect', event, 'https://example.com/')
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(mocks.openExternal).toHaveBeenCalledTimes(1)
})
