import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, Tray, type IpcMainInvokeEvent } from 'electron'
import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

import { SessionController } from './session-controller'
import { SessionHostManager } from './session-host-manager'
import { discoverNativeSessions, discoverRecentNativeSessions } from './native-session-discovery'
import { canonicalNativeRecovery, terminalScrollbackArgs, validateExecutable } from './start-request-policy'
import { ApprovalPolicyStore } from './approval-policy-store'
import { resolveExecutableForPty } from './executable-resolution'
import { ActivityAuditStore, type NewAuditEntry } from './activity-audit-store'
import { RecoveryPolicyStore } from './recovery-policy-store'
import { AgentConfigurationStore } from './agent-configuration-store'
import { applyAgentLaunchProfile } from './agent-launch-profile'
import { CCSwitchProviderReader } from './ccswitch-provider-reader'
import { readCodexGlobalProvider } from './codex-global-config'
import { AgentProxyStore, environmentForAgentProxy } from './agent-proxy-store'
import { ContinueKeywordStore } from './continue-keyword-store'
import { SessionSafetyStore } from './session-safety-store'
import { ManagedSessionCatalog } from './managed-session-catalog'
import { DingTalkSettingsStore } from './dingtalk-settings-store'
import { DingTalkCommandRouter } from './dingtalk-command-router'
import { DingTalkStreamService } from './dingtalk-stream-service'
import { DingTalkAgentInterpreter } from './dingtalk-agent-interpreter'
import { migrateCodexProviderOfficial, migrateCodexSessionProvider } from './codex-session-provider-migrator'
import { openNativeResumeTerminal } from './native-terminal'
import { safeAuditExport } from './audit-export'
import { NativeDragBridge, type NativeDragEvent } from './native-drag-bridge'
import { detectAgentEnvironment, installAgent, installNodeAndNpm, installRipgrep } from './agent-environment-manager'
import { environmentWithFreshWindowsPath, pathFromEnvironment } from './windows-environment'
import { IPC_CHANNELS, type AgentConfigInput, type AgentKind, type AgentProxyInput, type ApprovalRequest, type AuditEntry, type ContinueKeywordSettings, type DingTalkSettingsInput, type ExternalTerminalDragProjection, type ManagerEvent, type NativeSessionSummary, type NpmRegistryChoice, type RecoveryRecipe, type SessionSafetySettings, type SessionSummary, type StartSessionRequest } from '../src/shared/manager-api'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let controller: SessionController
let auditStore: ActivityAuditStore
let agentConfigurationStore: AgentConfigurationStore
let agentProxyStore: AgentProxyStore
let continueKeywordStore: ContinueKeywordStore
let sessionSafetyStore: SessionSafetyStore
let sessionCatalog: ManagedSessionCatalog
let dingTalkSettingsStore: DingTalkSettingsStore
let dingTalkStreamService: DingTalkStreamService
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
const hasSingleInstanceLock = app.requestSingleInstanceLock()

const MAX_TEXT = 4_096
const MAX_TERMINAL_INPUT = 64 * 1024
// External native-window drag-in remains a Beta capability. Keep the listener
// completely dormant in normal builds until explicitly enabled for controlled
// testing; managed Agent drag-out is independent of this bridge.
const ENABLE_NATIVE_DRAG_IN_BETA = process.env.AGENT_TUI_ENABLE_NATIVE_DRAG_IN_BETA === '1'
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
  const environment = agentKind === 'generic' ? process.env : environmentWithFreshWindowsPath()
  return resolveExecutableForPty(validated, { path: pathFromEnvironment(environment) })
}

function workspace(value: unknown): string {
  const candidate = text(value, 'workspace', 1_024)
  if (!isAbsolute(candidate) || !statSync(candidate).isDirectory()) throw new Error('Workspace must be an existing absolute directory')
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
  if (!Number.isInteger(input.quietSeconds) || Number(input.quietSeconds) < 3 || Number(input.quietSeconds) > 60) {
    throw new Error('静默等待时间必须是 3 到 60 秒的整数')
  }
  if (!Array.isArray(input.keywords) || input.keywords.length > 50) throw new Error('Continue 关键词最多保存 50 条')
  return {
    enabled: input.enabled === true,
    quietSeconds: Number(input.quietSeconds),
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
  const allowedWorkspaces = normalizeList(input.allowedWorkspaces, '工作区', 1_024).map(workspace)
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
    allowedWorkspaces,
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

function optionalConfigText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined
  const result = text(value, name, max).trim()
  if (!result || /[\r\n]/.test(result)) throw new Error(`Invalid ${name}`)
  return result
}

function agentConfigInput(value: unknown): AgentConfigInput {
  if (!value || typeof value !== 'object') throw new Error('独立配置格式无效')
  const input = value as Record<string, unknown>
  if (input.enabled !== true) return { enabled: false, source: 'local' }
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
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerName ? { providerName } : {}),
  }
}

async function resolvedAgentConfig(agentKind: AgentKind, input: AgentConfigInput): Promise<AgentConfigInput> {
  if (!input.enabled || input.source !== 'ccswitch') return input
  if (agentKind !== 'codex' && agentKind !== 'claude') throw new Error('CCSwitch 当前仅支持 Codex 和 Claude Code')
  if (!input.providerId) throw new Error('请选择一个 CCSwitch Provider')
  return ccSwitchProviderReader.import(agentKind, input.providerId)
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
    for (const window of BrowserWindow.getAllWindows()) {
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
  for (const window of BrowserWindow.getAllWindows()) {
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
  ipcMain.handle(IPC_CHANNELS.listSessions, (event) => {
    trustedRenderer(event)
    return controller.listSessions()
  })
  ipcMain.handle(IPC_CHANNELS.terminalReplay, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.terminalReplay(sessionId(id))
  })
  ipcMain.handle(IPC_CHANNELS.listAuditEntries, (event) => {
    trustedRenderer(event)
    return auditStore.list()
  })
  ipcMain.handle(IPC_CHANNELS.startSession, async (event, request: unknown) => {
    trustedRenderer(event)
    const validated = startRequest(request)
    recordAudit({ level: 'info', category: 'session', action: 'session_start_requested', message: `正在启动 ${validated.displayName}`, details: { displayName: validated.displayName, agentKind: validated.agentKind, workspace: validated.workspace } })
    let createdProfileId: string | undefined
    let createdProxyId: string | undefined
    try {
      const agentConfig = validated.agentConfig && !('hasApiKey' in validated.agentConfig)
        ? await agentConfigurationStore.save(await resolvedAgentConfig(validated.agentKind, validated.agentConfig))
        : AgentConfigurationStore.localSummary()
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
  ipcMain.handle(IPC_CHANNELS.write, (event, id: unknown, data: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const input = terminalInput(data)
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
    await controller.restartSession(target)
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
        ...(request?.agentReason ? { reason: request.agentReason } : {}),
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
  ipcMain.handle(IPC_CHANNELS.updateSessionConfig, async (event, id: unknown, value: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    const input = agentConfigInput(value)
    const session = controller.listSessions().find((item) => item.sessionId === target)
    if (!session) throw new Error('Agent 不存在或已删除')
    const existingProfileId = session.agentConfig?.profileId
    const summary = input.enabled
      ? await agentConfigurationStore.save(await resolvedAgentConfig(session.agentKind, input), existingProfileId)
      : AgentConfigurationStore.localSummary()
    await controller.updateSessionConfig(target, summary)
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
      details: { enabled: settings.enabled, keywordCount: settings.keywords.length, quietSeconds: settings.quietSeconds },
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
      message: saved.preserveWorkspaceOnCrash ? '异常退出后将保留运行中的 Agent 并在下次启动接管' : '异常退出后将停止 Agent、释放会话且不保留工作区记录',
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
      details: { enabled: saved.enabled, bound: Boolean(saved.boundStaffId), agentModeEnabled: saved.agentModeEnabled, allowedWorkspaceCount: saved.allowedWorkspaces.length },
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
        ...(request?.agentReason ? { reason: request.agentReason } : {}),
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
        ...(request?.agentReason ? { reason: request.agentReason } : {}),
        ...(request?.risk ? { risk: request.risk } : {}),
      },
    })
  })
  ipcMain.handle(IPC_CHANNELS.approveAllPending, (event) => {
    trustedRenderer(event)
    const result = controller.approveAllPending()
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
    recordAudit({ level: 'info', category: 'rule', action: 'rule_added', message: '已添加自动批准规则' })
  })
  ipcMain.handle(IPC_CHANNELS.removeApprovalRule, async (event, command: unknown) => {
    trustedRenderer(event)
    await approvalPolicy.removeRule(text(command, 'approval rule', 2_048))
    recordAudit({ level: 'info', category: 'rule', action: 'rule_removed', message: '已撤销自动批准规则' })
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
  ipcMain.handle(IPC_CHANNELS.discoverSessions, (event, kind: unknown, selectedWorkspace: unknown) => {
    trustedRenderer(event)
    return coalescedDiscovery(validatedAgentKind(kind), workspace(selectedWorkspace))
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
  ipcMain.handle(IPC_CHANNELS.installAgent, async (event, kind: unknown, registry: unknown) => {
    trustedRenderer(event)
    const agentKind = validatedAgentKind(kind)
    const registryChoice = registry === undefined ? 'configured' : text(registry, 'npm registry', 32)
    if (!['configured', 'official', 'npmmirror', 'tencent', 'huawei'].includes(registryChoice)) throw new Error('不支持的 npm 镜像源')
    await installAgent(agentKind, registryChoice as NpmRegistryChoice, (progress) => broadcast({ type: 'agent-install-progress', progress: { target: 'agent', agentKind, ...progress } }))
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 860, minHeight: 600, backgroundColor: '#111719', autoHideMenuBar: true, icon: APP_LOGO_PATH,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.setMenuBarVisibility(false)
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
      message: '退出后是否保留当前工作区？',
      detail: '保留：Agent 继续运行，下次打开 Manager 自动恢复。\n不保留：停止受管 Agent 并释放原生会话；不会删除 Codex 或 Claude Code 的原生历史。',
      buttons: ['保留并退出', '不保留并退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (result.response === 2) return
    if (result.response === 0) {
      const count = await controller.preserveAllSessions()
      await controller.flushCatalog()
      recordAudit({ level: 'info', category: 'session', action: 'manager_exit_preserved', message: `已保留 ${count} 个运行中的 Agent，退出后继续运行`, details: { count } })
    } else {
      const sessions = controller.listSessions()
      await controller.stopAllSessions()
      for (const session of sessions) await restoreNativeSessionProvider(session)
      const count = await controller.clearAllSessions()
      for (const session of sessions) {
        if (session.agentConfig?.profileId) await agentConfigurationStore.remove(session.agentConfig.profileId).catch(() => undefined)
        if (session.agentProxy?.proxyId) await agentProxyStore.remove(session.agentProxy.proxyId).catch(() => undefined)
      }
      recordAudit({ level: 'warning', category: 'session', action: 'manager_exit_released', message: `已释放并清除 ${count} 个受管 Agent`, details: { count } })
    }
    quitPrepared = true
    quitting = true
    app.quit()
  } catch (error) {
    quitting = false
    quitPrepared = false
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
  dingTalkSettingsStore = await DingTalkSettingsStore.load(join(app.getPath('userData'), 'dingtalk-settings.json'), safeStorage)
  const manager = new SessionHostManager({
    runtimeDir: join(app.getPath('userData'), 'runtime', 'session-hosts'),
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
  const auditedApprovalPolicy = {
    decide(command: string | undefined) {
      const subject = approvalSubject(command)
      recordAudit({ level: 'warning', category: 'approval', action: 'approval_detected', message: `检测到 ${subject} 授权请求`, details: { subject, ...(command ? { command } : {}) } })
      const decision = approvalPolicy.decide(command)
      recordAudit(decision.action === 'auto-approve'
        ? { level: 'info', category: 'approval', action: 'approval_auto', message: `${subject} 已按安全规则自动批准`, details: { subject, ...(command ? { command } : {}), risk: decision.risk, rule: decision.matchedRule ?? 'built-in' } }
        : { level: 'warning', category: 'approval', action: 'approval_waiting', message: `${subject} 正在等待人工处理`, details: { subject, ...(command ? { command } : {}), risk: decision.risk, reason: decision.reason } })
      return decision
    },
    noteManualApproval: (command: string | undefined) => approvalPolicy.noteManualApproval(command),
    async addRule(command: string) {
      await approvalPolicy.addRule(command)
      recordAudit({ level: 'info', category: 'rule', action: 'learned_rule_accepted', message: '已接受学习建议并添加自动批准规则' })
    },
  }
  const fullAutoActivity = {
    pending(request: ApprovalRequest) {
      void dingTalkStreamService?.notifyApproval(request, dingTalkSettingsStore.getRuntimeSettings()).then((sent) => {
        if (!sent) return
        recordAudit({
          level: 'info', category: 'remote', action: 'remote_approval_notified',
          message: '已向钉钉发送待审批提醒',
          sessionId: request.sessionId,
          details: { requestId: request.requestId, workspace: request.workspace, toolName: request.toolName ?? approvalSubject(request.command) },
        })
      }).catch((error) => {
        recordAudit({
          level: 'error', category: 'remote', action: 'remote_approval_notification_failed',
          message: '钉钉待审批提醒发送失败',
          sessionId: request.sessionId,
          details: { requestId: request.requestId, workspace: request.workspace, error: error instanceof Error ? error.message : String(error) },
        })
      })
    },
    approved(request: ApprovalRequest) {
      recordAudit({
        level: 'warning', category: 'approval', action: 'full_auto_approved',
        message: '全自动模式已批准 ' + (request.toolName ?? approvalSubject(request.command)),
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId,
          toolName: request.toolName ?? approvalSubject(request.command),
          ...(request.command ? { command: request.command } : {}),
          ...(request.agentReason ? { reason: request.agentReason } : {}),
          risk: request.risk,
          decision: 'full-auto',
        },
      })
    },
    blocked(request: ApprovalRequest, reason: string) {
      recordAudit({
        level: 'warning', category: 'approval', action: 'full_auto_blocked',
        message: '全自动模式已拦截高风险操作：' + (request.toolName ?? approvalSubject(request.command)),
        sessionId: request.sessionId,
        details: {
          requestId: request.requestId,
          toolName: request.toolName ?? approvalSubject(request.command),
          ...(request.command ? { command: request.command } : {}),
          reason,
          risk: request.risk,
          decision: 'blocked',
        },
      })
    },
  }
  const recoveryActivity = {
    keywordMatched(sessionId: string, keyword: string) {
      recordAudit({ level: 'warning', category: 'recovery', action: 'continue_keyword_matched', message: '命中 Continue 关键词，正在等待输出静默', sessionId, details: { keyword, quietSeconds: continueKeywordStore.getSettings().quietSeconds } })
    },
    keywordContinued(sessionId: string, keyword: string) {
      recordAudit({ level: 'warning', category: 'recovery', action: 'continue_keyword_sent', message: '输出持续静默，已按关键词规则尝试 Continue 一次', sessionId, details: { keyword, attempt: 1 } })
    },
  }
  controller = new SessionController(manager, broadcast, { discover: discoverNativeSessions }, auditedApprovalPolicy, recoveryPolicy, fullAutoActivity, continueKeywordStore, recoveryActivity, sessionCatalog)
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
    approveRequest: (id: string) => controller.approveRequest(id),
    approveAllPending: () => controller.approveAllPending(),
    write: (id: string, data: string) => controller.write(id, data),
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
    disconnected: () => recordAudit({ level: 'warning', category: 'remote', action: 'remote_disconnected', message: '钉钉 Stream 连接已断开，正在等待 SDK 重连' }),
    error: (error) => recordAudit({ level: 'error', category: 'remote', action: 'remote_error', message: '钉钉远程通道发生错误', details: { error } }),
    message: (staffId, command) => recordAudit({ level: 'info', category: 'remote', action: 'remote_message_received', message: `收到钉钉命令 ${command}`, details: { staffId, command } }),
  })
  registerIpc(approvalPolicy)
  await controller.restoreSessions(sessionSafetyStore.getSettings().preserveWorkspaceOnCrash)
  for (const session of controller.listSessions()) {
    if (session.status === 'stopped' || session.status === 'failed') {
      await restoreNativeSessionProvider(session)
    }
  }
  createWindow(); createTray()
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
}
