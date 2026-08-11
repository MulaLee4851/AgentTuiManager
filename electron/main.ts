import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Tray, type IpcMainInvokeEvent } from 'electron'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { SessionController } from './session-controller'
import { SessionHostManager } from './session-host-manager'
import { discoverNativeSessions } from './native-session-discovery'
import { readNativeSessionTranscript } from './native-session-transcript'
import { canonicalNativeRecovery, validateExecutable } from './start-request-policy'
import { ApprovalPolicyStore } from './approval-policy-store'
import { resolveExecutableForPty } from './executable-resolution'
import { ActivityAuditStore, type NewAuditEntry } from './activity-audit-store'
import { RecoveryPolicyStore } from './recovery-policy-store'
import { IPC_CHANNELS, type AgentKind, type ManagerEvent, type NativeSessionSummary, type RecoveryRecipe, type SessionSummary, type StartSessionRequest } from '../src/shared/manager-api'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let controller: SessionController
let auditStore: ActivityAuditStore
let quitting = false
const discoveryInFlight = new Map<string, Promise<NativeSessionSummary[]>>()
const sessionSnapshots = new Map<string, SessionSummary>()
const pendingOutputEvents = new Map<string, { sessionId: string; data: string; sequence?: number }>()
let outputFlushTimer: ReturnType<typeof setTimeout> | undefined

const MAX_TEXT = 4_096
const MAX_TERMINAL_INPUT = 64 * 1024
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
  const validated = validateExecutable(agentKind, candidate, process.env.AGENT_TUI_ALLOWED_EXECUTABLES ?? '')
  return resolveExecutableForPty(validated)
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
  const initialArgs = stringArray(input.args, 'args')
  const nativeSessionId = input.nativeSessionId === undefined
    ? undefined
    : text(input.nativeSessionId, 'nativeSessionId', 512)
  const suppliedRecovery = recovery(agentKind, input.recovery)
  const canonicalRecovery = nativeSessionId
    ? canonicalNativeRecovery(agentKind, nativeSessionId, initialExecutable, initialArgs, suppliedRecovery)
    : suppliedRecovery
  return {
    displayName: text(input.displayName, 'displayName', 120),
    agentKind,
    workspace: workspace(input.workspace),
    executable: initialExecutable,
    args: initialArgs,
    ...dimensions(input.cols, input.rows),
    maxContinueRetries: maxContinueRetries(input.maxContinueRetries),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(canonicalRecovery ? { recovery: canonicalRecovery } : {}),
  }
}

function validatedAgentKind(value: unknown): AgentKind {
  if (!['generic', 'codex', 'claude', 'pi'].includes(String(value))) throw new Error('Invalid agent kind')
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
    recordAudit({
      level: 'warning',
      category: 'recovery',
      action: modelCapacity ? 'capacity_retry_started' : 'recovery_started',
      message: current.displayName + (modelCapacity ? ' 模型暂时繁忙，稍后自动继续' : ' 异常退出，正在自动恢复'),
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
    recordAudit({
      level: 'warning', category: 'recovery', action: 'capacity_retry_exhausted',
      message: `${current.displayName} 自动重试已达上限，终端保持运行`, sessionId,
      details: { attempt: current.recoveryAttempts, ...(current.lastError ? { reason: current.lastError } : {}) },
    })
  } else if (current.status === 'completed') {
    recordAudit({ level: 'info', category: 'session', action: 'session_completed', message: `${current.displayName} 已正常完成`, sessionId })
  } else if (current.status === 'failed') {
    recordAudit({ level: 'error', category: 'session', action: 'session_failed', message: `${current.displayName} 运行失败`, sessionId })
  } else if (current.status === 'stopped' && !current.userStopRequested) {
    recordAudit({ level: 'info', category: 'session', action: 'session_interrupted', message: `${current.displayName} 已由用户中断`, sessionId })
  } else if (previous.status === 'needs_approval' && current.status === 'running') {
    const subject = approvalSubject(previous.pendingApprovalCommand)
    recordAudit({ level: 'info', category: 'approval', action: 'approval_manual', message: `已人工批准 ${subject}`, sessionId, details: { subject } })
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

function recordAudit(entry: NewAuditEntry): void {
  auditStore.append(entry)
  broadcast({ type: 'audit-changed' })
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
  ipcMain.handle(IPC_CHANNELS.terminalHistory, async (event, id: unknown) => {
    trustedRenderer(event)
    const requestedId = sessionId(id)
    const session = controller.listSessions().find((candidate) => candidate.sessionId === requestedId)
    if (!session) throw new Error('Agent 会话不存在')
    return readNativeSessionTranscript(session.agentKind, session.nativeSessionId)
  })
  ipcMain.handle(IPC_CHANNELS.listAuditEntries, (event) => {
    trustedRenderer(event)
    return auditStore.list()
  })
  ipcMain.handle(IPC_CHANNELS.startSession, async (event, request: unknown) => {
    trustedRenderer(event)
    const validated = startRequest(request)
    recordAudit({ level: 'info', category: 'session', action: 'session_start_requested', message: `正在启动 ${validated.displayName}`, details: { agentKind: validated.agentKind, workspace: validated.workspace } })
    try {
      const session = await controller.startSession(validated)
      recordAudit({ level: 'info', category: 'session', action: 'session_started', message: `${session.displayName} 已启动`, sessionId: session.sessionId })
      return session
    } catch (error) {
      recordAudit({ level: 'error', category: 'session', action: 'session_start_failed', message: `${validated.displayName} 启动失败`, details: { error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
  })
  ipcMain.handle(IPC_CHANNELS.write, (event, id: unknown, data: unknown) => {
    trustedRenderer(event)
    return controller.write(sessionId(id), terminalInput(data))
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
    await controller.removeSession(target)
    recordAudit({ level: 'info', category: 'session', action: 'session_removed', message: 'Agent 已从总览删除', sessionId: target })
  })
  ipcMain.handle(IPC_CHANNELS.approveSession, async (event, id: unknown) => {
    trustedRenderer(event)
    const target = sessionId(id)
    await controller.approveSession(target)
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
  ipcMain.handle(IPC_CHANNELS.writeClipboardText, (event, value: unknown) => {
    trustedRenderer(event)
    clipboard.writeText(text(value, 'clipboard text', 4 * 1024 * 1024), 'clipboard')
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 860, minHeight: 600, backgroundColor: '#0b1020',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, 'renderer/index.html'))
  mainWindow = window
  return window
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' rx='4' fill='%235a7cff'/%3E%3Cpath d='M5 6l4 4-4 4m5 0h5' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E")
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
        quitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show(); window.focus()
  })
}

void app.whenReady().then(async () => {
  const manager = new SessionHostManager({ runtimeDir: join(app.getPath('userData'), 'runtime', 'session-hosts'), hostEntry: join(__dirname, 'session-host.js') })
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
  controller = new SessionController(manager, broadcast, { discover: discoverNativeSessions }, auditedApprovalPolicy, recoveryPolicy)
  registerIpc(approvalPolicy)
  await controller.restoreLiveHosts()
  createWindow(); createTray()
  app.on('activate', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show()
  })
})

app.on('before-quit', () => { quitting = true })
