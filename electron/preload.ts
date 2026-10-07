import { contextBridge, ipcRenderer } from 'electron'
import { preventExternalFileDrop } from '../src/shared/prevent-file-drop'
import { parseAppearanceSettings } from '../src/shared/appearance-settings'
import { DEFAULT_ATTENTION_AUDIO_SETTINGS, parseAttentionAudioSettings } from '../src/shared/attention-audio-settings'

import { IPC_CHANNELS, type AgentManagerApi, type ManagerEvent, type StartSessionRequest } from '../src/shared/manager-api'

const api: AgentManagerApi = {
  setActiveSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.setActiveSession, sessionId),
  testAttentionSound: (settings) => ipcRenderer.invoke(IPC_CHANNELS.testAttentionSound, settings),
  getTerminalSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getTerminalSettings),
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAppearanceSettings),
  updateAppearanceSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateAppearanceSettings, settings),
  onAppearanceSettingsChanged: (listener) => {
    const handle = (_event: unknown, value: unknown): void => { listener(parseAppearanceSettings(value)) }
    ipcRenderer.on(IPC_CHANNELS.appearanceSettingsChanged, handle)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.appearanceSettingsChanged, handle) }
  },
  updateTerminalSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateTerminalSettings, settings),
  getAttentionSoundSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAttentionSoundSettings),
  updateAttentionSoundSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateAttentionSoundSettings, settings),
  onAttentionSound: (listener) => {
    const handle = (_event: unknown, id: unknown, settings: unknown): void => {
      if (typeof id !== 'string' || id.length > 64) return
      Promise.resolve().then(() => listener(parseAttentionAudioSettings(settings ?? DEFAULT_ATTENTION_AUDIO_SETTINGS))).then(
        () => ipcRenderer.send(IPC_CHANNELS.attentionSoundResult, id, true),
        () => ipcRenderer.send(IPC_CHANNELS.attentionSoundResult, id, false),
      )
    }
    ipcRenderer.on(IPC_CHANNELS.attentionSound, handle)
    ipcRenderer.send(IPC_CHANNELS.attentionSoundReady, true)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.attentionSound, handle)
      ipcRenderer.send(IPC_CHANNELS.attentionSoundReady, false)
    }
  },
  platform: process.platform,
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  terminalReplay: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.terminalReplay, sessionId),
  openDeepSeekWeb: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.openDeepSeekWeb, sessionId),
  openExternalWeb: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalWeb, url),
  openSessionWorkspace: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.openSessionWorkspace, sessionId),
  listAuditEntries: () => ipcRenderer.invoke(IPC_CHANNELS.listAuditEntries),
  listTokenUsageSummary: (query) => ipcRenderer.invoke(IPC_CHANNELS.listTokenUsageSummary, query),
  listTokenUsageDetails: (query) => ipcRenderer.invoke(IPC_CHANNELS.listTokenUsageDetails, query),
  exportAuditEntries: (entryIds) => ipcRenderer.invoke(IPC_CHANNELS.exportAuditEntries, entryIds),
  startSession: (request: StartSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.startSession, request),
  createContinuation: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.createContinuation, sessionId),
  write: (sessionId, data) => ipcRenderer.invoke(IPC_CHANNELS.write, sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke(IPC_CHANNELS.resize, sessionId, cols, rows),
  stopSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.stopSession, sessionId),
  restartSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.restartSession, sessionId),
  listBindingSessions: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listBindingSessions, sessionId),
  replaceSessionBinding: (sessionId, nativeSessionId) => ipcRenderer.invoke(IPC_CHANNELS.replaceSessionBinding, sessionId, nativeSessionId),
  continueSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.continueSession, sessionId),
  tryRecoveryOnce: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.tryRecoveryOnce, sessionId),
  acceptRecoverySuggestion: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.acceptRecoverySuggestion, sessionId),
  dismissRecoverySuggestion: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.dismissRecoverySuggestion, sessionId),
  removeSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.removeSession, sessionId),
  detachSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.detachSession, sessionId),
  renameSession: (sessionId, displayName) => ipcRenderer.invoke(IPC_CHANNELS.renameSession, sessionId, displayName),
  updateSessionConfig: (sessionId, config) => ipcRenderer.invoke(IPC_CHANNELS.updateSessionConfig, sessionId, config),
  updateSessionProxy: (sessionId, proxy) => ipcRenderer.invoke(IPC_CHANNELS.updateSessionProxy, sessionId, proxy),
  setApprovalMode: (sessionId, mode, settings) => ipcRenderer.invoke(IPC_CHANNELS.setApprovalMode, sessionId, mode, settings),
  setFullAutoMode: (sessionId, enabled) => ipcRenderer.invoke(IPC_CHANNELS.setFullAutoMode, sessionId, enabled),
  setUnattendedMode: (sessionId, settings) => ipcRenderer.invoke(IPC_CHANNELS.setUnattendedMode, sessionId, settings),
  saveUnattendedSettings: (sessionId, settings) => ipcRenderer.invoke(IPC_CHANNELS.saveUnattendedSettings, sessionId, settings),
  listProviderModels: (input) => ipcRenderer.invoke(IPC_CHANNELS.listProviderModels, input),
  listCCSwitchProviders: (agentKind) => ipcRenderer.invoke(IPC_CHANNELS.listCCSwitchProviders, agentKind),
  getContinueKeywordSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getContinueKeywordSettings),
  updateContinueKeywordSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateContinueKeywordSettings, settings),
  getSessionSafetySettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSessionSafetySettings),
  updateSessionSafetySettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateSessionSafetySettings, settings),
  getDingTalkSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getDingTalkSettings),
  updateDingTalkSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateDingTalkSettings, settings),
  resetDingTalkBinding: () => ipcRenderer.invoke(IPC_CHANNELS.resetDingTalkBinding),
  approveSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.approveSession, sessionId),
  listPendingApprovals: () => ipcRenderer.invoke(IPC_CHANNELS.listPendingApprovals),
  approveRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.approveRequest, requestId),
  approveAndRememberRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.approveAndRememberRequest, requestId),
  rejectRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.rejectRequest, requestId),
  approveAllPending: () => ipcRenderer.invoke(IPC_CHANNELS.approveAllPending),
  acceptApprovalSuggestion: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.acceptApprovalSuggestion, sessionId),
  dismissApprovalSuggestion: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.dismissApprovalSuggestion, sessionId),
  listApprovalRules: () => ipcRenderer.invoke(IPC_CHANNELS.listApprovalRules),
  addApprovalRule: (command) => ipcRenderer.invoke(IPC_CHANNELS.addApprovalRule, command),
  removeApprovalRule: (command) => ipcRenderer.invoke(IPC_CHANNELS.removeApprovalRule, command),
  listDangerRules: () => ipcRenderer.invoke(IPC_CHANNELS.listDangerRules),
  addDangerRule: (input) => ipcRenderer.invoke(IPC_CHANNELS.addDangerRule, input),
  setDangerRuleEnabled: (ruleId, enabled) => ipcRenderer.invoke(IPC_CHANNELS.setDangerRuleEnabled, ruleId, enabled),
  removeDangerRule: (ruleId) => ipcRenderer.invoke(IPC_CHANNELS.removeDangerRule, ruleId),
  testDangerCommand: (command) => ipcRenderer.invoke(IPC_CHANNELS.testDangerCommand, command),
  getLlmReviewSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getLlmReviewSettings),
  listLlmReviewModels: (settings, reviewerId) => ipcRenderer.invoke(IPC_CHANNELS.listLlmReviewModels, settings, reviewerId),
  testLlmReviewer: (settings, reviewerId) => ipcRenderer.invoke(IPC_CHANNELS.testLlmReviewer, settings, reviewerId),
  importLlmReviewer: (input) => ipcRenderer.invoke(IPC_CHANNELS.importLlmReviewer, input),
  updateLlmReviewSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateLlmReviewSettings, settings),
  reviewApprovalRules: () => ipcRenderer.invoke(IPC_CHANNELS.reviewApprovalRules),
  chooseWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace),
  chooseExecutable: (agentKind) => ipcRenderer.invoke(IPC_CHANNELS.chooseExecutable, agentKind),
  discoverSessions: (agentKind, workspace) => ipcRenderer.invoke(IPC_CHANNELS.discoverSessions, agentKind, workspace),
  discoverRecentCodexSessions: () => ipcRenderer.invoke(IPC_CHANNELS.discoverRecentCodexSessions),
  detectAgentEnvironment: (agentKind, executable) => ipcRenderer.invoke(IPC_CHANNELS.detectAgentEnvironment, agentKind, executable),
  installNodeAndNpm: () => ipcRenderer.invoke(IPC_CHANNELS.installNodeAndNpm),
  installAgent: (agentKind, registry, operation) => operation === undefined
    ? ipcRenderer.invoke(IPC_CHANNELS.installAgent, agentKind, registry)
    : ipcRenderer.invoke(IPC_CHANNELS.installAgent, agentKind, registry, operation),
  installRipgrep: () => ipcRenderer.invoke(IPC_CHANNELS.installRipgrep),
  readClipboardText: () => ipcRenderer.invoke(IPC_CHANNELS.readClipboardText),
  writeClipboardText: (text) => ipcRenderer.invoke(IPC_CHANNELS.writeClipboardText, text),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: ManagerEvent): void => listener(message)
    ipcRenderer.on(IPC_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler)
  },
}

contextBridge.exposeInMainWorld('agentManager', api)

window.addEventListener('dragover', preventExternalFileDrop, true)
window.addEventListener('drop', preventExternalFileDrop, true)
