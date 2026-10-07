// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../../src/shared/manager-api'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, send: electron.send, on: electron.on, removeListener: electron.removeListener },
}))

describe('preload agentManager contract', () => {
  beforeEach(() => vi.resetModules())

  it('acknowledges successful or failed playback without sending error details', async () => {
    await import('../../electron/preload')
    const api = electron.exposeInMainWorld.mock.calls.at(-1)?.[1]
    const play = vi.fn(async () => undefined)
    const unsubscribe = api.onAttentionSound(play)
    expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionSoundReady, true)
    const listener = electron.on.mock.calls.filter(call => call[0] === IPC_CHANNELS.attentionSound).at(-1)![1]
    listener({}, 'sound-1', { sound: 'bell', volume: 25 })
    await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionSoundResult, 'sound-1', true))
    expect(play).toHaveBeenCalledWith({ sound: 'bell', volume: 25 })
    play.mockRejectedValueOnce(new Error('private diagnostic'))
    listener({}, 'sound-2')
    await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionSoundResult, 'sound-2', false))
    expect(electron.send.mock.calls.flat()).not.toContain('private diagnostic')
    play.mockClear()
    listener({}, 'sound-invalid', { sound: 'classic', volume: -1 })
    await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionSoundResult, 'sound-invalid', false))
    expect(play).not.toHaveBeenCalled()
    unsubscribe()
    expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.attentionSoundReady, false)
  })

  it('exposes only the narrow manager API including native session discovery', async () => {
    await import('../../electron/preload')
    const api = electron.exposeInMainWorld.mock.calls.at(-1)?.[1] as Record<string, (...args: unknown[]) => unknown>
    expect(Object.keys(api).sort()).toEqual(['acceptApprovalSuggestion', 'acceptRecoverySuggestion', 'addApprovalRule', 'addDangerRule', 'approveAllPending', 'approveAndRememberRequest', 'approveRequest', 'approveSession', 'chooseExecutable', 'chooseWorkspace', 'continueSession', 'createContinuation', 'detachSession', 'detectAgentEnvironment', 'discoverRecentCodexSessions', 'discoverSessions', 'dismissApprovalSuggestion', 'dismissRecoverySuggestion', 'exportAuditEntries', 'getAppearanceSettings', 'getAttentionSoundSettings', 'getContinueKeywordSettings', 'getDingTalkSettings', 'getLlmReviewSettings', 'getSessionSafetySettings', 'getTerminalSettings', 'importLlmReviewer', 'installAgent', 'installNodeAndNpm', 'installRipgrep', 'listApprovalRules', 'listAuditEntries', 'listBindingSessions', 'listCCSwitchProviders', 'listDangerRules', 'listLlmReviewModels', 'listPendingApprovals', 'listProviderModels', 'listSessions', 'listTokenUsageDetails', 'listTokenUsageSummary', 'onAppearanceSettingsChanged', 'onAttentionSound', 'openDeepSeekWeb', 'openExternalWeb', 'openSessionWorkspace', 'platform', 'readClipboardText', 'rejectRequest', 'removeApprovalRule', 'removeDangerRule', 'removeSession', 'renameSession', 'replaceSessionBinding', 'resetDingTalkBinding', 'resize', 'restartSession', 'reviewApprovalRules', 'saveUnattendedSettings', 'setActiveSession', 'setApprovalMode', 'setDangerRuleEnabled', 'setFullAutoMode', 'setUnattendedMode', 'startSession', 'stopSession', 'subscribe', 'terminalReplay', 'testAttentionSound', 'testDangerCommand', 'testLlmReviewer', 'tryRecoveryOnce', 'updateAppearanceSettings', 'updateAttentionSoundSettings', 'updateContinueKeywordSettings', 'updateDingTalkSettings', 'updateLlmReviewSettings', 'updateSessionConfig', 'updateSessionProxy', 'updateSessionSafetySettings', 'updateTerminalSettings', 'write', 'writeClipboardText'])
    await api.listProviderModels?.({ baseUrl: 'https://example.com/v1' })
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.listProviderModels, { baseUrl: 'https://example.com/v1' })
    await api.listBindingSessions?.('session-1')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.listBindingSessions, 'session-1')
    await api.replaceSessionBinding?.('session-1', null)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.replaceSessionBinding, 'session-1', null)
    expect(api.platform).toBe(process.platform)
    await api.setActiveSession?.(null)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.setActiveSession, null)
    await api.getAttentionSoundSettings?.()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.getAttentionSoundSettings)
    const audioSettings = { sound: 'pulse', volume: 0 }
    await api.updateAttentionSoundSettings?.(audioSettings)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.updateAttentionSoundSettings, audioSettings)
    await api.testAttentionSound?.(audioSettings)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.testAttentionSound, audioSettings)
    const saved = { enabled: false, endWord: 'DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 7, approvalEnterCount: 3 }
    await api.saveUnattendedSettings?.('session-1', saved)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.saveUnattendedSettings, 'session-1', saved)
    await api.openDeepSeekWeb?.('session-1')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.openDeepSeekWeb, 'session-1')
    await api.openExternalWeb?.('https://example.com/')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.openExternalWeb, 'https://example.com/')
    const drop = new Event('drop', { cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [{}], dropEffect: 'copy' } })
    window.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    await api.setApprovalMode?.('session-1', 'rules-auto')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.setApprovalMode, 'session-1', 'rules-auto', undefined)
    await api.setFullAutoMode?.('session-1', true)
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.setFullAutoMode, 'session-1', true)
    await api.setUnattendedMode?.('session-1', { enabled: true, endWord: 'TASK-DONE', recoveryWord: 'continue' })
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.setUnattendedMode, 'session-1', { enabled: true, endWord: 'TASK-DONE', recoveryWord: 'continue' })
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
    await api.testDangerCommand?.('rm -rf fixtures')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.testDangerCommand, 'rm -rf fixtures')
    await api.getLlmReviewSettings?.()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.getLlmReviewSettings)
    await api.discoverRecentCodexSessions?.()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.discoverRecentCodexSessions)
    await api.listLlmReviewModels?.({ enabled: false }, 'reviewer-b')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.listLlmReviewModels, { enabled: false }, 'reviewer-b')
    await api.testLlmReviewer?.({ enabled: false }, 'reviewer-b')
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.testLlmReviewer, { enabled: false }, 'reviewer-b')
    await api.importLlmReviewer?.({ agentKind: 'codex', providerId: 'fixture-provider' })
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.importLlmReviewer, { agentKind: 'codex', providerId: 'fixture-provider' })
    await api.reviewApprovalRules?.()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.reviewApprovalRules)
  })
})
