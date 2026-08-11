import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../../src/shared/manager-api'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}))

describe('preload agentManager contract', () => {
  beforeEach(() => vi.resetModules())

  it('exposes only the narrow manager API including native session discovery', async () => {
    await import('../../electron/preload')
    const api = electron.exposeInMainWorld.mock.calls.at(-1)?.[1] as Record<string, (...args: unknown[]) => unknown>
    expect(Object.keys(api).sort()).toEqual(['acceptApprovalSuggestion', 'acceptRecoverySuggestion', 'addApprovalRule', 'approveSession', 'chooseWorkspace', 'continueSession', 'discoverSessions', 'dismissApprovalSuggestion', 'dismissRecoverySuggestion', 'listApprovalRules', 'listAuditEntries', 'listSessions', 'readClipboardText', 'removeApprovalRule', 'removeSession', 'resize', 'restartSession', 'startSession', 'stopSession', 'subscribe', 'terminalHistory', 'terminalReplay', 'tryRecoveryOnce', 'write', 'writeClipboardText'])
    await api.discoverSessions?.('codex', 'B:\\work')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.discoverSessions, 'codex', 'B:\\work')
  })
})
