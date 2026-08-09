import { app, BrowserWindow, ipcMain, nativeImage, Tray } from 'electron'
import { statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join } from 'node:path'

import { SessionController } from './session-controller'
import { SessionHostManager } from './session-host-manager'
import { IPC_CHANNELS, type RecoveryRecipe, type StartSessionRequest } from '../src/shared/manager-api'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let controller: SessionController
let quitting = false

const MAX_TEXT = 4_096
const BUILT_INS = new Set(['codex', 'codex.exe', 'codex.cmd', 'claude', 'claude.exe', 'claude.cmd', 'pi', 'pi.exe', 'pi.cmd', 'node', 'node.exe'])

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

function executable(value: unknown): string {
  const candidate = text(value, 'executable', 1_024)
  const configured = new Set((process.env.AGENT_TUI_ALLOWED_EXECUTABLES ?? '').split(delimiter).filter(Boolean))
  if (!BUILT_INS.has(basename(candidate).toLowerCase()) && !configured.has(candidate)) throw new Error('Executable is not allowed')
  return candidate
}

function workspace(value: unknown): string {
  const candidate = text(value, 'workspace', 1_024)
  if (!isAbsolute(candidate) || !statSync(candidate).isDirectory()) throw new Error('Workspace must be an existing absolute directory')
  return candidate
}

function recovery(value: unknown): RecoveryRecipe | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid recovery recipe')
  const input = value as Record<string, unknown>
  return {
    executable: executable(input.executable),
    args: stringArray(input.args, 'recovery.args'),
    ...(input.continueInput === undefined ? {} : { continueInput: text(input.continueInput, 'continueInput') }),
  }
}

function startRequest(value: unknown): StartSessionRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid start request')
  const input = value as Record<string, unknown>
  if (!['generic', 'codex', 'claude', 'pi'].includes(String(input.agentKind))) throw new Error('Invalid agent kind')
  return {
    displayName: text(input.displayName, 'displayName', 120),
    agentKind: input.agentKind as StartSessionRequest['agentKind'],
    workspace: workspace(input.workspace),
    executable: executable(input.executable),
    args: stringArray(input.args, 'args'),
    ...dimensions(input.cols, input.rows),
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: text(input.nativeSessionId, 'nativeSessionId', 512) }),
    ...(input.recovery === undefined ? {} : { recovery: recovery(input.recovery) }),
  }
}

function sessionId(value: unknown): string {
  const candidate = text(value, 'sessionId', 128)
  if (!/^[a-zA-Z0-9-]+$/.test(candidate)) throw new Error('Invalid sessionId')
  return candidate
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.listSessions, () => controller.listSessions())
  ipcMain.handle(IPC_CHANNELS.startSession, (_event, request: unknown) => controller.startSession(startRequest(request)))
  ipcMain.handle(IPC_CHANNELS.write, (_event, id: unknown, data: unknown) => controller.write(sessionId(id), text(data, 'terminal input')))
  ipcMain.handle(IPC_CHANNELS.resize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    const size = dimensions(cols, rows)
    controller.resize(sessionId(id), size.cols, size.rows)
  })
  ipcMain.handle(IPC_CHANNELS.stopSession, (_event, id: unknown) => controller.stopSession(sessionId(id)))
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
  controller = new SessionController(manager, (event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.event, event)
  })
  registerIpc()
  await controller.restoreLiveHosts()
  createWindow(); createTray()
  app.on('activate', () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    window.show()
  })
})

app.on('before-quit', () => { quitting = true })
