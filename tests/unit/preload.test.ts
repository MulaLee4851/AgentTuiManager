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
    expect(Object.keys(api).sort()).toEqual(['acceptApprovalSuggestion', 'acceptRecoverySuggestion', 'addApprovalRule', 'approveAllPending', 'approveAndRememberRequest', 'approveRequest', 'approveSession', 'chooseExecutable', 'chooseWorkspace', 'continueSession', 'detachSession', 'detectAgentEnvironment', 'discoverSessions', 'dismissApprovalSuggestion', 'dismissRecoverySuggestion', 'exportAuditEntries', 'getContinueKeywordSettings', 'getDingTalkSettings', 'getSessionSafetySettings', 'installAgent', 'installNodeAndNpm', 'installRipgrep', 'listApprovalRules', 'listAuditEntries', 'listCCSwitchProviders', 'listPendingApprovals', 'listSessions', 'readClipboardText', 'rejectRequest', 'removeApprovalRule', 'removeSession', 'renameSession', 'resetDingTalkBinding', 'resize', 'restartSession', 'setFullAutoMode', 'startSession', 'stopSession', 'subscribe', 'terminalReplay', 'tryRecoveryOnce', 'updateContinueKeywordSettings', 'updateDingTalkSettings', 'updateSessionConfig', 'updateSessionProxy', 'updateSessionSafetySettings', 'write', 'writeClipboardText'])
    await api.setFullAutoMode?.('session-1', true)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.setFullAutoMode, 'session-1', true)
    await api.listCCSwitchProviders?.('codex')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.listCCSwitchProviders, 'codex')
    await api.discoverSessions?.('codex', 'B:\\work')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.discoverSessions, 'codex', 'B:\\work')
    await api.detectAgentEnvironment?.('codex', 'codex')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.detectAgentEnvironment, 'codex', 'codex')
    await api.installAgent?.('codex', 'npmmirror')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.installAgent, 'codex', 'npmmirror')
    await api.getDingTalkSettings?.()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.getDingTalkSettings)
  })
})
