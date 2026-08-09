import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'

import type { HostCommand, HostEvent, HostExitFact } from '../src/shared/protocol'
import type { AgentKind, RecoveryRecipe } from '../src/shared/manager-api'

const DEFAULT_TIMEOUT_MS = 5_000

export interface HostRecord {
  hostId: string
  agentKind?: AgentKind
  cwd: string
  nativeSessionId?: string
  recovery?: RecoveryRecipe
  cols?: number
  rows?: number
  pid: number
  endpoint: string
  lifecycle: 'starting' | 'running'
  createdAt: string
  updatedAt: string
}

export interface StartHostOptions {
  agentKind: AgentKind
  executable: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  nativeSessionId?: string
  recovery?: RecoveryRecipe
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

interface PendingEvent {
  promise: Promise<HostEvent>
  cancel: (error: Error) => void
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2))
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

class PipeHostHandle implements HostHandle {
  readonly hostId: string
  private readonly socket: Socket
  private readonly events: HostEvent[] = []
  private readonly waiters: EventWaiter[] = []
  private readonly pongWaiters: EventWaiter[] = []
  private buffer = ''
  private closedError: Error | undefined
  private readonly timeoutMs: number

  constructor(hostId: string, socket: Socket, timeoutMs: number) {
    this.hostId = hostId
    this.socket = socket
    this.timeoutMs = timeoutMs
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.onData(chunk.toString()))
    socket.on('error', (error) => this.close(error))
    socket.on('close', () => this.close(new Error(`Host ${hostId} connection closed`)))
  }

  nextEvent(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HostEvent> {
    const event = this.events.shift()
    if (event) return Promise.resolve(event)
    if (this.closedError) return Promise.reject(this.closedError)
    return this.createWaiter(this.waiters, timeoutMs, 'host event').promise
  }

  write(data: string): void {
    this.send({ type: 'write', data })
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  async stop(): Promise<void> {
    if (this.closedError || this.socket.destroyed) {
      throw this.closedError ?? new Error(`Host ${this.hostId} connection is closed`)
    }
    this.send({ type: 'stop' })
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for host event from host ${this.hostId}`)
      const event = await this.nextEvent(remaining)
      if (event.type === 'exit') return
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
    const pending = this.createWaiter(this.pongWaiters, timeoutMs, 'pong')
    try {
      this.send({ type: 'ping' })
    } catch (error) {
      pending.cancel(error instanceof Error ? error : new Error(String(error)))
    }
    return pending.promise.then(() => undefined)
  }

  private createWaiter(waiters: EventWaiter[], timeoutMs: number, label: string): PendingEvent {
    let waiter: EventWaiter
    const promise = new Promise<HostEvent>((resolve, reject) => {
      waiter = {
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
    return {
      promise,
      cancel: (error) => {
        const index = waiters.indexOf(waiter)
        if (index < 0) return
        waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.reject(error)
      },
    }
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
    const exitPath = this.exitPath(hostId)
    const createdAt = new Date().toISOString()
    const pendingRecord: HostRecord = {
      hostId,
      agentKind: options.agentKind,
      cwd: options.cwd,
      ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}),
      ...(options.recovery ? { recovery: options.recovery } : {}),
      cols: options.cols,
      rows: options.rows,
      pid: 0,
      endpoint,
      lifecycle: 'starting',
      createdAt,
      updatedAt: createdAt,
    }
    await this.writeRecord(pendingRecord)

    let child: ReturnType<typeof spawn> | undefined
    let handle: PipeHostHandle | undefined

    try {
      child = spawn(this.nodeExecutable, [this.hostEntry, '--host-id', hostId, '--endpoint', endpoint, '--exit-path', exitPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      const childFailure = new Promise<Error>((resolve) => {
        child!.once('error', (error) => resolve(error))
        child!.once('exit', (code, signal) => resolve(new Error(`Session Host exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)))
      })
      const raceChild = async <T>(operation: Promise<T>): Promise<T> => {
        const result = await Promise.race([
          operation.then((value) => ({ value })),
          childFailure.then((error) => ({ error })),
        ])
        if ('error' in result) throw result.error
        return result.value
      }

      if (child.pid === undefined) throw await childFailure
      await this.writeRecord({ ...pendingRecord, pid: child.pid, updatedAt: new Date().toISOString() })
      child.unref()
      handle = await raceChild(this.connect(hostId, endpoint))
      handle.send({
        type: 'start',
        executable: options.executable,
        args: options.args,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      })
      const event = await raceChild(handle.nextEvent(this.timeoutMs))
      if (event.type !== 'ready') {
        throw new Error(event.type === 'error' ? event.message : `Expected ready, received ${event.type}`)
      }
      await this.writeRecord({ ...pendingRecord, pid: child.pid, lifecycle: 'running', updatedAt: new Date().toISOString() })
      return handle
    } catch (error) {
      handle?.disconnect()
      if (child && !child.killed) child.kill()
      await unlink(this.registryPath(hostId)).catch(() => undefined)
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
      let record: HostRecord
      try {
        record = JSON.parse(await readFile(path, 'utf8')) as HostRecord
      } catch {
        continue
      }
      if (!Number.isInteger(record.pid) || record.pid <= 0) continue
      if (!this.processExists(record.pid)) {
        await unlink(path).catch(() => undefined)
        continue
      }
      let handle: PipeHostHandle | undefined
      try {
        handle = await this.connect(record.hostId, record.endpoint, Math.min(this.timeoutMs, 250))
        await handle.ping(Math.min(this.timeoutMs, 250))
        live.push(record)
      } catch {
        // A live process with a transiently missing endpoint is retained for a later probe.
      } finally {
        handle?.disconnect()
      }
    }
    return live
  }

  async readLastExit(hostId: string): Promise<HostExitFact | undefined> {
    try {
      return JSON.parse(await readFile(this.exitPath(hostId), 'utf8')) as HostExitFact
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
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
        return new PipeHostHandle(hostId, socket, this.timeoutMs)
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
    await atomicWriteJson(this.registryPath(record.hostId), record)
  }

  private registryPath(hostId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(hostId)) throw new Error('Invalid host id')
    return join(this.runtimeDir, `host-${hostId}.json`)
  }

  private exitPath(hostId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(hostId)) throw new Error('Invalid host id')
    return join(this.runtimeDir, `exit-${hostId}.json`)
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}
