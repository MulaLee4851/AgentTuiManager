import { app, BrowserWindow, dialog, ipcMain, nativeImage, Tray, type IpcMainInvokeEvent } from 'electron'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { SessionController } from './session-controller'
import { SessionHostManager } from './session-host-manager'
import { discoverNativeSessions } from './native-session-discovery'
import { canonicalNativeRecovery, validateExecutable } from './start-request-policy'
import { ApprovalPolicyStore } from './approval-policy-store'
import { resolveExecutableForPty } from './executable-resolution'
import { IPC_CHANNELS, type AgentKind, type NativeSessionSummary, type RecoveryRecipe, type StartSessionRequest } from '../src/shared/manager-api'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let controller: SessionController
let quitting = false
const discoveryInFlight = new Map<string, Promise<NativeSessionSummary[]>>()

const MAX_TEXT = 4_096
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

function registerIpc(approvalPolicy: ApprovalPolicyStore): void {
  ipcMain.handle(IPC_CHANNELS.listSessions, (event) => {
    trustedRenderer(event)
    return controller.listSessions()
  })
  ipcMain.handle(IPC_CHANNELS.startSession, (event, request: unknown) => {
    trustedRenderer(event)
    return controller.startSession(startRequest(request))
  })
  ipcMain.handle(IPC_CHANNELS.write, (event, id: unknown, data: unknown) => {
    trustedRenderer(event)
    return controller.write(sessionId(id), text(data, 'terminal input'))
  })
  ipcMain.handle(IPC_CHANNELS.resize, (event, id: unknown, cols: unknown, rows: unknown) => {
    trustedRenderer(event)
    const size = dimensions(cols, rows)
    controller.resize(sessionId(id), size.cols, size.rows)
  })
  ipcMain.handle(IPC_CHANNELS.stopSession, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.stopSession(sessionId(id))
  })
  ipcMain.handle(IPC_CHANNELS.approveSession, (event, id: unknown) => {
    trustedRenderer(event)
    return controller.approveSession(sessionId(id))
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
  ipcMain.handle(IPC_CHANNELS.addApprovalRule, (event, command: unknown) => {
    trustedRenderer(event)
    return approvalPolicy.addRule(text(command, 'approval rule', 2_048))
  })
  ipcMain.handle(IPC_CHANNELS.removeApprovalRule, (event, command: unknown) => {
    trustedRenderer(event)
    return approvalPolicy.removeRule(text(command, 'approval rule', 2_048))
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
  tray.on('click', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show(); window.focus()
  })
}

void app.whenReady().then(async () => {
  const manager = new SessionHostManager({ runtimeDir: join(app.getPath('userData'), 'runtime', 'session-hosts'), hostEntry: join(__dirname, 'session-host.js') })
  const approvalPolicy = await ApprovalPolicyStore.load(join(app.getPath('userData'), 'approval-policy.json'))
  controller = new SessionController(manager, (event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.event, event)
  }, { discover: discoverNativeSessions }, approvalPolicy)
  registerIpc(approvalPolicy)
  await controller.restoreLiveHosts()
  createWindow(); createTray()
  app.on('activate', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show()
  })
})

app.on('before-quit', () => { quitting = true })
