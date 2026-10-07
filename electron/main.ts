import { isAbsolute as isAbsoluteDataPath } from 'node:path'
import { isApprovalMode, APPROVAL_MODE_LABEL } from '../src/shared/approval-mode'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, safeStorage, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { AttentionSound } from './attention-sound'
import { isAttentionSessionActive } from './attention-focus'
import { AttentionAudioDelivery } from './attention-audio-delivery'
import { TerminalSettingsStore } from './terminal-settings-store'
import { AppearanceSettingsStore } from './appearance-settings-store'
import { AttentionAudioSettingsStore } from './attention-audio-settings-store'
import { NativeAttentionAudio } from './native-attention-audio'
import { DEFAULT_ATTENTION_AUDIO_SETTINGS, parseAttentionAudioSettings, type AttentionAudioSettings } from '../src/shared/attention-audio-settings'
import { TerminalQuestionSignal } from './terminal-question-signal'
import { statSync } from 'node:fs'
import { parseNetworkRetry } from '../src/shared/network-retry'
import { parseAutoCompactTokens } from '../src/shared/auto-compact'
import { SessionContinuationService } from './session-continuation-service'
import { writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

import { SessionController } from './session-controller'
import { NativeResumeCoordinator } from './native-resume-coordinator'
import { parseUnattendedSettings } from '../src/shared/unattended-settings'
import { DeepSeekWebWindows } from './deepseek-web-window'
import { openExternalWeb, routeExternalLinks } from './external-links'
import { openSessionWorkspace } from './open-session-workspace'
import { SessionHostManager } from './session-host-manager'
import { discoverNativeSessions, discoverRecentNativeSessions, discoverGlobalCodexSessions, discoverBindableSessions } from './native-session-discovery'
import { canonicalNativeRecovery, terminalScrollbackArgs, validateExecutable } from './start-request-policy'
import { ApprovalPolicyStore } from './approval-policy-store'
import { classifyApprovalRisk } from './approval-policy'
import { approvalAuditDetails } from './approval-audit-details'
import { resolveExecutableForPty } from './executable-resolution'
import { ActivityAuditStore, type NewAuditEntry } from './activity-audit-store'
import { RecoveryPolicyStore } from './recovery-policy-store'
import { AgentConfigurationStore } from './agent-configuration-store'
import { fetchProviderModels } from './provider-models'
import { applyAgentLaunchProfile } from './agent-launch-profile'
import { CCSwitchProviderReader } from './ccswitch-provider-reader'
import { readCodexGlobalProvider } from './codex-global-config'
import { AgentProxyStore, environmentForAgentProxy } from './agent-proxy-store'
import { ContinueKeywordStore } from './continue-keyword-store'
import { SessionSafetyStore } from './session-safety-store'
import { ManagedSessionCatalog } from './managed-session-catalog'
import { restoreStartupWorkspace, workspaceRestoreCandidates } from './startup-workspace'
import { DingTalkSettingsStore } from './dingtalk-settings-store'
import { DingTalkCommandRouter } from './dingtalk-command-router'
import { DingTalkStreamService } from './dingtalk-stream-service'
import { DingTalkAgentInterpreter } from './dingtalk-agent-interpreter'
import { migrateCodexProviderOfficial, migrateCodexSessionProvider } from './codex-session-provider-migrator'
import { openNativeResumeTerminal } from './native-terminal'
import { safeAuditExport } from './audit-export'
import { NativeDragBridge, type NativeDragEvent } from './native-drag-bridge'
import { detectAgentEnvironment, installAgent, installNodeAndNpm, installRipgrep } from './agent-environment-manager'
import { environmentWithFreshPath, pathFromEnvironment } from './platform-environment'
import { LlmReviewSettingsStore } from './llm-review-settings-store'
import { listLlmReviewModels } from './llm-model-catalog'
import { LlmSecurityReviewer } from './llm-security-reviewer'
import { importLlmReviewer } from './llm-reviewer-import'
import { TokenUsageStore } from './token-usage-store'
import { NativeSessionActivityMonitor, validateNativeActivityBinding } from './native-session-activity'
import { IPC_CHANNELS, type AgentConfigInput, type AgentKind, type AgentProxyInput, type ApprovalRequest, type AuditEntry, type ContinueKeywordSettings, type DingTalkSettingsInput, type ExternalTerminalDragProjection, type LlmReviewSettingsInput, type LlmRuleAuditFinding, type LlmRuleAuditResult, type LlmRuleAuditState, type ManagerEvent, type NativeSessionSummary, type NpmRegistryChoice, type RecoveryRecipe, type SessionSafetySettings, type SessionSummary, type StartSessionRequest } from '../src/shared/manager-api'

let mainWindow: BrowserWindow | undefined
const deepSeekWebWindows = new DeepSeekWebWindows()
let tray: Tray | undefined
let controller: SessionController
const nativeResumeCoordinator = new NativeResumeCoordinator()
let activeSessionId: string | undefined
const questionSignals = new Map<string, { activitySince?: number; signal: TerminalQuestionSignal }>()
const attentionSound = new AttentionSound({
  session: id => controller?.listSessions().find(session => session.sessionId === id),
  approvals: id => controller?.listPendingApprovals().filter(request => request.sessionId === id) ?? [],
  isActive: id => isAttentionSessionActive(id, activeSessionId, mainWindow),
  play: () => playAttentionChime(),
  onDecision: event => {
    const outcome = event.outcome === 'played' ? 'dispatched' : event.outcome.replaceAll('-', '_')
    const labels = { queued: '提示音已排队', 'suppressed-active': '正在查看对应 Agent，提示音已静音', invalidated: '事件已结束，取消提示音', played: '提示音已交给音频通道' }
    recordAttentionAudit({ level: 'info', category: 'session', action: 'attention_sound_' + outcome,
      message: labels[event.outcome], sessionId: event.sessionId, details: { kind: event.kind, outcome } })
  },
})
const nativeAttentionAudio = new NativeAttentionAudio()
const attentionAudioDelivery = new AttentionAudioDelivery({
  getSettings: () => attentionAudioSettingsStore?.getSettings() ?? { ...DEFAULT_ATTENTION_AUDIO_SETTINGS },
  send: (id, settings) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()
      || mainWindow.webContents.isLoadingMainFrame()) throw new Error('Audio renderer unavailable')
    mainWindow.webContents.send(IPC_CHANNELS.attentionSound, id, settings)
  },
  fallback: (settings, isAllowed) => {
    void nativeAttentionAudio.play(settings, isAllowed).catch(() => {
      const current = attentionAudioSettingsStore?.getSettings() ?? DEFAULT_ATTENTION_AUDIO_SETTINGS
      // The emergency system beep has no volume control: retain it only at the original defaults.
      if (isAllowed() && settings.sound === 'classic' && settings.volume === 100 && current.sound === 'classic' && current.volume === 100) {
        try { shell.beep() } catch { /* Sound must never interrupt sessions. */ }
      } else {
        recordAttentionAudit({ level: 'warning', category: 'session', action: 'attention_audio_unavailable', message: '提示音输出不可用，请检查系统音量和输出设备' })
      }
    })
  },
  onDelivery: outcome => recordAttentionAudit({ level: 'info', category: 'session', action: 'attention_audio_' + outcome,
    message: outcome === 'renderer_completed' ? '音频通道已完成提示音播放' : outcome === 'muted' ? '提示音音量为 0%，已静音' : '提示音已调用备用音频播放', details: { outcome } }),
})
function playAttentionChime(preview?: AttentionAudioSettings): void { attentionAudioDelivery.play(preview) }
let terminalSettingsStore: TerminalSettingsStore
let appearanceSettingsStore: AppearanceSettingsStore
let attentionAudioSettingsStore: AttentionAudioSettingsStore
let auditStore: ActivityAuditStore
let tokenUsageStore: TokenUsageStore
let nativeActivityMonitor: NativeSessionActivityMonitor | undefined
let agentConfigurationStore: AgentConfigurationStore
let agentProxyStore: AgentProxyStore
let continueKeywordStore: ContinueKeywordStore
let sessionSafetyStore: SessionSafetyStore
let sessionCatalog: ManagedSessionCatalog
let dingTalkSettingsStore: DingTalkSettingsStore
let dingTalkStreamService: DingTalkStreamService
let llmReviewSettingsStore: LlmReviewSettingsStore
const llmSecurityReviewer = new LlmSecurityReviewer()
let llmRuleAuditTimer: ReturnType<typeof setTimeout> | undefined
let llmRuleAuditInFlight: Promise<LlmRuleAuditResult> | undefined
let llmRuleAuditState: LlmRuleAuditState = { status: 'idle' }
let nativeDragBridge: NativeDragBridge | undefined
const ccSwitchProviderReader = new CCSwitchProviderReader()
let quitting = false
let quitPrepared = false
let quitPromptActive = false
const discoveryInFlight = new Map<string, Promise<NativeSessionSummary[]>>()
const userSelectedExecutables = new Set<string>()
const sessionSnapshots = new Map<string, SessionSummary>()
const pendingOutputEvents = new Map<string, { sessionId: string; data: string; sequence?: number }>()
let outputFlushTimer: ReturnType<typeof setTimeout> | undefined
let externalDragProjection: ExternalTerminalDragProjection | null = null
const isolatedUserData = process.env.AGENT_TUI_USER_DATA_DIR
if (isolatedUserData) {
  if (!isAbsoluteDataPath(isolatedUserData)) throw new Error('AGENT_TUI_USER_DATA_DIR must be absolute')
  app.setPath('userData', isolatedUserData)
}
const hasSingleInstanceLock = app.requestSingleInstanceLock()

const MAX_TEXT = 4_096
const MAX_TERMINAL_INPUT = 64 * 1024
// External native-window drag-in remains a Beta capability. Keep the listener
// completely dormant in normal builds until explicitly enabled for controlled
// testing; managed Agent drag-out is independent of this bridge.
const ENABLE_NATIVE_DRAG_IN_BETA = process.env.AGENT_TUI_ENABLE_NATIVE_DRAG_IN_BETA === '1'
const DINGTALK_APPROVAL_NOTIFICATION_DELAY_MS = 300
const APP_LOGO_PATH = join(app.getAppPath(), 'logo', 'AgentTuiManager.png')
function text(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`)
  return value
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`Invalid ${name}`)
  return value.map((item, index) => text(item, `${name}[${index}]`))
}

function dimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 20 || (cols as number) > 500 || (rows as number) < 5 || (rows as number) > 200) throw new Error('Invalid terminal dimensions')
  return { cols: cols as number, rows: rows as number }
}

function terminalInput(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TERMINAL_INPUT) throw new Error('终端输入无效或过长')
  return value
}

function maxContinueRetries(value: unknown): number {
  if (value === undefined) return 3
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) {
    throw new Error('自动 continue 最大次数必须是 1 到 10 的整数')
  }
  return value as number
}

function executable(agentKind: AgentKind, value: unknown): string {
  const candidate = text(value, 'executable', 1_024)
  const configured = [process.env.AGENT_TUI_ALLOWED_EXECUTABLES ?? '', ...userSelectedExecutables].filter(Boolean).join(delimiter)
  const validated = validateExecutable(agentKind, candidate, configured)
  const environment = agentKind === 'generic' ? process.env : environmentWithFreshPath()
  return resolveExecutableForPty(validated, { path: pathFromEnvironment(environment) })
}

function workspace(value: unknown): string {
  const candidate = text(value, 'workspace', 1_024)
  try {
    if (!isAbsolute(candidate) || !statSync(candidate).isDirectory()) throw new Error('invalid')
  } catch { throw new Error('工作区目录不存在或无法访问，请选择有效文件夹后重新启动；恢复历史时可重新定位原项目目录。') }
  return candidate
}

function recovery(agentKind: AgentKind, value: unknown): RecoveryRecipe | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid recovery recipe')
  const input = value as Record<string, unknown>
  return {
    executable: executable(agentKind, input.executable),
    args: stringArray(input.args, 'recovery.args'),
    ...(input.continueInput === undefined ? {} : { continueInput: text(input.continueInput, 'continueInput') }),
  }
}

function startRequest(value: unknown): StartSessionRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid start request')
  const input = value as Record<string, unknown>
  const agentKind = validatedAgentKind(input.agentKind)
  const initialExecutable = executable(agentKind, input.executable)
  const initialArgs = terminalScrollbackArgs(agentKind, stringArray(input.args, 'args'))
  const nativeSessionId = input.nativeSessionId === undefined
    ? undefined
    : text(input.nativeSessionId, 'nativeSessionId', 512)
  const suppliedRecoveryInput = recovery(agentKind, input.recovery)
  const suppliedRecovery = suppliedRecoveryInput ? {
    ...suppliedRecoveryInput,
    args: terminalScrollbackArgs(agentKind, suppliedRecoveryInput.args),
  } : undefined
  const canonicalRecovery = nativeSessionId
    ? canonicalNativeRecovery(agentKind, nativeSessionId, initialExecutable, initialArgs, suppliedRecovery)
    : suppliedRecovery
  const sessionWorkspace = agentKind === 'deepseek' ? workspace(app.getPath('home')) : workspace(input.workspace)
  return {
    displayName: text(input.displayName, 'displayName', 120),
    agentKind,
    workspace: sessionWorkspace,
    executable: initialExecutable,
    args: initialArgs,
    ...dimensions(input.cols, input.rows),
    maxContinueRetries: maxContinueRetries(input.maxContinueRetries),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(canonicalRecovery ? { recovery: canonicalRecovery } : {}),
    ...(input.agentConfig === undefined ? {} : { agentConfig: agentConfigInput(input.agentConfig) }),
    ...(input.agentProxy === undefined ? {} : { agentProxy: agentProxyInput(input.agentProxy) }),
  }
}

function agentProxyInput(value: unknown): AgentProxyInput {
  if (!value || typeof value !== 'object') throw new Error('代理配置格式无效')
  const input = value as Record<string, unknown>
  if (input.enabled !== true) return { enabled: false, host: '127.0.0.1', port: 7897 }
  if (input.protocol !== undefined && input.protocol !== 'http') throw new Error('当前只支持 HTTP 代理')
  const host = optionalConfigText(input.host, 'proxy host', 253) ?? '127.0.0.1'
  if (!/^(?:localhost|\[[0-9a-f:]+\]|[a-z0-9.-]+)$/i.test(host)) throw new Error('代理主机格式无效')
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) throw new Error('代理端口必须是 1 到 65535 的整数')
  const username = optionalConfigText(input.username, 'proxy username', 512)
  const password = optionalConfigText(input.password, 'proxy password', 4_096)
  if (password && !username) throw new Error('填写代理密码时也需要填写用户名')
  return {
    enabled: true, protocol: 'http', host, port: input.port as number,
    ...(username ? { username } : {}), ...(password ? { password } : {}),
    ...(input.clearPassword === true ? { clearPassword: true } : {}),
  }
}

function continueKeywordSettings(value: unknown): ContinueKeywordSettings {
  if (!value || typeof value !== 'object') throw new Error('Continue 关键词设置格式无效')
  const input = value as Record<string, unknown>
  if (input.maxRetries !== undefined && (!Number.isInteger(input.maxRetries) || Number(input.maxRetries) < 1 || Number(input.maxRetries) > 100)) {
    throw new Error('最大连续续跑次数必须是 1 到 100 的整数')
  }
  if (!Array.isArray(input.keywords) || input.keywords.length > 50) throw new Error('Continue 关键词最多保存 50 条')
  return {
    enabled: input.enabled === true,
    quietSeconds: 10, // Legacy storage compatibility only; no quiet-time delay.
    maxRetries: Number(input.maxRetries ?? 3),
    keywords: input.keywords.map((keyword, index) => text(keyword, 'keywords[' + index + ']', 200)),
  }
}

function sessionSafetySettings(value: unknown): SessionSafetySettings {
  if (!value || typeof value !== 'object') throw new Error('会话安全设置格式无效')
  return { preserveWorkspaceOnCrash: (value as Record<string, unknown>).preserveWorkspaceOnCrash !== false }
}

function dingTalkSettings(value: unknown): DingTalkSettingsInput {
  if (!value || typeof value !== 'object') throw new Error('钉钉设置格式无效')
  const input = value as Record<string, unknown>
  const clientId = optionalConfigText(input.clientId, 'DingTalk Client ID', 256)
  const clientSecret = optionalConfigText(input.clientSecret, 'DingTalk Client Secret', 2_048)
  const normalizeList = (candidate: unknown, label: string, maxLength: number): string[] => {
    if (!Array.isArray(candidate) || candidate.length > 100) throw new Error(`${label} 最多保存 100 项`)
    return [...new Set(candidate.map((item, index) => text(item, `${label}[${index}]`, maxLength).trim()).filter(Boolean))]
  }
  // Accept legacy renderer payloads for downgrade compatibility, but workspace
  // lists are no longer required and no longer authorize DingTalk access.
  const allowedWorkspaces = input.allowedWorkspaces === undefined ? undefined : normalizeList(input.allowedWorkspaces, '工作区', 1_024).map(workspace)
  const knownWorkspaces = input.knownWorkspaces === undefined ? undefined : normalizeList(input.knownWorkspaces, '已知工作区', 1_024).map(workspace)
  if (!Number.isInteger(input.commandsPerMinute) || Number(input.commandsPerMinute) < 1 || Number(input.commandsPerMinute) > 120) {
    throw new Error('每分钟命令上限必须是 1 到 120 的整数')
  }
  if (!Number.isInteger(input.agentRetryCount) || Number(input.agentRetryCount) < 0 || Number(input.agentRetryCount) > 10) {
    throw new Error('Agent 失败重试次数必须是 0 到 10 的整数')
  }
  const agentBaseUrl = optionalConfigText(input.agentBaseUrl, 'Agent Base URL', 2_048)
  const agentApiKey = optionalConfigText(input.agentApiKey, 'Agent API Key', 8_192)
  const agentModel = optionalConfigText(input.agentModel, 'Agent Model', 256)
  const agentProxyHost = optionalConfigText(input.agentProxyHost, 'Agent proxy host', 512)
  const agentProxyUsername = optionalConfigText(input.agentProxyUsername, 'Agent proxy username', 512)
  const agentProxyPassword = optionalConfigText(input.agentProxyPassword, 'Agent proxy password', 2_048)
  return {
    enabled: input.enabled === true,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(input.clearClientSecret === true ? { clearClientSecret: true } : {}),
    ...(allowedWorkspaces ? { allowedWorkspaces } : {}),
    ...(knownWorkspaces ? { knownWorkspaces } : {}),
    commandsPerMinute: Number(input.commandsPerMinute),
    agentModeEnabled: input.agentModeEnabled === true,
    agentRetryCount: Number(input.agentRetryCount),
    ...(agentBaseUrl ? { agentBaseUrl } : {}),
    ...(agentApiKey ? { agentApiKey } : {}),
    ...(input.clearAgentApiKey === true ? { clearAgentApiKey: true } : {}),
    ...(agentModel ? { agentModel } : {}),
    agentProxyEnabled: input.agentProxyEnabled === true,
    ...(agentProxyHost ? { agentProxyHost } : {}),
    ...(Number.isInteger(input.agentProxyPort) && Number(input.agentProxyPort) >= 1 && Number(input.agentProxyPort) <= 65_535 ? { agentProxyPort: Number(input.agentProxyPort) } : {}),
    ...(agentProxyUsername ? { agentProxyUsername } : {}),
    ...(agentProxyPassword ? { agentProxyPassword } : {}),
    ...(input.clearAgentProxyPassword === true ? { clearAgentProxyPassword: true } : {}),
  }
}

function llmReviewSettings(value: unknown): LlmReviewSettingsInput {
  if (!value || typeof value !== 'object') throw new Error('LLM 审查设置格式无效')
  const input = value as Record<string, unknown>
  const backend = input.backend ?? 'api'
  if (!['api', 'codex-cli', 'claude-cli'].includes(String(backend))) throw new Error('审核器类型无效')
  if (input.protocol !== undefined && !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(String(input.protocol))) throw new Error('审核 API 协议无效')
  if (input.anthropicAuth !== undefined && !['api-key', 'bearer'].includes(String(input.anthropicAuth))) throw new Error('Anthropic 认证方式无效')
  if (input.reviewers !== undefined && (!Array.isArray(input.reviewers) || input.reviewers.length > 30)) throw new Error('审核器池格式无效，最多 30 项')
  if (input.overallTimeoutSeconds !== undefined && (!Number.isInteger(input.overallTimeoutSeconds) || Number(input.overallTimeoutSeconds) < 5 || Number(input.overallTimeoutSeconds) > 600)) throw new Error('整体审核时限必须为 5 到 600 秒')
  const cliExecutable = optionalConfigText(input.cliExecutable, '审核 CLI 路径', 4096)
  const cliModel = optionalConfigText(input.cliModel, '审核 CLI 模型', 256)
  const level = input.level
  if (level !== 'low' && level !== 'medium' && level !== 'high') throw new Error('LLM 审查等级无效')
  if (!Number.isInteger(input.retryCount) || Number(input.retryCount) < 0 || Number(input.retryCount) > 10) throw new Error('LLM 审查失败重试次数必须是 0 到 10 的整数')
  if (!Number.isInteger(input.timeoutSeconds) || Number(input.timeoutSeconds) < 5 || Number(input.timeoutSeconds) > 600) throw new Error('LLM 审查单次请求超时必须是 5 到 600 秒的整数')
  if (!Number.isInteger(input.scheduledRuleAuditHours) || Number(input.scheduledRuleAuditHours) < 1 || Number(input.scheduledRuleAuditHours) > 720) throw new Error('定时审查周期必须是 1 到 720 小时的整数')
  const baseUrl = optionalConfigText(input.baseUrl, 'LLM review Base URL', 2_048)
  const apiKey = optionalConfigText(input.apiKey, 'LLM review API Key', 8_192)
  const model = optionalConfigText(input.model, 'LLM review Model', 256)
  const proxyHost = optionalConfigText(input.proxyHost, 'LLM review proxy host', 512)
  const proxyUsername = optionalConfigText(input.proxyUsername, 'LLM review proxy username', 512)
  const proxyPassword = optionalConfigText(input.proxyPassword, 'LLM review proxy password', 2_048)
  return {
    enabled: input.enabled === true,
    backend: backend as LlmReviewSettingsInput['backend'],
    ...(input.protocol !== undefined ? { protocol: input.protocol as LlmReviewSettingsInput['protocol'] } : {}),
    ...(input.anthropicAuth !== undefined ? { anthropicAuth: input.anthropicAuth as LlmReviewSettingsInput['anthropicAuth'] } : {}),
    ...(input.reviewers !== undefined ? { reviewers: input.reviewers as LlmReviewSettingsInput['reviewers'] } : {}),
    ...(input.overallTimeoutSeconds !== undefined ? { overallTimeoutSeconds: Number(input.overallTimeoutSeconds) } : {}),
    ...(cliExecutable ? { cliExecutable } : {}),
    ...(cliModel ? { cliModel } : {}),
    level,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(model ? { model } : {}),
    retryCount: Number(input.retryCount),
    timeoutSeconds: Number(input.timeoutSeconds),
    scheduledRuleAuditEnabled: input.scheduledRuleAuditEnabled === true,
    scheduledRuleAuditHours: Number(input.scheduledRuleAuditHours),
    proxyEnabled: input.proxyEnabled === true,
    ...(proxyHost ? { proxyHost } : {}),
    ...(Number.isInteger(input.proxyPort) && Number(input.proxyPort) >= 1 && Number(input.proxyPort) <= 65_535 ? { proxyPort: Number(input.proxyPort) } : {}),
    ...(proxyUsername ? { proxyUsername } : {}),
    ...(proxyPassword ? { proxyPassword } : {}),
    ...(input.clearProxyPassword === true ? { clearProxyPassword: true } : {}),
  }
}

function optionalConfigText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined
  const result = text(value, name, max).trim()
  if (!result || /[\r\n]/.test(result)) throw new Error(`Invalid ${name}`)
  return result
}

function agentConfigInput(value: unknown): AgentConfigInput {
  if (!value || typeof value !== 'object') throw new Error('独立配置格式无效')
  const input = value as Record<string, unknown>
  const networkRetry = parseNetworkRetry(input.networkRetry)
  const autoCompactTokens = parseAutoCompactTokens(input.autoCompactTokens)
  const compaction = autoCompactTokens === undefined ? {} : { autoCompactTokens }
  if (input.enabled !== true) return { enabled: false, source: 'local', ...compaction, ...(networkRetry ? { networkRetry } : {}) }
  const source = String(input.source)
  if (source !== 'custom' && source !== 'ccswitch') throw new Error('独立配置来源无效')
  const providerId = optionalConfigText(input.providerId, 'providerId', 256)
  const providerName = optionalConfigText(input.providerName, 'providerName', 256)
  if (source === 'ccswitch') {
    if (!providerId) throw new Error('请选择一个 CCSwitch Provider')
    return {
      enabled: true,
      source,
      providerId,
      ...(networkRetry ? { networkRetry } : {}),
      ...compaction,
      ...(providerName ? { providerName } : {}),
    }
  }
  const baseUrl = optionalConfigText(input.baseUrl, 'baseUrl', 2_048)
  if (baseUrl) {
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { throw new Error('Base URL 不是有效地址') }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 只支持 http 或 https')
  }
  const apiKey = optionalConfigText(input.apiKey, 'apiKey', 8_192)
  const model = optionalConfigText(input.model, 'model', 256)
  const extraArgs = input.extraArgs === undefined ? [] : stringArray(input.extraArgs, 'extraArgs')
  return {
    enabled: true,
    source,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    extraArgs,
    ...(networkRetry ? { networkRetry } : {}),
    ...compaction,
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerName ? { providerName } : {}),
  }
}

async function resolvedAgentConfig(agentKind: AgentKind, input: AgentConfigInput): Promise<AgentConfigInput> {
  parseAutoCompactTokens(input.autoCompactTokens, agentKind)
  if (!input.enabled || input.source !== 'ccswitch') return input
  if (agentKind !== 'codex' && agentKind !== 'claude') throw new Error('CCSwitch 当前仅支持 Codex 和 Claude Code')
  if (!input.providerId) throw new Error('请选择一个 CCSwitch Provider')
  return { ...await ccSwitchProviderReader.import(agentKind, input.providerId), ...(input.networkRetry ? { networkRetry: input.networkRetry } : {}), ...(input.autoCompactTokens === undefined ? {} : { autoCompactTokens: input.autoCompactTokens }) }
}

function validatedAgentKind(value: unknown): AgentKind {
  if (!['generic', 'codex', 'claude', 'pi', 'deepseek'].includes(String(value))) throw new Error('Invalid agent kind')
  return value as AgentKind
}

function sessionId(value: unknown): string {
  const candidate = text(value, 'sessionId', 128)
  if (!/^[a-zA-Z0-9-]+$/.test(candidate)) throw new Error('Invalid sessionId')
  return candidate
}

function coalescedDiscovery(agentKind: AgentKind, selectedWorkspace: string): Promise<NativeSessionSummary[]> {
  const key = `${agentKind}\0${selectedWorkspace.toLocaleLowerCase('en-US')}`
  const active = discoveryInFlight.get(key)
  if (active) return active
  let pending: Promise<NativeSessionSummary[]>
  pending = discoverNativeSessions(agentKind, selectedWorkspace).finally(() => {
    if (discoveryInFlight.get(key) === pending) discoveryInFlight.delete(key)
  })
  discoveryInFlight.set(key, pending)
  return pending
}

function trustedRenderer(event: IpcMainInvokeEvent): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender')
  }
}

function approvalSubject(command: string | undefined): string {
  if (/^tool:Shell$/i.test(command ?? '')) return '命令（参数待确认）'
  if (command?.startsWith('tool:')) return command.slice('tool:'.length)
  return command ? 'Shell' : '未识别'
}

function approvalReasonDetails(request: ApprovalRequest | undefined): { reason?: string; policyReason?: string } {
  if (!request) return {}
  const reason = request.agentReason ?? request.reason
  return {
    ...(reason ? { reason } : {}),
    ...(request.agentReason && request.reason !== request.agentReason ? { policyReason: request.reason } : {}),
  }
}

function auditSessionTransition(sessionId: string): void {
  const current = controller.listSessions().find((session) => session.sessionId === sessionId)
  const previous = sessionSnapshots.get(sessionId)
  if (!current) { sessionSnapshots.delete(sessionId); return }
  sessionSnapshots.set(sessionId, { ...current })
  if (!previous || previous.status === current.status) return
  if (current.status === 'recovering') {
    const modelCapacity = current.lastError === 'Selected model is at capacity. Please try a different model.'
    const hostUnresponsive = current.attentionKind === 'host-unresponsive'
    recordAudit({
      level: 'warning',
      category: 'recovery',
      action: hostUnresponsive ? 'host_restart_confirmed' : modelCapacity ? 'capacity_retry_started' : 'recovery_started',
      message: current.displayName + (hostUnresponsive ? ' 已确认重启，正在释放无响应终端并恢复会话' : modelCapacity ? ' 模型暂时繁忙，稍后自动继续' : ' 异常退出，正在自动恢复'),
      sessionId,
      details: { attempt: current.recoveryAttempts, ...(current.lastError ? { reason: current.lastError } : {}) },
    })
  } else if (previous.status === 'recovering' && current.status === 'running') {
    recordAudit({
      level: 'info',
      category: 'recovery',
      action: 'recovery_continued',
      message: current.displayName + ' 已恢复并继续任务',
      sessionId,
      details: { attempt: previous.recoveryAttempts, ...(previous.lastError ? { reason: previous.lastError } : {}) },
    })
  } else if (current.status === 'needs_attention') {
    const hostUnresponsive = current.attentionKind === 'host-unresponsive'
    recordAudit({
      level: 'warning', category: 'recovery', action: hostUnresponsive ? 'host_unresponsive_detected' : 'capacity_retry_exhausted',
      message: hostUnresponsive ? `${current.displayName} 终端连续无响应，等待用户确认是否重启` : `${current.displayName} 自动重试已达上限，终端保持运行`, sessionId,
      details: { attempt: current.recoveryAttempts, ...(current.lastError ? { reason: current.lastError } : {}) },
    })
  } else if (current.status === 'completed') {
    recordAudit({ level: 'info', category: 'session', action: 'session_completed', message: `${current.displayName} 已正常完成`, sessionId })
  } else if (current.status === 'failed') {
    recordAudit({ level: 'error', category: 'session', action: 'session_failed', message: `${current.displayName} 运行失败`, sessionId })
  } else if (current.status === 'stopped' && !current.userStopRequested) {
    recordAudit({ level: 'info', category: 'session', action: 'session_interrupted', message: `${current.displayName} 已由用户中断`, sessionId })
  }
}


function flushOutputEvents(): void {
  outputFlushTimer = undefined
  const events = [...pendingOutputEvents.values()]
  pendingOutputEvents.clear()
  for (const event of events) {
    for (const window of mainWindow ? [mainWindow] : []) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, { type: 'output', ...event })
    }
  }
}

function approvalRequestId(value: unknown): string {
  const candidate = text(value, 'approval request id', 160)
  if (!/^(?:terminal:)?[a-zA-Z0-9-]+$/.test(candidate)) throw new Error('授权请求标识无效，请刷新后重试')
  return candidate
}

function broadcast(event: ManagerEvent): void {
  if (event.type === 'output') {
    const session = controller?.listSessions().find(item => item.sessionId === event.sessionId)
    if (session) {
      const existing = questionSignals.get(event.sessionId)
      const signal = existing?.activitySince === session.activitySince && existing ? existing.signal : new TerminalQuestionSignal()
      questionSignals.set(event.sessionId, { activitySince: session.activitySince, signal })
      const question = signal.observe(event.data)
      if (question) attentionSound.terminalQuestion(event.sessionId, question, () => signal.current === question)
    }
    const previous = pendingOutputEvents.get(event.sessionId)
    pendingOutputEvents.set(event.sessionId, {
      sessionId: event.sessionId,
      data: `${previous?.data ?? ''}${event.data}`,
      ...(event.sequence === undefined ? (previous?.sequence === undefined ? {} : { sequence: previous.sequence }) : { sequence: event.sequence }),
    })
    if (!outputFlushTimer) outputFlushTimer = setTimeout(flushOutputEvents, 16)
    return
  }
  if (event.type === 'sessions-changed') auditSessionTransition(event.sessionId)
  if (event.type === 'sessions-changed') {
    attentionSound.sessionChanged(event.sessionId)
    const current = controller.listSessions().find(session => session.sessionId === event.sessionId)
    const question = questionSignals.get(event.sessionId)
    if (!current || current.userStopRequested || current.activity === 'completed' || ['stopped', 'completed', 'failed'].includes(current.status)
      || question && question.activitySince !== current.activitySince) {
      question?.signal.reset()
      questionSignals.delete(event.sessionId)
    }
  }
  if (event.type === 'sessions-changed') deepSeekWebWindows.sync(event.sessionId, controller.listSessions().find(item => item.sessionId === event.sessionId))
  for (const window of mainWindow ? [mainWindow] : []) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event)
  }
}

function suggestedAgentKind(title: string): 'codex' | 'claude' | undefined {
  if (/claude/i.test(title)) return 'claude'
  if (/codex/i.test(title)) return 'codex'
  return undefined
}

function nativeDragInsideManager(event: NativeDragEvent): boolean {
  const window = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined
  const bounds = window?.getBounds()
  return Boolean(bounds
    && event.cursor.x >= bounds.x && event.cursor.x < bounds.x + bounds.width
    && event.cursor.y >= bounds.y + 54 && event.cursor.y < bounds.y + bounds.height)
}

async function finishNativeDrop(event: NativeDragEvent): Promise<void> {
  const inferredKind = suggestedAgentKind(event.title)
  const managedNativeIds = new Set(controller.listSessions().map((session) => session.nativeSessionId).filter((id): id is string => Boolean(id)))
  const kinds: Array<'codex' | 'claude'> = inferredKind ? [inferredKind] : ['codex', 'claude']
  const discovered = (await Promise.all(kinds.map(async (agentKind) => (await discoverRecentNativeSessions(agentKind, Date.now() - 10 * 60_000))
    .filter((candidate) => !managedNativeIds.has(candidate.id))
    .map((candidate) => ({ ...candidate, agentKind }))))).flat()
  const candidates = discovered.sort((left, right) => right.updatedAt - left.updatedAt)
  const unique = candidates.length === 1 ? candidates[0] : undefined
  let automaticIssue: string | undefined
  if (unique && inferredKind === unique.agentKind && event.processName.toLocaleLowerCase('en-US') === 'windowsterminal' && event.structureVerified && event.tabCount === 1 && event.paneCount === 1) {
    const interrupted = await nativeDragBridge?.sendGracefulInterrupt(event)
    if (interrupted?.ok) {
      const resumeArgs = unique.agentKind === 'codex' ? ['resume', unique.id] : ['--resume', unique.id]
      const request: StartSessionRequest = {
        displayName: unique.title || `${unique.agentKind === 'claude' ? 'Claude Code' : 'Codex'} · ${unique.id.slice(0, 8)}`,
        agentKind: unique.agentKind,
        workspace: unique.workspace,
        executable: resolveExecutableForPty(unique.agentKind),
        args: resumeArgs,
        cols: 100,
        rows: 30,
        maxContinueRetries: 3,
        nativeSessionId: unique.id,
        recovery: { executable: resolveExecutableForPty(unique.agentKind), args: resumeArgs },
        agentConfig: AgentConfigurationStore.localSummary(),
      }
      const deadline = Date.now() + 12_000
      let started: SessionSummary | undefined
      let lastError: unknown
      for (let attempt = 0; Date.now() < deadline && !started && attempt < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        try { started = await controller.startSession(request) } catch (error) { lastError = error }
      }
      if (started) {
        const readyDeadline = Date.now() + 8_000
        while (Date.now() < readyDeadline && !controller.isSessionReady(started.sessionId)) {
          const status = controller.listSessions().find((session) => session.sessionId === started!.sessionId)?.status
          if (!status || ['completed', 'stopped', 'failed', 'needs_attention'].includes(status)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!controller.isSessionReady(started.sessionId)) {
          lastError = new Error('目标 Agent 未确认恢复完成')
          await controller.stopSession(started.sessionId).catch(() => undefined)
          const cleanupDeadline = Date.now() + 2_000
          while (Date.now() < cleanupDeadline) {
            const status = controller.listSessions().find((session) => session.sessionId === started!.sessionId)?.status
            if (!status || ['completed', 'stopped', 'failed'].includes(status)) break
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          await controller.removeSession(started.sessionId).catch(() => undefined)
        } else {
          await controller.flushCatalog()
          const closed = await nativeDragBridge?.closeSourceWindow(event).catch(() => undefined)
          externalDragProjection = null
          broadcast({ type: 'external-terminal-drag', projection: null })
          if (!closed?.ok) {
            recordAudit({ level: 'warning', category: 'session', action: 'external_source_close_failed', message: '外部会话已加入 Manager，但来源窗口未能安全关闭', sessionId: started.sessionId, details: { reason: closed?.reason ?? 'bridge unavailable' } })
            return
          }
        recordAudit({ level: 'info', category: 'session', action: 'external_terminal_attached', message: `${started.displayName} 已从外部终端加入 Manager`, sessionId: started.sessionId, details: { agentKind: unique.agentKind, workspace: unique.workspace, nativeSessionId: unique.id } })
        return
        }
      }
      recordAudit({ level: 'error', category: 'session', action: 'external_terminal_attach_failed', message: '外部终端会话自动迁入失败，已保留迁移选择', details: { error: lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error'), agentKind: unique.agentKind, workspace: unique.workspace, nativeSessionId: unique.id } })
      automaticIssue = '来源会话尚未释放，请在原终端正常退出后点击“迁入 Manager”'
    } else {
      automaticIssue = '来源窗口安全校验未通过，请在原终端正常退出后确认迁入'
    }
  }
  const projection: ExternalTerminalDragProjection = {
    transactionId: `${event.processId}-${event.hwnd}`,
    phase: 'dropped', terminalTitle: event.title.slice(0, 200),
    terminalKind: event.processName.toLocaleLowerCase('en-US') === 'windowsterminal' ? 'windows-terminal' : 'console',
    ...(unique ? { suggestedAgentKind: unique.agentKind, suggestedWorkspace: unique.workspace, suggestedNativeSessionId: unique.id } : inferredKind ? { suggestedAgentKind: inferredKind } : {}),
    ...(automaticIssue ? { issue: automaticIssue } : candidates.length > 1 ? { issue: '检测到多个最近会话，请确认要迁入的会话' } : candidates.length === 0 ? { issue: '没有检测到最近活跃的原生会话，请选择工作区后确认' } : {}),
  }
  externalDragProjection = projection
  broadcast({ type: 'external-terminal-drag', projection })
  recordAudit({ level: 'info', category: 'session', action: 'external_terminal_dropped', message: unique ? '已识别外部终端会话，正在准备迁入' : '检测到外部终端拖入，需要确认原生会话', details: { terminalKind: projection.terminalKind, terminalTitle: projection.terminalTitle, suggestedAgentKind: projection.suggestedAgentKind ?? 'unknown', candidateCount: candidates.length } })
}

function handleNativeDrag(event: NativeDragEvent): void {
  const inside = nativeDragInsideManager(event)
  if (!inside) {
    if (externalDragProjection) {
      externalDragProjection = null
      broadcast({ type: 'external-terminal-drag', projection: null })
    }
    return
  }
  if (event.type === 'move-end') {
    void finishNativeDrop(event).catch((error) => {
      const projection: ExternalTerminalDragProjection = { transactionId: `${event.processId}-${event.hwnd}`, phase: 'dropped', terminalTitle: event.title.slice(0, 200), terminalKind: event.processName.toLocaleLowerCase('en-US') === 'windowsterminal' ? 'windows-terminal' : 'console', issue: error instanceof Error ? error.message : String(error) }
      externalDragProjection = projection
      broadcast({ type: 'external-terminal-drag', projection })
    })
    return
  }
  const inferredKind = suggestedAgentKind(event.title)
  const projection: ExternalTerminalDragProjection = {
    transactionId: `${event.processId}-${event.hwnd}`,
    phase: 'hovering',
    terminalTitle: event.title.slice(0, 200),
    terminalKind: event.processName.toLocaleLowerCase('en-US') === 'windowsterminal' ? 'windows-terminal' : 'console',
    ...(inferredKind ? { suggestedAgentKind: inferredKind } : {}),
  }
  if (externalDragProjection?.phase === projection.phase
    && externalDragProjection.transactionId === projection.transactionId
    && externalDragProjection.terminalTitle === projection.terminalTitle) return
  externalDragProjection = projection
  broadcast({ type: 'external-terminal-drag', projection })
}

function recordAudit(entry: NewAuditEntry): void {
  const session = entry.sessionId
    ? sessionSnapshots.get(entry.sessionId) ?? controller.listSessions().find((item) => item.sessionId === entry.sessionId)
    : undefined
  const details = session
    ? { ...entry.details, displayName: session.displayName, agentKind: session.agentKind, workspace: session.workspace }
    : entry.details
  auditStore.append({ ...entry, ...(details ? { details } : {}) })
  broadcast({ type: 'audit-changed' })
}

/** Audio diagnostics contain no request text, provider data or credential values. */
function recordAttentionAudit(entry: NewAuditEntry): void {
  if (!auditStore) return
  try { auditStore.append(entry); broadcast({ type: 'audit-changed' }) } catch { /* Diagnostics cannot stop playback. */ }
}

function deterministicRuleFindings(approvalPolicy: ApprovalPolicyStore): LlmRuleAuditFinding[] {
  const findings: LlmRuleAuditFinding[] = []
  for (const rule of approvalPolicy.listRules()) {
    const dangerMatches = approvalPolicy.testDangerCommand(rule).matches.filter((match) => match.scopes.includes('safe-rule'))
    const risk = classifyApprovalRisk(rule)
    if (dangerMatches.length > 0) {
      findings.push({
        rule,
        severity: risk === 'delete' ? 'critical' : 'high',
        issue: '确定性扫描命中高危规则：' + dangerMatches.map((match) => match.name).join('、'),
        recommendation: '立即人工复核并从自动批准规则中移除；LLM 结论不能覆盖该命中。',
      })
    } else if (risk === 'write' || risk === 'delete') {
      findings.push({
        rule,
        severity: risk === 'delete' ? 'critical' : 'high',
        issue: `确定性扫描将该规则识别为${risk === 'delete' ? '删除' : '写入'}操作。`,
        recommendation: '从自动批准规则中移除并改为逐次人工确认。',
      })
    }
  }
  return findings
}

async function runLlmRuleAudit(approvalPolicy: ApprovalPolicyStore, source: 'manual' | 'scheduled'): Promise<LlmRuleAuditResult> {
  if (llmRuleAuditInFlight) return llmRuleAuditInFlight
  const operation = (async () => {
    const settings = llmReviewSettingsStore.getRuntimeSettings()
    const approvalRules = approvalPolicy.listRules()
    const startedAt = Date.now()
    llmRuleAuditState = { status: 'running', source, startedAt }
    recordAudit({
      level: 'info', category: 'review', action: 'llm_rule_audit_started',
      message: source === 'manual' ? '已手动启动 LLM 批准规则审查' : '已按计划启动 LLM 批准规则审查',
      details: { source, ruleCount: approvalRules.length, backend: settings.backend ?? 'api', model: settings.backend && settings.backend !== 'api' ? settings.cliModel ?? 'CLI 默认模型' : settings.model ?? 'not-configured' },
    })
    try {
      const result = await llmSecurityReviewer.reviewRuleSet(
        approvalRules,
        approvalPolicy.listDangerRules(),
        deterministicRuleFindings(approvalPolicy),
        settings,
      )
      await llmReviewSettingsStore.recordRuleAudit(result)
      llmRuleAuditState = { status: 'completed', source, startedAt, completedAt: result.reviewedAt }
      recordAudit({
        level: result.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high') ? 'warning' : 'info',
        category: 'review', action: 'llm_rule_audit_completed',
        message: `LLM 批准规则审查完成：发现 ${result.findings.length} 项问题`,
        details: {
          source, ruleCount: result.ruleCount, findingCount: result.findings.length,
          model: result.model, summary: result.summary,
          findings: JSON.stringify(result.findings.slice(0, 8).map((finding) => ({
            rule: finding.rule.slice(0, 500), severity: finding.severity,
            issue: finding.issue.slice(0, 500), recommendation: finding.recommendation.slice(0, 500),
          }))),
          findingsTruncated: result.findings.length > 8,
        },
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      llmRuleAuditState = { status: 'failed', source, startedAt, completedAt: Date.now(), error: message }
      recordAudit({
        level: 'error', category: 'review', action: 'llm_rule_audit_failed',
        message: 'LLM 批准规则审查失败，规则未被修改',
        details: { source, error: message },
      })
      throw error
    }
  })()
  llmRuleAuditInFlight = operation
  try { return await operation } finally { llmRuleAuditInFlight = undefined }
}

function scheduleLlmRuleAudit(approvalPolicy: ApprovalPolicyStore): void {
  if (llmRuleAuditTimer) clearTimeout(llmRuleAuditTimer)
  llmRuleAuditTimer = undefined
  const settings = llmReviewSettingsStore.getRuntimeSettings()
  if (!settings.scheduledRuleAuditEnabled) return
  const intervalMs = settings.scheduledRuleAuditHours * 60 * 60 * 1_000
  const dueAt = (settings.lastRuleAudit?.reviewedAt ?? Date.now()) + intervalMs
  const arm = (): void => {
    const remaining = dueAt - Date.now()
    if (remaining <= 0) {
      void runLlmRuleAudit(approvalPolicy, 'scheduled')
        .catch(() => undefined)
        .finally(() => scheduleLlmRuleAudit(approvalPolicy))
      return
    }
    llmRuleAuditTimer = setTimeout(arm, Math.min(remaining, 2_000_000_000))
    llmRuleAuditTimer.unref?.()
  }
  arm()
}

async function restoreNativeSessionProvider(session: SessionSummary | undefined): Promise<boolean> {
  if (!session || session.agentKind !== 'codex' || !session.nativeSessionId) return true
  try {
    const provider = await readCodexGlobalProvider()
    const executable = resolveExecutableForPty('codex')
    const fallback = await migrateCodexSessionProvider(session.nativeSessionId, provider.id)
    if (fallback.changed) await migrateCodexProviderOfficial({ executable, sessionId: session.nativeSessionId, providerId: provider.id, cwd: session.workspace })
    if (fallback.changed) {
      recordAudit({ level: 'info', category: 'session', action: 'native_provider_restored', message: '已将 Codex 历史会话恢复为本机全局 Provider', sessionId: session.sessionId, details: { provider: provider.id } })
    }
    return true
  } catch (error) {
    recordAudit({ level: 'error', category: 'session', action: 'native_provider_restore_failed', message: 'Codex 历史会话 Provider 恢复失败，已保留 Manager 会话以便重试', sessionId: session.sessionId, details: { error: error instanceof Error ? error.message : String(error) } })
    return false
  }
}

function registerIpc(approvalPolicy: ApprovalPolicyStore): void {
  ipcMain.handle(IPC_CHANNELS.getTerminalSettings, event => {
    trustedRenderer(event)
    return terminalSettingsStore.getSettings()
  })
  ipcMain.handle(IPC_CHANNELS.getAppearanceSettings, event => {
    trustedRenderer(event)
    return appearanceSettingsStore.getSettings()
  })
  ipcMain.handle(IPC_CHANNELS.updateAppearanceSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const settings = await appearanceSettingsStore.update(value)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.appearanceSettingsChanged, settings)
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.updateTerminalSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    return terminalSettingsStore.update(value)
  })
  ipcMain.handle(IPC_CHANNELS.getAttentionSoundSettings, event => {
    trustedRenderer(event)
    return attentionAudioSettingsStore.getSettings()
  })
  ipcMain.handle(IPC_CHANNELS.updateAttentionSoundSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const settings = await attentionAudioSettingsStore.update(parseAttentionAudioSettings(value))
    attentionAudioDelivery.settingsChanged()
    nativeAttentionAudio.stop()
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.testAttentionSound, (event, value: unknown) => {
    trustedRenderer(event)
    playAttentionChime(value === undefined ? undefined : parseAttentionAudioSettings(value))
  })
  ipcMain.on(IPC_CHANNELS.attentionSoundReady, (event, ready: unknown) => {
    try { trustedRenderer(event); if (typeof ready === 'boolean') attentionAudioDelivery.setReady(ready) } catch { /* Untrusted renderer. */ }
  })
  ipcMain.on(IPC_CHANNELS.attentionSoundResult, (event, id: unknown, success: unknown) => {
    try { trustedRenderer(event); attentionAudioDelivery.acknowledge(id, success) } catch { /* Untrusted renderer. */ }
  })
  ipcMain.handle(IPC_CHANNELS.setActiveSession, (event, id: unknown) => {
    trustedRenderer(event)
    const target = id === null ? undefined : sessionId(id)
    activeSessionId = target && controller.listSessions().some(session => session.sessionId === target) ? target : undefined
    if (activeSessionId && isAttentionSessionActive(activeSessionId, activeSessionId, mainWindow)) attentionSound.acknowledge(activeSessionId)
  })
  ipcMain.handle(IPC_CHANNELS.openExternalWeb, async (event, url: unknown) => {
    trustedRenderer(event)
    await openExternalWeb(url)
  })
  ipcMain.handle(IPC_CHANNELS.openDeepSeekWeb, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    await deepSeekWebWindows.open(controller.listSessions().find(item => item.sessionId === target), mainWindow!)
  })
  ipcMain.handle(IPC_CHANNELS.listSessions, (event) => {
    trustedRenderer(event)
    return controller.listSessions()
  })
  ipcMain.handle(IPC_CHANNELS.openSessionWorkspace, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    await openSessionWorkspace(controller.listSessions().find(item => item.sessionId === target))
  })
  ipcMain.handle(IPC_CHANNELS.terminalReplay, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.terminalReplay(sessionId(id))
  })
  ipcMain.handle(IPC_CHANNELS.listAuditEntries, (event) => {
    trustedRenderer(event)
    return auditStore.list()
  })
  ipcMain.handle(IPC_CHANNELS.listTokenUsageSummary, async (event, value: unknown) => {
    trustedRenderer(event)
    const query = value && typeof value === 'object' ? value as import('../src/shared/manager-api').TokenUsageQuery : {}
    return tokenUsageStore.listSummary(query, controller.listSessions())
  })
  ipcMain.handle(IPC_CHANNELS.listTokenUsageDetails, async (event, value: unknown) => {
    trustedRenderer(event)
    const query = value && typeof value === 'object' ? value as import('../src/shared/manager-api').TokenUsageQuery : {}
    return tokenUsageStore.listDetails(query, controller.listSessions())
  })
  const continuations = new SessionContinuationService(controller, agentConfigurationStore, agentProxyStore)
  ipcMain.handle(IPC_CHANNELS.createContinuation, async (event, id: unknown) => {
    trustedRenderer(event)
    const sourceId = sessionId(id)
    const result = await continuations.create(sourceId)
    recordAudit({ level: result.warning ? 'warning' : 'info', category: 'session', action: 'session_continuation_created',
      message: result.warning ?? `${result.session.displayName} 已启动，并通过 CLI 首条提示词请求读取旧会话继续开发`, sessionId: result.session.sessionId,
      details: { sourceSessionId: sourceId } })
    return result
  })
  ipcMain.handle(IPC_CHANNELS.startSession, async (event, request: unknown) => {
    trustedRenderer(event)
    const validated = startRequest(request)
    return nativeResumeCoordinator.run(validated, () => controller.listSessions(), async () => {
    recordAudit({ level: 'info', category: 'session', action: 'session_start_requested', message: `正在启动 ${validated.displayName}`, details: { displayName: validated.displayName, agentKind: validated.agentKind, workspace: validated.workspace } })
    let createdProfileId: string | undefined
    let createdProxyId: string | undefined
    try {
      const agentConfig = validated.agentConfig && !('hasApiKey' in validated.agentConfig)
        ? await agentConfigurationStore.save(await resolvedAgentConfig(validated.agentKind, validated.agentConfig))
        : AgentConfigurationStore.localSummary(
          validated.agentConfig?.networkRetry,
          validated.agentConfig?.autoCompactTokens,
        )
      createdProfileId = agentConfig.profileId
      const agentProxy = validated.agentProxy && !('hasPassword' in validated.agentProxy)
        ? await agentProxyStore.save(validated.agentProxy)
        : undefined
      createdProxyId = agentProxy?.proxyId
      const session = await controller.startSession({ ...validated, agentConfig, ...(agentProxy ? { agentProxy } : {}) })
      await controller.flushCatalog()
      recordAudit({ level: 'info', category: 'session', action: 'session_started', message: `${session.displayName} 已启动`, sessionId: session.sessionId })
      return session
    } catch (error) {
      if (createdProfileId) await agentConfigurationStore.remove(createdProfileId).catch(() => undefined)
      if (createdProxyId) await agentProxyStore.remove(createdProxyId).catch(() => undefined)
      recordAudit({ level: 'error', category: 'session', action: 'session_start_failed', message: `${validated.displayName} 启动失败`, details: { displayName: validated.displayName, agentKind: validated.agentKind, workspace: validated.workspace, error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
    })
  })
  ipcMain.handle(IPC_CHANNELS.write, (event, id: unknown, data: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const input = terminalInput(data)
    if (/[\r\n\x03]/.test(input)) questionSignals.get(target)?.signal.reset()
    const before = controller.listPendingApprovals().filter((request) => request.sessionId === target)
    const result = controller.write(target, input)
    const afterIds = new Set(controller.listPendingApprovals().filter((request) => request.sessionId === target).map((request) => request.requestId))
    const handled = before.find((request) => !afterIds.has(request.requestId))
    if (handled) {
      recordAudit({
        level: 'info', category: 'approval', action: 'approval_manual_terminal',
        message: '已在原生终端批准 ' + (handled.toolName ?? approvalSubject(handled.command)),
        sessionId: target,
        details: {
          requestId: handled.requestId,
          toolName: handled.toolName ?? approvalSubject(handled.command),
          ...(handled.command ? { command: handled.command } : {}),
          ...approvalReasonDetails(handled),
          risk: handled.risk,
        },
      })
    }
    return result
  })
  ipcMain.handle(IPC_CHANNELS.exportAuditEntries, async (event, ids: unknown) => {
    trustedRenderer(event)
    if (!Array.isArray(ids) || ids.length > 2_000 || ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id))) throw new Error('审计导出范围无效')
    const selected = new Set(ids)
    const entries = auditStore.list().filter((entry) => selected.has(entry.id)).map(safeAuditExport)
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出活动审计',
      defaultPath: `agent-tui-audit-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return undefined
    await writeFile(result.filePath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2), 'utf8')
    recordAudit({ level: 'info', category: 'session', action: 'audit_exported', message: '已导出活动审计', details: { entryCount: entries.length } })
    return result.filePath
  })
  ipcMain.handle(IPC_CHANNELS.resize, (event, id: unknown, cols: unknown, rows: unknown) => {
    trustedRenderer(event)
    const size = dimensions(cols, rows)
    controller.resize(sessionId(id), size.cols, size.rows)
  })
  ipcMain.handle(IPC_CHANNELS.stopSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    recordAudit({ level: 'info', category: 'session', action: 'session_stop_requested', message: '正在停止 Agent', sessionId: target })
    await controller.stopSession(target)
    await restoreNativeSessionProvider(controller.listSessions().find((session) => session.sessionId === target))
    recordAudit({ level: 'info', category: 'session', action: 'session_stopped', message: 'Agent 已停止', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.restartSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    recordAudit({ level: 'info', category: 'session', action: 'session_restart_requested', message: '正在重新启动 Agent', sessionId: target })
    try {
      await controller.restartSession(target)
    } catch (error) {
      recordAudit({ level: 'error', category: 'session', action: 'session_restart_failed', message: 'Agent 重新启动失败', sessionId: target,
        details: { error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
    recordAudit({ level: 'info', category: 'session', action: 'session_restarted', message: 'Agent 已重新启动', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.continueSession, (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    controller.continueSession(target)
    recordAudit({ level: 'info', category: 'recovery', action: 'manual_continue', message: '已手动继续 Agent，并重置自动重试次数', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.tryRecoveryOnce, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    await controller.tryRecoveryOnce(target)
    recordAudit({ level: 'info', category: 'recovery', action: 'recovery_tried_once', message: '已按用户要求尝试恢复一次', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.acceptRecoverySuggestion, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    await controller.acceptRecoverySuggestion(target)
    recordAudit({ level: 'info', category: 'rule', action: 'recovery_rule_added', message: '已采纳异常原因，未来同类异常只自动尝试一次', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.dismissRecoverySuggestion, (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    controller.dismissRecoverySuggestion(target)
    recordAudit({ level: 'info', category: 'recovery', action: 'recovery_dismissed', message: '已忽略本次异常恢复建议', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.removeSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const removed = controller.listSessions().find((session) => session.sessionId === target)
    if (!await restoreNativeSessionProvider(removed)) throw new Error('Codex 历史会话尚未恢复，暂不删除 Manager 条目，请稍后重试')
    await controller.removeSession(target)
    if (removed?.agentConfig?.profileId) await agentConfigurationStore.remove(removed.agentConfig.profileId)
    if (removed?.agentProxy?.proxyId) await agentProxyStore.remove(removed.agentProxy.proxyId)
    recordAudit({
      level: 'info', category: 'session', action: 'session_removed', message: 'Agent 已从总览删除', sessionId: target,
      ...(removed ? { details: { displayName: removed.displayName, agentKind: removed.agentKind, workspace: removed.workspace } } : {}),
    })
  })
  ipcMain.handle(IPC_CHANNELS.detachSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const detached = controller.listSessions().find((session) => session.sessionId === target)
    if (!detached) throw new Error('Agent 不存在或已删除')
    if ((detached.agentKind !== 'codex' && detached.agentKind !== 'claude') || !detached.nativeSessionId) throw new Error('只有已建立原生会话 ID 的 Codex 或 Claude Code 可以拖出到原生终端')
    if (!['completed', 'stopped', 'failed'].includes(detached.status)) await controller.stopSession(target)
    if (!await restoreNativeSessionProvider(detached)) throw new Error('原生会话配置尚未恢复，已保留 Manager 卡片，请稍后重试')
    await openNativeResumeTerminal(detached.agentKind, detached.nativeSessionId, detached.workspace)
    await controller.removeSession(target)
    if (detached.agentConfig?.profileId) await agentConfigurationStore.remove(detached.agentConfig.profileId)
    if (detached.agentProxy?.proxyId) await agentProxyStore.remove(detached.agentProxy.proxyId)
    recordAudit({ level: 'info', category: 'session', action: 'session_detached', message: detached.displayName + ' 已脱离 Manager 并在原生终端恢复', details: { displayName: detached.displayName, agentKind: detached.agentKind, workspace: detached.workspace, nativeSessionId: detached.nativeSessionId } })
  })
  ipcMain.handle(IPC_CHANNELS.approveSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const request = controller.listPendingApprovals().find((item) => item.sessionId === target)
    await controller.approveSession(target)
    recordAudit({
      level: 'info', category: 'approval', action: 'approval_manual',
      message: '已人工批准 ' + (request?.toolName ?? approvalSubject(request?.command)),
      sessionId: target,
      details: {
        requestId: request?.requestId ?? 'legacy',
        toolName: request?.toolName ?? approvalSubject(request?.command),
        ...(request?.command ? { command: request.command } : {}),
        ...approvalReasonDetails(request),
        ...(request?.risk ? { risk: request.risk } : {}),
      },
    })
  })
  ipcMain.handle(IPC_CHANNELS.renameSession, async (event, id: unknown, name: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const before = controller.listSessions().find((session) => session.sessionId === target)?.displayName ?? 'Agent'
    const displayName = text(name, 'displayName', 120).trim()
    if (!displayName || /[\r\n]/.test(displayName)) throw new Error('Agent 名称应为 1 到 120 个字符')
    await controller.renameSession(target, displayName)
    recordAudit({ level: 'info', category: 'session', action: 'session_renamed', message: `${before} 已重命名为 ${displayName}`, sessionId: target, details: { before, after: displayName } })
  })
  ipcMain.handle(IPC_CHANNELS.listBindingSessions, async (event, id: unknown) => {
    trustedRenderer(event)
    const session = controller.listSessions().find(item => item.sessionId === sessionId(id))
    if (!session) throw new Error('Agent 不存在或已删除')
    return sessionCatalog.nameHistory(session.agentKind, await discoverBindableSessions(session.agentKind, session.workspace))
  })
  ipcMain.handle(IPC_CHANNELS.replaceSessionBinding, async (event, id: unknown, target: unknown) => {
    trustedRenderer(event)
    const currentId = sessionId(id)
    const nativeId = target === null ? null : text(target, 'nativeSessionId', 512)
    const session = controller.listSessions().find(item => item.sessionId === currentId)
    if (!session) throw new Error('Agent 不存在或已删除')
    if (nativeId && !(await discoverBindableSessions(session.agentKind, session.workspace)).some(item => item.id === nativeId)) throw new Error('该目录下找不到有效的对话文件，请刷新列表后重试')
    await controller.replaceSessionBinding(currentId, nativeId)
    recordAudit({ level: 'info', category: 'session', action: 'session_binding_replaced', message: nativeId ? '已重新关联原生会话' : '已按原配置开启新会话', sessionId: currentId, details: { previous: session.nativeSessionId ?? '', current: nativeId ?? '' } })
  })
  ipcMain.handle(IPC_CHANNELS.updateSessionConfig, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const input = agentConfigInput(value)
    const session = controller.listSessions().find((item) => item.sessionId === target)
    if (!session) throw new Error('Agent 不存在或已删除')
    const existingProfileId = session.agentConfig?.profileId
    parseAutoCompactTokens(input.autoCompactTokens, session.agentKind)
    const summary = input.enabled
      ? await agentConfigurationStore.save(await resolvedAgentConfig(session.agentKind, input), existingProfileId)
      : AgentConfigurationStore.localSummary(input.networkRetry, input.autoCompactTokens)
    await controller.updateSessionConfig(target, summary)
    tokenUsageStore.noteSessionConfig(target, summary)
    if (!summary.enabled && existingProfileId) await agentConfigurationStore.remove(existingProfileId)
    recordAudit({
      level: 'info', category: 'session', action: 'session_config_updated',
      message: summary.enabled ? `${session.displayName} 已保存独立配置，将在下次启动时生效` : `${session.displayName} 已恢复继承本机配置`,
      sessionId: target,
      details: { source: summary.source, model: summary.model ?? 'inherit', hasApiKey: summary.hasApiKey, ...(summary.providerId ? { providerId: summary.providerId } : {}), ...(summary.providerName ? { providerName: summary.providerName } : {}) },
    })
  })
  ipcMain.handle(IPC_CHANNELS.updateSessionProxy, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const input = agentProxyInput(value)
    const session = controller.listSessions().find((item) => item.sessionId === target)
    if (!session) throw new Error('Agent 不存在或已删除')
    const existingProxyId = session.agentProxy?.proxyId
    const summary = input.enabled ? await agentProxyStore.save(input, existingProxyId) : undefined
    await controller.updateSessionProxy(target, summary)
    if (!summary && existingProxyId) await agentProxyStore.remove(existingProxyId)
    recordAudit({
      level: 'info', category: 'session', action: 'session_proxy_updated',
      message: summary ? `${session.displayName} 已保存 HTTP 代理，将在下次启动时生效` : `${session.displayName} 已关闭代理`,
      sessionId: target,
      details: summary ? { protocol: summary.protocol, host: summary.host, port: summary.port, authenticated: Boolean(summary.username || summary.hasPassword) } : { enabled: false },
    })
  })
  ipcMain.handle(IPC_CHANNELS.setApprovalMode, async (event, id: unknown, mode: unknown, settings: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    if (!isApprovalMode(mode)) throw new Error('审批模式无效')
    await controller.setApprovalMode(target, mode, settings === undefined ? undefined : parseUnattendedSettings(settings))
    recordAudit({ level: mode === 'manual' ? 'info' : 'warning', category: 'approval', action: 'approval_mode_changed',
      message: '已切换为' + APPROVAL_MODE_LABEL[mode], sessionId: target, details: { mode } })
  })
  ipcMain.handle(IPC_CHANNELS.setFullAutoMode, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    if (typeof value !== 'boolean') throw new Error('全自动模式状态无效')
    const session = controller.listSessions().find((item) => item.sessionId === target)
    if (!session) throw new Error('Agent 不存在或已删除')
    await controller.setFullAutoMode(target, value)
    recordAudit({
      level: value ? 'warning' : 'info',
      category: 'approval',
      action: value ? 'full_auto_enabled' : 'full_auto_disabled',
      message: value ? session.displayName + ' 已开启全自动模式' : session.displayName + ' 已关闭全自动模式',
      sessionId: target,
      details: { enabled: value, deletionAllowed: false, workspaceEscapeAllowed: false },
    })
  })
  ipcMain.handle(IPC_CHANNELS.setUnattendedMode, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无监管配置无效')
    const input = value as Record<string, unknown>
    if (input.enabled === false) {
      await controller.setUnattendedMode(sessionId(id), { enabled: false, recoveryWord: '' })
      return
    }
    await controller.setUnattendedMode(sessionId(id), parseUnattendedSettings(value))
  })
  ipcMain.handle(IPC_CHANNELS.saveUnattendedSettings, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    await controller.saveUnattendedSettings(sessionId(id), parseUnattendedSettings(value))
  })
  ipcMain.handle(IPC_CHANNELS.listProviderModels, async (event, value: unknown) => {
    trustedRenderer(event)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型查询参数无效')
    const input = value as Record<string, unknown>
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 4096) throw new Error('Base URL 无效')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16384)) throw new Error('API Key 无效')
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined
    if (input.sessionId !== undefined) {
      const target = sessionId(input.sessionId)
      const session = controller.listSessions().find(item => item.sessionId === target)
      if (!session) throw new Error('Agent 不存在或已删除')
      if (!apiKey && input.clearApiKey !== true && session.agentConfig?.profileId) {
        const saved = await agentConfigurationStore.get(session.agentConfig.profileId)
        // 更换地址时禁止静默将旧密钥发给新的服务器。
        if (saved?.apiKey && saved.baseUrl?.replace(/\/+$/, '') !== input.baseUrl.trim().replace(/\/+$/, '')) throw new Error('Base URL 已修改，请重新填写 API Key 后获取模型')
        apiKey = saved?.apiKey
      }
    }
    return fetchProviderModels(input.baseUrl, input.clearApiKey === true ? undefined : apiKey)
  })
  ipcMain.handle(IPC_CHANNELS.listCCSwitchProviders, (event, kind: unknown) => {
    trustedRenderer(event)
    const agentKind = validatedAgentKind(kind)
    if (agentKind !== 'codex' && agentKind !== 'claude') throw new Error('CCSwitch 当前仅支持 Codex 和 Claude Code')
    return ccSwitchProviderReader.list(agentKind)
  })
  ipcMain.handle(IPC_CHANNELS.getContinueKeywordSettings, (event) => {
    trustedRenderer(event)
    return continueKeywordStore.getSettings()
  })
  ipcMain.handle(IPC_CHANNELS.updateContinueKeywordSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const settings = await continueKeywordStore.update(continueKeywordSettings(value))
    recordAudit({
      level: settings.enabled ? 'warning' : 'info',
      category: 'rule',
      action: 'continue_keyword_settings_updated',
      message: settings.enabled ? '已开启关键词 Continue（' + settings.keywords.length + ' 条规则）' : '已关闭关键词 Continue',
      details: { enabled: settings.enabled, keywordCount: settings.keywords.length, maxRetries: settings.maxRetries ?? 3 },
    })
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.getSessionSafetySettings, (event) => {
    trustedRenderer(event)
    return sessionSafetyStore.getSettings()
  })
  ipcMain.handle(IPC_CHANNELS.updateSessionSafetySettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const saved = await sessionSafetyStore.update(sessionSafetySettings(value))
    controller.updateCrashRetentionPolicy(saved.preserveWorkspaceOnCrash)
    recordAudit({
      level: 'info', category: 'session', action: 'crash_retention_changed',
      message: saved.preserveWorkspaceOnCrash ? '异常退出后将保留运行中的 Agent 并在下次启动接管' : '异常退出后将停止 Agent、释放进程，目录记录仍保留供下次恢复',
      details: { preserveWorkspaceOnCrash: saved.preserveWorkspaceOnCrash },
    })
    return saved
  })
  ipcMain.handle(IPC_CHANNELS.getDingTalkSettings, (event) => {
    trustedRenderer(event)
    return { ...dingTalkSettingsStore.getSummary(), ...dingTalkStreamService.getStatus() }
  })
  ipcMain.handle(IPC_CHANNELS.updateDingTalkSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const saved = await dingTalkSettingsStore.update(dingTalkSettings(value))
    recordAudit({
      level: 'warning', category: 'remote', action: 'remote_settings_changed',
      message: saved.enabled ? '已更新并启用钉钉远程开发' : '已关闭钉钉远程开发',
      details: { enabled: saved.enabled, bound: Boolean(saved.boundStaffId), agentModeEnabled: saved.agentModeEnabled },
    })
    try {
      await dingTalkStreamService.restart(dingTalkSettingsStore.getRuntimeSettings())
    } catch (error) {
      recordAudit({ level: 'error', category: 'remote', action: 'remote_connection_failed', message: '钉钉 Stream 连接失败', details: { error: error instanceof Error ? error.message : String(error) } })
    }
    return { ...dingTalkSettingsStore.getSummary(), ...dingTalkStreamService.getStatus() }
  })
  ipcMain.handle(IPC_CHANNELS.resetDingTalkBinding, async (event) => {
    trustedRenderer(event)
    const saved = await dingTalkSettingsStore.resetBinding()
    recordAudit({ level: 'warning', category: 'remote', action: 'remote_binding_reset', message: '已解除钉钉账号绑定并生成新的初始化 Key' })
    return { ...saved, ...dingTalkStreamService.getStatus() }
  })
  ipcMain.handle(IPC_CHANNELS.listPendingApprovals, (event) => {
    trustedRenderer(event)
    return controller.listPendingApprovals()
  })
  ipcMain.handle(IPC_CHANNELS.approveRequest, async (event, id: unknown) => {
    trustedRenderer(event)
    const requestId = approvalRequestId(id)
    const request = controller.listPendingApprovals().find((item) => item.requestId === requestId)
    await controller.approveRequest(requestId)
    recordAudit({
      level: 'info', category: 'approval', action: 'approval_manual',
      message: '已人工批准 ' + (request?.toolName ?? approvalSubject(request?.command)),
      sessionId: request?.sessionId,
      details: {
        requestId,
        toolName: request?.toolName ?? approvalSubject(request?.command),
        ...(request?.command ? { command: request.command } : {}),
        ...approvalReasonDetails(request),
        ...(request?.risk ? { risk: request.risk } : {}),
      },
    })
  })
  ipcMain.handle(IPC_CHANNELS.approveAndRememberRequest, async (event, id: unknown) => {
    trustedRenderer(event)
    const requestId = approvalRequestId(id)
    const request = controller.listPendingApprovals().find((item) => item.requestId === requestId)
    await controller.approveAndRememberRequest(requestId)
    recordAudit({
      level: 'info', category: 'approval', action: 'approval_remembered',
      message: '已批准并记为安全命令：' + (request?.toolName ?? approvalSubject(request?.command)),
      sessionId: request?.sessionId,
      details: {
        requestId,
        toolName: request?.toolName ?? approvalSubject(request?.command),
        ...(request?.command ? { command: request.command } : {}),
        ...approvalReasonDetails(request),
        ...(request?.risk ? { originalRisk: request.risk } : {}),
      },
    })
  })
  ipcMain.handle(IPC_CHANNELS.rejectRequest, async (event, id: unknown) => {
    trustedRenderer(event)
    const requestId = approvalRequestId(id)
    const request = controller.listPendingApprovals().find((item) => item.requestId === requestId)
    await controller.rejectRequest(requestId)
    recordAudit({
      level: 'warning', category: 'approval', action: 'approval_rejected',
      message: '已拒绝 ' + (request?.toolName ?? approvalSubject(request?.command)),
      sessionId: request?.sessionId,
      details: {
        requestId,
        toolName: request?.toolName ?? approvalSubject(request?.command),
        ...(request?.command ? { command: request.command } : {}),
        ...approvalReasonDetails(request),
        ...(request?.risk ? { risk: request.risk } : {}),
      },
    })
  })
  ipcMain.handle(IPC_CHANNELS.approveAllPending, async (event) => {
    trustedRenderer(event)
    const result = await controller.approveAllPending()
    recordAudit({
      level: result.failed > 0 ? 'warning' : 'info', category: 'approval', action: 'approval_bulk',
      message: '批量审批完成：批准 ' + result.approved + ' 项，跳过 ' + result.skipped + ' 项，失败 ' + result.failed + ' 项',
      details: { approved: result.approved, skipped: result.skipped, failed: result.failed },
    })
    return result
  })
  ipcMain.handle(IPC_CHANNELS.acceptApprovalSuggestion, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.acceptApprovalSuggestion(sessionId(id))
  })
  ipcMain.handle(IPC_CHANNELS.dismissApprovalSuggestion, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.dismissApprovalSuggestion(sessionId(id))
  })
  ipcMain.handle(IPC_CHANNELS.listApprovalRules, (event) => {
    trustedRenderer(event)
    return approvalPolicy.listRules()
  })
  ipcMain.handle(IPC_CHANNELS.addApprovalRule, async (event, command: unknown) => {
    trustedRenderer(event)
    await approvalPolicy.addRule(text(command, 'approval rule', 2_048))
    await controller.refreshApprovalPolicy()
    recordAudit({ level: 'info', category: 'rule', action: 'rule_added', message: '已添加自动批准规则' })
  })
  ipcMain.handle(IPC_CHANNELS.removeApprovalRule, async (event, command: unknown) => {
    trustedRenderer(event)
    await approvalPolicy.removeRule(text(command, 'approval rule', 2_048))
    await controller.refreshApprovalPolicy()
    recordAudit({ level: 'info', category: 'rule', action: 'rule_removed', message: '已撤销自动批准规则' })
  })
  ipcMain.handle(IPC_CHANNELS.listDangerRules, (event) => {
    trustedRenderer(event)
    return approvalPolicy.listDangerRules()
  })
  ipcMain.handle(IPC_CHANNELS.addDangerRule, async (event, value: unknown) => {
    trustedRenderer(event)
    if (!value || typeof value !== 'object') throw new Error('高危规则内容无效')
    const input = value as Record<string, unknown>
    const rule = await approvalPolicy.addDangerRule({
      name: text(input.name, 'danger rule name', 80),
      keyword: text(input.keyword, 'danger rule keyword', 256),
    })
    await controller.refreshApprovalPolicy()
    recordAudit({
      level: 'warning', category: 'rule', action: 'danger_rule_added',
      message: '已添加自定义高危规则「' + rule.name + '」',
      details: { ruleId: rule.id, keyword: rule.pattern },
    })
    return rule
  })
  ipcMain.handle(IPC_CHANNELS.setDangerRuleEnabled, async (event, id: unknown, enabled: unknown) => {
    trustedRenderer(event)
    if (typeof enabled !== 'boolean') throw new Error('高危规则启用状态无效')
    const ruleId = text(id, 'danger rule id', 128)
    await approvalPolicy.setDangerRuleEnabled(ruleId, enabled)
    await controller.refreshApprovalPolicy()
    recordAudit({
      level: 'warning', category: 'rule', action: enabled ? 'danger_rule_enabled' : 'danger_rule_disabled',
      message: enabled ? '已启用自定义高危规则' : '已停用自定义高危规则',
      details: { ruleId },
    })
  })
  ipcMain.handle(IPC_CHANNELS.removeDangerRule, async (event, id: unknown) => {
    trustedRenderer(event)
    const ruleId = text(id, 'danger rule id', 128)
    await approvalPolicy.removeDangerRule(ruleId)
    await controller.refreshApprovalPolicy()
    recordAudit({
      level: 'warning', category: 'rule', action: 'danger_rule_removed',
      message: '已删除自定义高危规则',
      details: { ruleId },
    })
  })
  ipcMain.handle(IPC_CHANNELS.testDangerCommand, (event, command: unknown) => {
    trustedRenderer(event)
    return approvalPolicy.testDangerCommand(text(command, 'danger command test', 16_384))
  })
  ipcMain.handle(IPC_CHANNELS.getLlmReviewSettings, (event) => {
    trustedRenderer(event)
    return { ...llmReviewSettingsStore.getSummary(), ruleAuditState: { ...llmRuleAuditState } }
  })
  ipcMain.handle(IPC_CHANNELS.listLlmReviewModels, (event, value: unknown, reviewerId?: unknown) => {
    trustedRenderer(event)
    return listLlmReviewModels(llmReviewSettingsStore.preview(llmReviewSettings(value), reviewerId === undefined ? undefined : text(reviewerId, '审核器 ID', 200)))
  })
  ipcMain.handle(IPC_CHANNELS.testLlmReviewer, (event, value: unknown, reviewerId?: unknown) => {
    trustedRenderer(event)
    return llmSecurityReviewer.testConnection(llmReviewSettingsStore.preview(llmReviewSettings(value), reviewerId === undefined ? undefined : text(reviewerId, '审核器 ID', 200)))
  })
  ipcMain.handle(IPC_CHANNELS.importLlmReviewer, async (event, value: unknown) => {
    trustedRenderer(event)
    if (!value || typeof value !== 'object') throw new Error('CC Switch Provider 选择无效')
    const input = value as Record<string, unknown>
    if (input.agentKind !== 'codex' && input.agentKind !== 'claude') throw new Error('CC Switch 审核器仅支持 Codex 和 Claude 配置')
    const saved = await importLlmReviewer({ agentKind: input.agentKind, providerId: text(input.providerId, 'Provider ID', 200) }, ccSwitchProviderReader, llmReviewSettingsStore)
    await controller.refreshApprovalPolicy()
    return { ...saved, ruleAuditState: { ...llmRuleAuditState } }
  })
  ipcMain.handle(IPC_CHANNELS.updateLlmReviewSettings, async (event, value: unknown) => {
    trustedRenderer(event)
    const saved = await llmReviewSettingsStore.update(llmReviewSettings(value))
    if (llmRuleAuditState.status === 'failed') llmRuleAuditState = { status: 'idle' }
    await controller.refreshApprovalPolicy()
    scheduleLlmRuleAudit(approvalPolicy)
    recordAudit({
      level: saved.enabled || saved.scheduledRuleAuditEnabled ? 'warning' : 'info',
      category: 'review', action: 'llm_review_settings_changed',
      message: saved.enabled ? `已启用 LLM 安全审查（${saved.level}）` : '已关闭运行时 LLM 安全审查',
      details: {
        enabled: saved.enabled, level: saved.level,
        scheduledRuleAuditEnabled: saved.scheduledRuleAuditEnabled,
        scheduledRuleAuditHours: saved.scheduledRuleAuditHours,
        timeoutSeconds: saved.timeoutSeconds,
        model: saved.model ?? 'not-configured', proxyEnabled: saved.proxyEnabled,
      },
    })
    return { ...saved, ruleAuditState: { ...llmRuleAuditState } }
  })
  ipcMain.handle(IPC_CHANNELS.reviewApprovalRules, (event) => {
    trustedRenderer(event)
    void runLlmRuleAudit(approvalPolicy, 'manual')
      .catch(() => undefined)
      .finally(() => scheduleLlmRuleAudit(approvalPolicy))
    return { ...llmRuleAuditState }
  })
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    trustedRenderer(event)
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return undefined
    const selected = result.filePaths[0]
    return selected && isAbsolute(selected) ? selected : undefined
  })
  ipcMain.handle(IPC_CHANNELS.discoverSessions, async (event, kind: unknown, selectedWorkspace: unknown) => {
    trustedRenderer(event)
    const agentKind = validatedAgentKind(kind)
    const discovered = await coalescedDiscovery(agentKind, workspace(selectedWorkspace))
    return sessionCatalog.nameHistory(agentKind, discovered)
  })
  ipcMain.handle(IPC_CHANNELS.discoverRecentCodexSessions, async (event) => {
    trustedRenderer(event)
    const discovered = sessionCatalog.nameHistory('codex', await discoverGlobalCodexSessions({ limit: 50 }))
    const managed = controller.listSessions().filter(session => session.agentKind === 'codex'
      && !['stopped', 'failed', 'completed'].includes(session.status))
    return discovered.map(item => {
      const existing = managed.find(session => session.nativeSessionId === item.id)
      return existing ? { ...item, managedSessionId: existing.sessionId } : item
    })
  })
  ipcMain.handle(IPC_CHANNELS.readClipboardText, (event) => {
    trustedRenderer(event)
    return clipboard.readText('clipboard')
  })
  ipcMain.handle(IPC_CHANNELS.chooseExecutable, async (event, kind: unknown) => {
    trustedRenderer(event)
    validatedAgentKind(kind)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: '可执行命令', extensions: ['exe', 'cmd', 'bat', 'com'] }, { name: '所有文件', extensions: ['*'] }],
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return undefined
    const selected = result.filePaths[0]
    if (!selected || !isAbsolute(selected) || !statSync(selected).isFile()) return undefined
    userSelectedExecutables.add(selected)
    return selected
  })
  ipcMain.handle(IPC_CHANNELS.detectAgentEnvironment, async (event, kind: unknown, candidate: unknown) => {
    trustedRenderer(event)
    const agentKind = validatedAgentKind(kind)
    const executableName = text(candidate, 'executable', 1_024)
    return detectAgentEnvironment(agentKind, executableName)
  })
  ipcMain.handle(IPC_CHANNELS.installNodeAndNpm, async (event) => {
    trustedRenderer(event)
    await installNodeAndNpm((progress) => broadcast({ type: 'agent-install-progress', progress: { target: 'node', ...progress } }))
  })
  ipcMain.handle(IPC_CHANNELS.installAgent, async (event, kind: unknown, registry: unknown, operation: unknown) => {
    trustedRenderer(event)
    const agentKind = validatedAgentKind(kind)
    const registryChoice = registry === undefined ? 'configured' : text(registry, 'npm registry', 32)
    if (!['configured', 'official', 'npmmirror', 'tencent', 'huawei'].includes(registryChoice)) throw new Error('不支持的 npm 镜像源')
    const mode = operation ?? 'install'
    if (mode !== 'install' && mode !== 'update') throw new Error('不支持的安装操作')
    if (mode === 'update' && controller.listSessions().some(session => session.agentKind === agentKind && !['stopped', 'completed', 'failed'].includes(session.status))) {
      throw new Error('请先停止正在运行的同类型 Agent，再更新 CLI；Manager 不会自动停止你的会话。')
    }
    await installAgent(agentKind, registryChoice as NpmRegistryChoice, (progress) => broadcast({ type: 'agent-install-progress', progress: { target: 'agent', agentKind, ...progress } }), mode)
  })
  ipcMain.handle(IPC_CHANNELS.installRipgrep, async (event) => {
    trustedRenderer(event)
    await installRipgrep((progress) => broadcast({ type: 'agent-install-progress', progress: { target: 'dependency', agentKind: 'pi', ...progress } }))
  })
  ipcMain.handle(IPC_CHANNELS.writeClipboardText, (event, value: unknown) => {
    trustedRenderer(event)
    clipboard.writeText(text(value, 'clipboard text', 4 * 1024 * 1024), 'clipboard')
  })
}

async function promptStartupWorkspace(window: BrowserWindow): Promise<void> {
  const ids = sessionCatalog.startupWorkspace().map(entry => entry.sessionId)
  const candidates = workspaceRestoreCandidates(ids, controller.listSessions())
  if (!candidates.length || window.isDestroyed()) return
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: '恢复上次工作区',
    message: `恢复上次启动的 ${candidates.length} 个 Agent？`,
    detail: candidates.map(item => `• ${item.displayName}（${item.agentKind}）`).join('\n')
      + '\n\n有绑定时恢复原生对话；确认尚未使用的空窗口可按原配置启动。无法确定旧对话时保留窗口供选择。规则和 Agent 审核模式保持，无监管仍需手动开启。',
    buttons: ['恢复上次工作区', '跳过'], defaultId: 0, cancelId: 1, noLink: true,
  })
  if (result.response !== 0 || window.isDestroyed() || quitting) return
  const restored = await restoreStartupWorkspace(ids, controller)
  await controller.flushCatalog()
  recordAudit({ level: restored.failed.length ? 'warning' : 'info', category: 'session', action: 'startup_workspace_restored',
    message: `已恢复 ${restored.restored.length} 个 Agent，${restored.failed.length} 个未恢复` })
  for (const failure of restored.failed) {
    recordAudit({ level: 'error', category: 'session', action: 'session_restart_failed', sessionId: failure.sessionId,
      message: failure.name + ' 启动恢复失败', details: { error: failure.reason } })
  }
  if (restored.failed.length && !window.isDestroyed()) await dialog.showMessageBox(window, {
    type: 'warning', title: '部分 Agent 未恢复', message: '其他 Agent 已继续恢复，以下窗口可在目录中手动处理。',
    detail: restored.failed.map(item => item.name + '：' + item.reason).join('\n'), buttons: ['知道了'],
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 860, minHeight: 600, backgroundColor: '#111719', autoHideMenuBar: true, icon: APP_LOGO_PATH,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  })
  window.setMenuBarVisibility(false)
  window.on('focus', () => {
    if (activeSessionId && isAttentionSessionActive(activeSessionId, activeSessionId, window)) attentionSound.acknowledge(activeSessionId)
  })
  window.webContents.on('render-process-gone', () => { activeSessionId = undefined; attentionAudioDelivery.setReady(false) })
  window.webContents.on('did-start-loading', () => { activeSessionId = undefined; attentionAudioDelivery.setReady(false) })
  routeExternalLinks(window.webContents)
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, 'renderer/index.html'))
  mainWindow = window
  return window
}

function createTray(): void {
  const icon = nativeImage.createFromPath(APP_LOGO_PATH)
  tray = new Tray(icon.resize({ width: 20, height: 20 }))
  tray.setToolTip('Agent TUI Manager')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开 Agent TUI Manager',
      click: () => {
        const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
        window.show()
        window.focus()
      },
    },
    {
      label: '停止所有 Agent 并释放会话',
      click: () => {
        void controller.stopAllSessions().then((count) => {
          recordAudit({
            level: 'warning', category: 'session', action: 'all_sessions_released',
            message: `已停止 ${count} 个 Agent，原生会话可在外部终端恢复`,
            details: { count },
          })
        })
      },
    },
    { type: 'separator' },
    {
      label: '退出 Manager',
      click: () => {
        void requestManagerQuit()
      },
    },
  ]))
  tray.on('click', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show(); window.focus()
  })
}

async function requestManagerQuit(): Promise<void> {
  if (quitPromptActive || quitPrepared) return
  quitPromptActive = true
  try {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '退出 Agent TUI Manager',
      message: '退出后是否让 Agent 继续运行？',
      detail: '继续运行：下次打开 Manager 接管仍存活的进程。\n停止进程：保留 Agent 目录和配置，下次启动提示恢复本次启动的原生会话。两种方式都会保存启动快照，已停止的 Agent 不加入快照。',
      buttons: ['继续运行并退出', '停止进程并退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (result.response === 2) return
    await sessionCatalog.captureWorkspaceBeforeExit()
    if (result.response === 0) {
      const count = await controller.preserveAllSessions()
      await controller.flushCatalog()
      recordAudit({ level: 'info', category: 'session', action: 'manager_exit_preserved', message: `已保留 ${count} 个运行中的 Agent，退出后继续运行`, details: { count } })
    } else {
      const sessions = controller.listSessions()
      await controller.stopAllSessions()
      for (const session of sessions) await restoreNativeSessionProvider(session)
      await controller.flushCatalog()
      recordAudit({ level: 'info', category: 'session', action: 'manager_exit_released', message: '已停止受管进程，保留目录、配置和启动快照', details: { count: sessions.length } })
    }
    quitPrepared = true
    quitting = true
    app.quit()
  } catch (error) {
    quitting = false
    quitPrepared = false
    sessionCatalog.startWorkspaceTracking()
    const message = error instanceof Error ? error.message : String(error)
    recordAudit({ level: 'error', category: 'session', action: 'manager_exit_preserve_failed', message: '保留 Agent 失败，Manager 未退出', details: { error: message } })
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: '未退出 Manager',
      message: '有 Agent 未确认保留状态，Manager 已取消退出。',
      detail: message,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true,
    }
    if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, options)
    else await dialog.showMessageBox(options)
  } finally {
    quitPromptActive = false
  }
}

if (!hasSingleInstanceLock) {
  quitPrepared = true
  quitting = true
  app.quit()
} else {
app.on('second-instance', () => {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

void app.whenReady().then(async () => {
  agentConfigurationStore = await AgentConfigurationStore.load(join(app.getPath('userData'), 'agent-configurations.json'), safeStorage)
  agentProxyStore = await AgentProxyStore.load(join(app.getPath('userData'), 'agent-proxies.json'), safeStorage)
  continueKeywordStore = await ContinueKeywordStore.load(join(app.getPath('userData'), 'continue-keywords.json'))
  sessionSafetyStore = await SessionSafetyStore.load(join(app.getPath('userData'), 'session-safety.json'))
  sessionCatalog = await ManagedSessionCatalog.load(join(app.getPath('userData'), 'managed-sessions.json'))
  terminalSettingsStore = await TerminalSettingsStore.load(join(app.getPath('userData'), 'terminal-settings.json'))
  appearanceSettingsStore = await AppearanceSettingsStore.load(join(app.getPath('userData'), 'appearance-settings.json'))
  attentionAudioSettingsStore = await AttentionAudioSettingsStore.load(join(app.getPath('userData'), 'attention-sound-settings.json'))
  dingTalkSettingsStore = await DingTalkSettingsStore.load(join(app.getPath('userData'), 'dingtalk-settings.json'), safeStorage)
  llmReviewSettingsStore = await LlmReviewSettingsStore.load(join(app.getPath('userData'), 'llm-review-settings.json'), safeStorage)
  const lastLlmRuleAudit = llmReviewSettingsStore.getRuntimeSettings().lastRuleAudit
  llmRuleAuditState = lastLlmRuleAudit
    ? { status: 'completed', completedAt: lastLlmRuleAudit.reviewedAt }
    : { status: 'idle' }
  const hostSocketDir = process.platform === 'darwin'
    ? join('/tmp', `agent-tui-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
    : undefined
  const manager = new SessionHostManager({
    getCodexTerminalMode: () => terminalSettingsStore.getSettings().codexMode,
    onStartupProgress: (progress) => recordAudit({
      level: progress.failed ? 'warning' : 'info', category: 'session', action: 'host_startup_phase',
      message: progress.failed ? '终端启动阶段失败' : progress.phase === 'complete' ? '终端启动握手完成' : '终端启动阶段完成',
      ...(progress.sessionId ? { sessionId: progress.sessionId } : {}),
      details: { hostId: progress.hostId, phase: progress.phase, elapsedMs: progress.elapsedMs, phaseElapsedMs: progress.phaseElapsedMs },
    }),
    runtimeDir: join(app.getPath('userData'), 'runtime', 'session-hosts'),
    ...(hostSocketDir ? { socketDir: hostSocketDir } : {}),
    hostEntry: join(__dirname, 'session-host.js'),
    preserveOnLeaseExpiry: sessionSafetyStore.getSettings().preserveWorkspaceOnCrash,
    resolveAgentConfig: async (profileId, agentKind, args) => {
      const profile = agentConfigurationStore.get(profileId)
      if (!profile) throw new Error('找不到该 Agent 的独立配置，请重新保存配置')
      const codexProvider = agentKind === 'codex' ? await readCodexGlobalProvider() : undefined
      return applyAgentLaunchProfile(agentKind, args, profile, codexProvider)
    },
    resolveAgentProxy: async (proxyId) => {
      const proxy = agentProxyStore.get(proxyId)
      if (!proxy) throw new Error('找不到该 Agent 的代理配置，请重新保存代理')
      return environmentForAgentProxy(proxy)
    },
  })
  const approvalPolicy = await ApprovalPolicyStore.load(join(app.getPath('userData'), 'approval-policy.json'))
  const recoveryPolicy = await RecoveryPolicyStore.load(join(app.getPath('userData'), 'recovery-policy.json'))
  auditStore = await ActivityAuditStore.load(join(app.getPath('userData'), 'activity-audit.json'))
  tokenUsageStore = new TokenUsageStore(join(app.getPath('userData'), 'token-usage.json'))
  await tokenUsageStore.load()
  const auditedApprovalPolicy = {
    decide(command: string | undefined) {
      const subject = approvalSubject(command)
      recordAudit({ level: 'warning', category: 'approval', action: 'approval_detected', message: `检测到 ${subject} 授权请求`, details: { subject, ...(command ? { command } : {}) } })
      const decision = approvalPolicy.decide(command)

      return decision
    },
    noteManualApproval: (command: string | undefined) => approvalPolicy.noteManualApproval(command),
    canBulkApproveCommand: (command: string | undefined) => approvalPolicy.canBulkApproveCommand(command),
    assessApprovalRequest: (input: Parameters<typeof approvalPolicy.assessApprovalRequest>[0]) => approvalPolicy.assessApprovalRequest(input),
    canFullAutoApprove: (input: Parameters<typeof approvalPolicy.canFullAutoApprove>[0]) => approvalPolicy.canFullAutoApprove(input),
    async addRule(command: string) {
      await approvalPolicy.addRule(command)
      recordAudit({ level: 'info', category: 'rule', action: 'learned_rule_accepted', message: '已接受学习建议并添加自动批准规则' })
    },
  }
  const fullAutoActivity = {
    pending(request: ApprovalRequest) {
      recordAudit({
        level: 'warning', category: 'approval', action: 'approval_waiting',
        message: (request.toolName ?? approvalSubject(request.command)) + ' 审批请求已接收',
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId,
          toolName: request.toolName ?? approvalSubject(request.command),
          workspace: request.workspace,
           ...approvalAuditDetails(request),
           risk: request.risk,
           ...approvalReasonDetails(request),
           ...(request.dangerRuleId ? { dangerRuleId: request.dangerRuleId } : {}),
           ...(request.dangerRuleName ? { dangerRuleName: request.dangerRuleName } : {}),
         },
      })
      const notifyWhenReady = (): void => {
        const current = controller.listPendingApprovals().find((item) => item.requestId === request.requestId)
        if (!current) return
        if (current.llmReviewStatus === 'pending') {
          const retry = setTimeout(notifyWhenReady, 500)
          retry.unref?.()
          return
        }
        const dingTalkSettings = dingTalkSettingsStore.getRuntimeSettings()
        void dingTalkStreamService?.notifyApproval(current, dingTalkSettings).then((sent) => {
          if (!sent) return
          recordAudit({
            level: 'info', category: 'remote', action: 'remote_approval_notified',
            message: '已向钉钉发送待审批提醒',
            sessionId: current.sessionId,
            details: { requestId: current.requestId, workspace: current.workspace, toolName: current.toolName ?? approvalSubject(current.command) },
          })
        }).catch((error) => {
          recordAudit({
            level: 'error', category: 'remote', action: 'remote_approval_notification_failed',
            message: '钉钉待审批提醒发送失败',
            sessionId: current.sessionId,
            details: { requestId: current.requestId, workspace: current.workspace, error: error instanceof Error ? error.message : String(error) },
          })
        })
      }
      const timer = setTimeout(notifyWhenReady, DINGTALK_APPROVAL_NOTIFICATION_DELAY_MS)
      timer.unref?.()
    },
    approved(request: ApprovalRequest) {
      recordAudit({
        level: 'warning', category: 'approval', action: 'full_auto_approved',
        message: '全自动模式已批准 ' + (request.toolName ?? approvalSubject(request.command)),
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId,
          toolName: request.toolName ?? approvalSubject(request.command),
          ...approvalAuditDetails(request),
          ...approvalReasonDetails(request),
          risk: request.risk,
          decision: 'full-auto',
        },
      })
    },
    blocked(request: ApprovalRequest, reason: string) {
      const manual = controller.listSessions().find(session => session.sessionId === request.sessionId)?.approvalMode === 'manual'
      if (manual) attentionSound.approvalNeedsUser(request)
      recordAudit({
        level: 'warning', category: 'approval', action: 'full_auto_blocked',
        message: (manual ? '审批需要人工处理：' : '自动审批处理异常：') + (request.toolName ?? approvalSubject(request.command)),
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId,
          toolName: request.toolName ?? approvalSubject(request.command),
          ...approvalAuditDetails(request),
          ...approvalReasonDetails(request),
          policyReason: reason,
          risk: request.risk,
          decision: 'blocked',
        },
      })
    },
    rejected(request: ApprovalRequest, reason: string) {
      recordAudit({ level: 'warning', category: 'approval', action: 'approval_auto_rejected',
        message: '已自动拒绝：' + (request.toolName ?? approvalSubject(request.command)), sessionId: request.sessionId,
        details: { requestId: request.requestId, policyReason: reason, decision: 'deny', ...approvalAuditDetails(request) } })
    },
    reviewStarted(request: ApprovalRequest) {
      recordAudit({
        level: 'info', category: 'review', action: 'llm_approval_review_started',
        message: '已启动 LLM 安全审查：' + (request.toolName ?? approvalSubject(request.command)),
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId, risk: request.risk,
          ...approvalAuditDetails(request),
          ...(request.dangerRuleName ? { dangerRuleName: request.dangerRuleName } : {}),
          level: llmReviewSettingsStore.getRuntimeSettings().level,
        },
      })
    },
    reviewed(request: ApprovalRequest, conclusion: NonNullable<ApprovalRequest['llmReview']>) {
      recordAudit({
        level: conclusion.verdict === 'allow' ? 'info' : 'warning',
        category: 'review', action: 'llm_approval_review_completed',
        message: 'LLM 审查结论：' + conclusion.summary,
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId, verdict: conclusion.verdict,
          riskScore: conclusion.riskScore, requiresHumanApproval: conclusion.requiresHumanApproval,
          automaticDecision: conclusion.verdict === 'allow' && !conclusion.requiresHumanApproval ? 'allow' : 'deny',
          model: conclusion.model, reasons: JSON.stringify(conclusion.reasons),
          ...(conclusion.reviewerId ? { reviewerId: conclusion.reviewerId, reviewerName: conclusion.reviewerName ?? '' } : {}),
          ...(conclusion.attempts ? { reviewerAttempts: JSON.stringify(conclusion.attempts) } : {}),
          hazards: JSON.stringify(conclusion.hazards), assumptions: JSON.stringify(conclusion.assumptions),
          ...approvalAuditDetails(request),
        },
      })
    },
    reviewFailed(request: ApprovalRequest, error: string) {
      recordAudit({
        level: 'error', category: 'review', action: 'llm_approval_review_failed',
        message: 'LLM 安全审查失败，本次请求将拒绝，不转人工', sessionId: request.sessionId,
        details: { requestId: request.requestId, error, automaticDecision: 'deny', ...(request.llmReview?.attempts ? { reviewerAttempts: JSON.stringify(request.llmReview.attempts) } : {}), ...approvalAuditDetails(request) },
      })
    },
  }
  const recoveryActivity = {
    keywordMatched(sessionId: string, keyword: string) {
      recordAudit({ level: 'info', category: 'recovery', action: 'continue_keyword_matched', message: '命中 Continue 关键词，校验 Agent 状态', sessionId, details: { keyword } })
    },
    keywordContinued(sessionId: string, keyword: string) {
      recordAudit({ level: 'warning', category: 'recovery', action: 'continue_keyword_sent', message: 'Agent 已停止工作，已按关键词规则尝试 Continue', sessionId, details: { keyword } })
    },
    keywordLimitReached(sessionId: string, count: number) {
      recordAudit({ level: 'warning', category: 'recovery', action: 'continue_keyword_limit_reached', message: '关键词续跑已达连续次数上限，等待人工处理', sessionId, details: { count } })
    },
    keywordFailed(sessionId: string, reason: string) {
      recordAudit({ level: 'warning', category: 'recovery', action: 'continue_keyword_failed', message: '关键词续跑提交未完成，请检查终端', sessionId, details: { reason } })
    },
  }
  const llmApprovalReview = {
    getSettings: () => {
      const settings = llmReviewSettingsStore.getRuntimeSettings()
      return { enabled: settings.enabled, level: settings.level }
    },
    reviewApproval: (request: ApprovalRequest, localRiskReason?: string, signal?: AbortSignal) =>
      llmSecurityReviewer.reviewApproval(request, llmReviewSettingsStore.getRuntimeSettings(), localRiskReason, signal),
  }
  controller = new SessionController(manager, broadcast, { discover: discoverNativeSessions }, auditedApprovalPolicy, recoveryPolicy, fullAutoActivity, continueKeywordStore, recoveryActivity, sessionCatalog, llmApprovalReview,
    entry => recordAudit({ ...entry, category: 'approval', level: 'warning' }), { validate: validateNativeActivityBinding })
  const remoteAudit = {
    list: () => auditStore.list(),
    record: (entry: { level: 'info' | 'warning' | 'error'; action: string; message: string; sessionId?: string; details?: Record<string, string | number | boolean> }) => {
      recordAudit({ ...entry, category: 'remote' })
    },
  }
  const remoteManager = {
    listSessions: () => controller.listSessions(),
    listPendingApprovals: () => controller.listPendingApprovals(),
    terminalReplay: (id: string) => controller.terminalReplay(id),
    terminalText: (id: string) => controller.terminalText(id),
    approveRequest: async (id: string) => {
      const request = controller.listPendingApprovals().find((item) => item.requestId === id)
      await controller.approveRequest(id)
      recordAudit({
        level: 'info', category: 'approval', action: 'approval_manual_remote',
        message: '已通过钉钉批准 ' + (request?.toolName ?? approvalSubject(request?.command)),
        sessionId: request?.sessionId,
        details: {
          requestId: id,
          toolName: request?.toolName ?? approvalSubject(request?.command),
          ...(request?.command ? { command: request.command } : {}),
          ...approvalReasonDetails(request),
          ...(request?.risk ? { risk: request.risk } : {}),
          source: 'dingtalk',
        },
      })
    },
    approveAllPendingForced: () => controller.approveAllPendingForced(),
    write: (id: string, data: string) => controller.write(id, data),
    sendMessage: (id: string, content: string) => controller.sendSessionMessage(id, content),
    stopSession: async (id: string) => {
      await controller.stopSession(id)
      await restoreNativeSessionProvider(controller.listSessions().find((session) => session.sessionId === id))
    },
    restartSession: (id: string) => controller.restartSession(id),
    setFullAutoMode: async (id: string, enabled: boolean) => {
      const session = controller.listSessions().find((item) => item.sessionId === id)
      if (!session) throw new Error('Agent 不存在或已删除')
      await controller.setFullAutoMode(id, enabled)
      recordAudit({
        level: enabled ? 'warning' : 'info',
        category: 'approval',
        action: enabled ? 'full_auto_enabled' : 'full_auto_disabled',
        message: enabled ? session.displayName + ' 已通过钉钉开启全自动模式' : session.displayName + ' 已通过钉钉关闭全自动模式',
        sessionId: id,
        details: { enabled, source: 'dingtalk', deletionAllowed: false, workspaceEscapeAllowed: false },
      })
    },
  }
  const dingTalkRouter = new DingTalkCommandRouter(
    remoteManager,
    remoteAudit,
    () => dingTalkSettingsStore.getRuntimeSettings(),
    (key, staffId, senderName) => dingTalkSettingsStore.bind(key, staffId, senderName),
    new DingTalkAgentInterpreter(),
  )
  dingTalkStreamService = new DingTalkStreamService(dingTalkRouter, {
    connected: () => recordAudit({ level: 'info', category: 'remote', action: 'remote_connected', message: '钉钉 Stream 已连接' }),
    disconnected: () => recordAudit({ level: 'warning', category: 'remote', action: 'remote_disconnected', message: '钉钉 Stream 连接已断开，Manager 将在网络恢复后重连' }),
    error: (error) => recordAudit({ level: 'error', category: 'remote', action: 'remote_error', message: '钉钉远程通道发生错误', details: { error } }),
    message: (staffId, command) => recordAudit({ level: 'info', category: 'remote', action: 'remote_message_received', message: `收到钉钉命令 ${command}`, details: { staffId, command } }),
  }, () => net.isOnline())
  registerIpc(approvalPolicy)
  scheduleLlmRuleAudit(approvalPolicy)
  await controller.restoreSessions(sessionSafetyStore.getSettings().preserveWorkspaceOnCrash)
  attentionSound.seed(controller.listSessions())
  nativeActivityMonitor = new NativeSessionActivityMonitor(
    () => controller.listNativeActivitySessions(),
    (session, event) => {
      controller.observeNativeActivity(session, event)
      if (controller.isNativeActivitySnapshotCurrent(session)) {
        if (attentionSound.observeQuestions(session.sessionId, event.pendingUserQuestions ?? [])) {
          questionSignals.get(session.sessionId)?.signal.reset()
          questionSignals.delete(session.sessionId)
        }
      }
    },
  )
  nativeActivityMonitor.start()
  for (const session of controller.listSessions()) {
    if (session.status === 'stopped' || session.status === 'failed') {
      await restoreNativeSessionProvider(session)
    }
  }
  const startupWindow = createWindow()
  createTray()
  sessionCatalog.startWorkspaceTracking()
  void promptStartupWorkspace(startupWindow).catch(error => {
    recordAudit({ level: 'error', category: 'session', action: 'startup_workspace_prompt_failed', message: '恢复上次工作区失败',
      details: { error: error instanceof Error ? error.message : String(error) } })
  })
  if (ENABLE_NATIVE_DRAG_IN_BETA) {
    nativeDragBridge = new NativeDragBridge(handleNativeDrag, (message) => {
      recordAudit({ level: 'warning', category: 'session', action: 'native_drag_bridge_warning', message: 'Windows 外部终端拖入监听不可用', details: { error: message } })
    })
    nativeDragBridge.start()
  }
  void dingTalkStreamService.restart(dingTalkSettingsStore.getRuntimeSettings()).catch((error) => {
    recordAudit({ level: 'error', category: 'remote', action: 'remote_start_failed', message: '钉钉远程通道启动失败', details: { error: error instanceof Error ? error.message : String(error) } })
  })
  app.on('activate', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show()
  })
})

app.on('before-quit', (event) => {
  if (quitPrepared) { quitting = true; return }
  // OS shutdown and fatal exits cannot safely wait for UI. Host leases release PTYs;
  // the crash-retention setting controls whether the Manager metadata is restored.
  if (quitPromptActive) event.preventDefault()
  else quitting = true
  if (quitting) dingTalkStreamService?.stop()
  if (quitting) nativeDragBridge?.stop()
})

app.on('will-quit', () => { attentionSound.dispose(); attentionAudioDelivery.dispose(); nativeAttentionAudio.stop(); questionSignals.clear(); nativeActivityMonitor?.stop() })
}
