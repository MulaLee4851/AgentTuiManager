import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'

import type { HostCommand, HostEvent } from '../src/shared/protocol'

const DEFAULT_TIMEOUT_MS = 5_000

export interface HostRecord {
  hostId: string
  agentKind: 'generic'
  cwd: string
  nativeSessionId?: string
  pid: number
  endpoint: string
}

export interface StartHostOptions {
  executable: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  nativeSessionId?: string
}

export interface HostHandle {
  readonly hostId: string
  nextEvent(timeoutMs?: number): Promise<HostEvent>
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
  disconnect(): void
}

export interface SessionHostManagerOptions {
  runtimeDir: string
  hostEntry: string
  nodeExecutable?: string
  timeoutMs?: number
}

interface EventWaiter {
  resolve: (event: HostEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class PipeHostHandle implements HostHandle {
  readonly hostId: string
  private readonly socket: Socket
  private readonly events: HostEvent[] = []
  private readonly waiters: EventWaiter[] = []
  private readonly pongWaiters: EventWaiter[] = []
  private buffer = ''
  private closedError: Error | undefined

  constructor(hostId: string, socket: Socket) {
    this.hostId = hostId
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.onData(chunk.toString()))
    socket.on('error', (error) => this.close(error))
    socket.on('close', () => this.close(new Error(`Host ${hostId} connection closed`)))
  }

  nextEvent(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HostEvent> {
    const event = this.events.shift()
    if (event) return Promise.resolve(event)
    if (this.closedError) return Promise.reject(this.closedError)
    return this.waitFor(this.waiters, timeoutMs, 'host event')
  }

  write(data: string): void {
    this.send({ type: 'write', data })
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  async stop(): Promise<void> {
    if (this.closedError || this.socket.destroyed) return
    this.send({ type: 'stop' })
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    while (!this.closedError && Date.now() < deadline) {
      try {
        const event = await this.nextEvent(deadline - Date.now())
        if (event.type === 'exit') return
      } catch {
        return
      }
    }
  }

  disconnect(): void {
    this.socket.destroy()
  }

  send(command: HostCommand): void {
    if (this.closedError || this.socket.destroyed) {
      throw this.closedError ?? new Error(`Host ${this.hostId} connection is closed`)
    }
    this.socket.write(`${JSON.stringify(command)}\n`)
  }

  ping(timeoutMs: number): Promise<void> {
    const pong = this.waitFor(this.pongWaiters, timeoutMs, 'pong').then(() => undefined)
    this.send({ type: 'ping' })
    return pong
  }

  private waitFor(waiters: EventWaiter[], timeoutMs: number, label: string): Promise<HostEvent> {
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`Timed out waiting for ${label} from host ${this.hostId}`))
        }, Math.max(1, timeoutMs)),
      }
      waiters.push(waiter)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        const event = JSON.parse(line) as HostEvent
        if (event.type === 'pong') this.deliver(this.pongWaiters, event)
        else if (!this.deliver(this.waiters, event)) this.events.push(event)
      } catch {
        this.close(new Error(`Host ${this.hostId} sent invalid JSON`))
      }
    }
  }

  private deliver(waiters: EventWaiter[], event: HostEvent): boolean {
    const waiter = waiters.shift()
    if (!waiter) return false
    clearTimeout(waiter.timer)
    waiter.resolve(event)
    return true
  }

  private close(error: Error): void {
    if (this.closedError) return
    this.closedError = error
    for (const waiter of [...this.waiters, ...this.pongWaiters]) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.length = 0
    this.pongWaiters.length = 0
  }
}

export class SessionHostManager {
  private readonly runtimeDir: string
  private readonly hostEntry: string
  private readonly nodeExecutable: string
  private readonly timeoutMs: number

  constructor(options: SessionHostManagerOptions) {
    this.runtimeDir = options.runtimeDir
    this.hostEntry = options.hostEntry
    this.nodeExecutable = options.nodeExecutable ?? process.execPath
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async start(options: StartHostOptions): Promise<HostHandle> {
    await mkdir(this.runtimeDir, { recursive: true })
    const hostId = randomUUID()
    const endpoint = this.endpointFor(hostId)
    const child = spawn(this.nodeExecutable, [this.hostEntry, '--host-id', hostId, '--endpoint', endpoint], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()

    try {
      const handle = await this.connect(hostId, endpoint)
      handle.send({ type: 'start', ...options })
      const event = await handle.nextEvent(this.timeoutMs)
      if (event.type !== 'ready') {
        throw new Error(event.type === 'error' ? event.message : `Expected ready, received ${event.type}`)
      }
      if (child.pid === undefined) throw new Error('Session Host did not report a process id')
      await this.writeRecord({
        hostId,
        agentKind: 'generic',
        cwd: options.cwd,
        ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}),
        pid: child.pid,
        endpoint,
      })
      return handle
    } catch (error) {
      child.kill()
      throw error
    }
  }

  async reconnect(hostId: string): Promise<HostHandle> {
    const record = await this.readRecord(hostId)
    const handle = await this.connect(record.hostId, record.endpoint)
    try {
      await handle.ping(this.timeoutMs)
      return handle
    } catch (error) {
      handle.disconnect()
      throw error
    }
  }

  async listLiveHosts(): Promise<HostRecord[]> {
    await mkdir(this.runtimeDir, { recursive: true })
    const files = (await readdir(this.runtimeDir)).filter((file) => /^host-[a-zA-Z0-9-]+\.json$/.test(file))
    const live: HostRecord[] = []
    for (const file of files) {
      const path = join(this.runtimeDir, file)
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as HostRecord
        const handle = await this.connect(record.hostId, record.endpoint, Math.min(this.timeoutMs, 250))
        await handle.ping(this.timeoutMs)
        handle.disconnect()
        live.push(record)
      } catch {
        await unlink(path).catch(() => undefined)
      }
    }
    return live
  }

  private endpointFor(hostId: string): string {
    if (process.platform === 'win32') return `\\\\.\\pipe\\agent-tui-host-${process.pid}-${hostId}`
    return join(this.runtimeDir, `${hostId}.sock`)
  }

  private async connect(hostId: string, endpoint: string, timeoutMs = this.timeoutMs): Promise<PipeHostHandle> {
    const deadline = Date.now() + timeoutMs
    let lastError: Error | undefined
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = net.createConnection(endpoint)
          const timer = setTimeout(() => {
            candidate.destroy()
            reject(new Error(`Timed out opening endpoint ${endpoint}`))
          }, Math.max(1, deadline - Date.now()))
          const onError = (error: Error): void => {
            clearTimeout(timer)
            reject(error)
          }
          candidate.once('connect', () => {
            clearTimeout(timer)
            candidate.removeListener('error', onError)
            resolve(candidate)
          })
          candidate.once('error', onError)
        })
        return new PipeHostHandle(hostId, socket)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw new Error(`Timed out connecting to Session Host ${hostId}: ${lastError?.message ?? 'unknown error'}`)
  }

  private async readRecord(hostId: string): Promise<HostRecord> {
    return JSON.parse(await readFile(this.registryPath(hostId), 'utf8')) as HostRecord
  }

  private async writeRecord(record: HostRecord): Promise<void> {
    await writeFile(this.registryPath(record.hostId), JSON.stringify(record, null, 2))
  }

  private registryPath(hostId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(hostId)) throw new Error('Invalid host id')
    return join(this.runtimeDir, `host-${hostId}.json`)
  }
}
