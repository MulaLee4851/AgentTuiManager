import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'

export interface NativeDragEvent {
  type: 'move-start' | 'move-update' | 'move-end'
  hwnd: string
  processId: number
  processName: string
  className: string
  title: string
  rect: { left: number; top: number; right: number; bottom: number }
  cursor: { x: number; y: number }
  tabCount: number
  paneCount: number
  structureVerified: boolean
}

interface NativeCommandResult { type: 'command-result'; requestId: string; ok: boolean; reason?: string }

function parseNativeDragEvent(value: string): NativeDragEvent | undefined {
  let input: unknown
  try { input = JSON.parse(value) } catch { return undefined }
  if (!input || typeof input !== 'object') return undefined
  const event = input as Record<string, unknown>
  const rect = event.rect as Record<string, unknown> | undefined
  const cursor = event.cursor as Record<string, unknown> | undefined
  if (!['move-start', 'move-update', 'move-end'].includes(String(event.type))
    || typeof event.hwnd !== 'string' || !/^0x[0-9A-F]+$/i.test(event.hwnd)
    || !Number.isInteger(event.processId) || Number(event.processId) <= 0
    || typeof event.processName !== 'string' || typeof event.className !== 'string' || typeof event.title !== 'string'
    || !rect || !cursor) return undefined
  const coordinates = [rect.left, rect.top, rect.right, rect.bottom, cursor.x, cursor.y]
  if (coordinates.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) return undefined
  if (!Number.isInteger(event.tabCount) || !Number.isInteger(event.paneCount) || typeof event.structureVerified !== 'boolean') return undefined
  return {
    type: event.type as NativeDragEvent['type'], hwnd: event.hwnd, processId: Number(event.processId),
    processName: event.processName, className: event.className, title: event.title,
    rect: { left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom) },
    cursor: { x: Number(cursor.x), y: Number(cursor.y) },
    tabCount: Number(event.tabCount), paneCount: Number(event.paneCount), structureVerified: event.structureVerified,
  }
}

export class NativeDragBridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private stopping = false
  private readonly pending = new Map<string, { resolve: (result: NativeCommandResult) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly listener: (event: NativeDragEvent) => void, private readonly error?: (message: string) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'native', 'AgentTui.NativeBridge.exe')
      : join(process.cwd(), 'build', 'native', 'AgentTui.NativeBridge.exe')
    if (!existsSync(executable)) { this.error?.('Windows 拖入桥接程序尚未构建'); return }
    this.stopping = false
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const event = parseNativeDragEvent(line)
      if (event) { this.listener(event); return }
      let result: NativeCommandResult | undefined
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.type === 'command-result' && typeof value.requestId === 'string' && typeof value.ok === 'boolean') {
          result = { type: 'command-result', requestId: value.requestId, ok: value.ok, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
        }
      } catch { /* invalid helper output is ignored */ }
      if (!result) return
      const waiter = this.pending.get(result.requestId)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.pending.delete(result.requestId)
      waiter.resolve(result)
    })
    child.stderr.on('data', (data) => this.error?.(String(data).slice(0, 500)))
    child.on('error', (reason) => this.error?.(reason.message))
    child.on('exit', () => {
      lines.close()
      if (this.child === child) this.child = undefined
      if (!this.stopping) this.error?.('Windows 拖入桥接程序已退出')
    })
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
    setTimeout(() => { if (child.exitCode === null) child.kill() }, 1_000).unref()
  }

  sendGracefulInterrupt(event: NativeDragEvent): Promise<NativeCommandResult> {
    return this.command('send-graceful-interrupt', event)
  }

  closeSourceWindow(event: NativeDragEvent): Promise<NativeCommandResult> {
    return this.command('close-source-window', event)
  }

  private command(type: 'send-graceful-interrupt' | 'close-source-window', event: NativeDragEvent): Promise<NativeCommandResult> {
    const child = this.child
    if (!child || child.stdin.destroyed) return Promise.resolve({ type: 'command-result', requestId: '', ok: false, reason: 'bridge-unavailable' })
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ type: 'command-result', requestId, ok: false, reason: 'bridge-timeout' }) }, 2_000)
      this.pending.set(requestId, { resolve, timer })
      child.stdin.write(`${JSON.stringify({ type, requestId, hwnd: event.hwnd, expectedProcessId: event.processId, expectedTitle: event.title })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(requestId); resolve({ type: 'command-result', requestId, ok: false, reason: error.message })
      })
    })
  }
}
