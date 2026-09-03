import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'

import type { HostCommand, HostEvent, HostExitFact } from '../src/shared/protocol'
import type { AgentConfigSummary, AgentKind, AgentProxySummary, RecoveryRecipe } from '../src/shared/manager-api'

const DEFAULT_TIMEOUT_MS = 5_000

export interface HostRecord {
  hostId: string
  sessionId?: string
  displayName?: string
  agentKind?: AgentKind
  cwd: string
  nativeSessionId?: string
  recovery?: RecoveryRecipe
  cols?: number
  rows?: number
  maxContinueRetries?: number
  agentConfig?: AgentConfigSummary
  agentProxy?: AgentProxySummary
  fullAutoEnabled?: boolean
  permissionHook?: 'claude' | 'codex'
  pid: number
  endpoint: string
  lifecycle: 'starting' | 'running'
  createdAt: string
  updatedAt: string
  managerOwnership?: 'managed' | 'preserved' | 'unclaimed'
}

export interface StartHostOptions {
  sessionId?: string
  displayName?: string
  agentKind: AgentKind
  executable: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  maxContinueRetries?: number
  agentConfig?: AgentConfigSummary
  agentProxy?: AgentProxySummary
  fullAutoEnabled?: boolean
  nativeSessionId?: string
  recovery?: RecoveryRecipe
}

export interface HostMetadataUpdate {
  displayName?: string
  nativeSessionId?: string
  recovery?: RecoveryRecipe
  agentConfig?: AgentConfigSummary | null
  agentProxy?: AgentProxySummary | null
  fullAutoEnabled?: boolean
}

export interface HostHandle {
  readonly hostId: string
  readonly permissionHook?: 'claude' | 'codex'
  nextEvent(timeoutMs?: number): Promise<HostEvent>
  ping(timeoutMs: number): Promise<'managed' | 'preserved' | 'unclaimed'>
  write(data: string): void
  resize(cols: number, rows: number): void
  replay(timeoutMs?: number): Promise<string>
  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny'): void
  respondToPermissionChecked?(requestId: string, action: 'allow' | 'ask' | 'deny'): Promise<boolean>
  stop(): Promise<void>
  preserveOnDisconnect?(): Promise<void>
  resumeManagement?(): void
  updateManagerLeasePolicy?(preserveOnLeaseExpiry: boolean): void
  disconnect(): void
}

export interface SessionHostManagerOptions {
  runtimeDir: string
  socketDir?: string
  hostEntry: string
  nodeExecutable?: string
  timeoutMs?: number
  leaseMs?: number
  preserveOnLeaseExpiry?: boolean
  resolveAgentConfig?: (profileId: string, agentKind: AgentKind, args: string[]) => Promise<{ environment: Record<string, string>; args: string[] }>
  resolveAgentProxy?: (proxyId: string) => Promise<Record<string, string>>
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
  permissionHook?: 'claude' | 'codex'
  private readonly socket: Socket
  private readonly events: HostEvent[] = []
  private readonly waiters: EventWaiter[] = []
  private readonly pongWaiters: EventWaiter[] = []
  private readonly replayWaiters: EventWaiter[] = []
  private readonly preserveWaiters: EventWaiter[] = []
  private readonly permissionResponseWaiters = new Map<string, { resolve: (delivered: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private closedError: Error | undefined
  private readonly timeoutMs: number
  private readonly managerId: string
  private readonly leaseMs: number
  private preserveOnLeaseExpiry: boolean
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  constructor(hostId: string, socket: Socket, timeoutMs: number, managerId: string, leaseMs: number, preserveOnLeaseExpiry: boolean) {
    this.hostId = hostId
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.managerId = managerId
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.onData(chunk.toString()))
    socket.on('error', (error) => this.close(error))
    socket.on('close', () => this.close(new Error(`Host ${hostId} connection closed`)))
    this.leaseMs = leaseMs
    this.preserveOnLeaseExpiry = preserveOnLeaseExpiry
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

  replay(timeoutMs = 250): Promise<string> {
    const pending = this.createWaiter(this.replayWaiters, timeoutMs, 'terminal replay')
    try {
      this.send({ type: 'replay' })
    } catch (error) {
      pending.cancel(error instanceof Error ? error : new Error(String(error)))
    }
    return pending.promise.then((event) => event.type === 'replay' ? event.data : '')
  }

  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny'): void {
    this.send({ type: 'permission-response', requestId, action })
  }

  respondToPermissionChecked(requestId: string, action: 'allow' | 'ask' | 'deny'): Promise<boolean> {
    const previous = this.permissionResponseWaiters.get(requestId)
    if (previous) {
      clearTimeout(previous.timer)
      previous.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.permissionResponseWaiters.get(requestId)?.timer !== timer) return
        this.permissionResponseWaiters.delete(requestId)
        resolve(false)
      }, Math.max(1_000, Math.min(this.timeoutMs, 5_000)))
      this.permissionResponseWaiters.set(requestId, { resolve, timer })
      try {
        this.send({ type: 'permission-response', requestId, action })
      } catch {
        clearTimeout(timer)
        this.permissionResponseWaiters.delete(requestId)
        resolve(false)
      }
    })
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.socket.destroy()
  }

  async preserveOnDisconnect(): Promise<void> {
    const pending = this.createWaiter(this.preserveWaiters, this.timeoutMs, 'manager preserve acknowledgement')
    try {
      this.send({ type: 'preserve-on-disconnect', managerId: this.managerId })
    } catch (error) {
      pending.cancel(error instanceof Error ? error : new Error(String(error)))
    }
    const event = await pending.promise
    if (event.type !== 'manager-preserved' || event.managerId !== this.managerId) {
      throw new Error(`Host ${this.hostId} did not confirm preserved state`)
    }
  }

  resumeManagement(): void {
    this.claim()
  }

  updateManagerLeasePolicy(preserveOnLeaseExpiry: boolean): void {
    this.preserveOnLeaseExpiry = preserveOnLeaseExpiry
    this.claim()
  }

  claim(): void {
    this.send({ type: 'claim-manager', managerId: this.managerId, leaseMs: this.leaseMs, preserveOnLeaseExpiry: this.preserveOnLeaseExpiry })
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      try { this.send({ type: 'manager-heartbeat', managerId: this.managerId }) } catch { /* close handler owns cleanup */ }
    }, Math.max(1_000, Math.floor(this.leaseMs / 5)))
    this.heartbeatTimer.unref()
  }

  send(command: HostCommand): void {
    if (this.closedError || this.socket.destroyed) {
      throw this.closedError ?? new Error(`Host ${this.hostId} connection is closed`)
    }
    this.socket.write(`${JSON.stringify(command)}\n`)
  }

  ping(timeoutMs: number): Promise<'managed' | 'preserved' | 'unclaimed'> {
    const pending = this.createWaiter(this.pongWaiters, timeoutMs, 'pong')
    try {
      this.send({ type: 'ping' })
    } catch (error) {
      pending.cancel(error instanceof Error ? error : new Error(String(error)))
    }
    return pending.promise.then((event) => event.type === 'pong' ? event.ownership ?? 'preserved' : 'unclaimed')
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
        if (event.type === 'permission-response-ack') {
          const waiter = this.permissionResponseWaiters.get(event.requestId)
          if (waiter) {
            this.permissionResponseWaiters.delete(event.requestId)
            clearTimeout(waiter.timer)
            waiter.resolve(event.delivered)
          }
        } else if (event.type === 'pong') this.deliver(this.pongWaiters, event)
        else if (event.type === 'replay') this.deliver(this.replayWaiters, event)
        else if (event.type === 'manager-preserved') this.deliver(this.preserveWaiters, event)
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const waiter of [...this.waiters, ...this.pongWaiters, ...this.replayWaiters, ...this.preserveWaiters]) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.length = 0
    this.pongWaiters.length = 0
    this.replayWaiters.length = 0
    this.preserveWaiters.length = 0
    for (const waiter of this.permissionResponseWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.permissionResponseWaiters.clear()
  }
}

export class SessionHostManager {
  private readonly runtimeDir: string
  private readonly socketDir: string
  private readonly hostEntry: string
  private readonly nodeExecutable: string
  private readonly timeoutMs: number
  private readonly resolveAgentConfig?: SessionHostManagerOptions['resolveAgentConfig']
  private readonly resolveAgentProxy?: SessionHostManagerOptions['resolveAgentProxy']
  private readonly managerId = randomUUID()
  private readonly leaseMs: number
  private preserveOnLeaseExpiry: boolean

  constructor(options: SessionHostManagerOptions) {
    this.runtimeDir = options.runtimeDir
    this.socketDir = options.socketDir ?? options.runtimeDir
    this.hostEntry = options.hostEntry
    this.nodeExecutable = options.nodeExecutable ?? process.execPath
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.leaseMs = Math.max(5_000, Math.min(60_000, options.leaseMs ?? 15_000))
    this.preserveOnLeaseExpiry = options.preserveOnLeaseExpiry !== false
    this.resolveAgentConfig = options.resolveAgentConfig
    this.resolveAgentProxy = options.resolveAgentProxy
  }

  setPreserveOnLeaseExpiry(value: boolean): void {
    this.preserveOnLeaseExpiry = value
  }

  async start(options: StartHostOptions): Promise<HostHandle> {
    await mkdir(this.runtimeDir, { recursive: true })
    if (this.socketDir !== this.runtimeDir) await mkdir(this.socketDir, { recursive: true, mode: 0o700 })
    const hostId = randomUUID()
    const endpoint = this.endpointFor(hostId)
    const exitPath = this.exitPath(hostId)
    const createdAt = new Date().toISOString()
    const pendingRecord: HostRecord = {
      hostId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      agentKind: options.agentKind,
      cwd: options.cwd,
      ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}),
      ...(options.recovery ? { recovery: options.recovery } : {}),
      cols: options.cols,
      rows: options.rows,
      ...(options.maxContinueRetries === undefined ? {} : { maxContinueRetries: options.maxContinueRetries }),
      ...(options.agentConfig?.enabled ? { agentConfig: { ...options.agentConfig, extraArgs: [...options.agentConfig.extraArgs] } } : {}),
      ...(options.agentProxy?.enabled ? { agentProxy: { ...options.agentProxy } } : {}),
      ...(options.fullAutoEnabled ? { fullAutoEnabled: true } : {}),
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
      handle.claim()
      const configured = options.agentConfig?.enabled && options.agentConfig.profileId
        ? await this.resolveAgentConfig?.(options.agentConfig.profileId, options.agentKind, options.args)
        : undefined
      if (options.agentConfig?.enabled && options.agentConfig.profileId && !configured) throw new Error('独立配置不可用，未启动 Agent')
      const proxyEnvironment = options.agentProxy?.enabled && options.agentProxy.proxyId
        ? await this.resolveAgentProxy?.(options.agentProxy.proxyId)
        : undefined
      if (options.agentProxy?.enabled && options.agentProxy.proxyId && !proxyEnvironment) throw new Error('代理配置不可用，未启动 Agent')
      handle.send({
        type: 'start',
        agentKind: options.agentKind,
        executable: options.executable,
        args: configured?.args ?? options.args,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        ...((configured || proxyEnvironment) ? { environment: { ...configured?.environment, ...proxyEnvironment } } : {}),
      })
      const event = await raceChild(handle.nextEvent(this.timeoutMs))
      if (event.type !== 'ready') {
        throw new Error(event.type === 'error' ? event.message : `Expected ready, received ${event.type}`)
      }
      handle.permissionHook = event.permissionHook
      await this.writeRecord({
        ...pendingRecord,
        pid: child.pid,
        lifecycle: 'running',
        ...(event.permissionHook ? { permissionHook: event.permissionHook } : {}),
        updatedAt: new Date().toISOString(),
      })
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
    handle.permissionHook = record.permissionHook
    try {
      await handle.ping(this.timeoutMs)
      handle.claim()
      return handle
    } catch (error) {
      handle.disconnect()
      throw error
    }
  }

  async release(hostId: string): Promise<void> {
    const record = await this.readRecord(hostId)
    const handle = await this.connect(record.hostId, record.endpoint)
    try {
      await handle.stop()
    } finally {
      handle.disconnect()
    }
  }

  async forceRelease(hostId: string): Promise<void> {
    const record = await this.readRecord(hostId)
    if (record.hostId !== hostId || !Number.isInteger(record.pid) || record.pid <= 0 || record.pid === process.pid) {
      throw new Error('受管终端记录无效，已取消强制释放')
    }
    if (this.processExists(record.pid)) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          child.once('error', reject)
          child.once('exit', (code) => code === 0 || !this.processExists(record.pid) ? resolve() : reject(new Error('无法结束无响应的受管终端')))
        })
      } else {
        try { process.kill(-record.pid, 'SIGKILL') } catch { if (this.processExists(record.pid)) process.kill(record.pid, 'SIGKILL') }
      }
      const deadline = Date.now() + this.timeoutMs
      while (this.processExists(record.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.processExists(record.pid)) throw new Error('终端进程未能退出，请稍后重试')
    }
    await this.removeArtifacts(hostId)
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
        const managerOwnership = await handle.ping(Math.min(this.timeoutMs, 250))
        live.push({ ...record, managerOwnership })
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

  async updateMetadata(hostId: string, update: HostMetadataUpdate): Promise<void> {
    const record = await this.readRecord(hostId)
    const updated: HostRecord = {
      ...record,
      ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
      ...(update.nativeSessionId === undefined ? {} : { nativeSessionId: update.nativeSessionId }),
      ...(update.recovery === undefined ? {} : { recovery: {
        executable: update.recovery.executable,
        args: [...update.recovery.args],
        ...(update.recovery.continueInput === undefined ? {} : { continueInput: update.recovery.continueInput }),
      } }),
      ...(update.agentConfig === undefined || update.agentConfig === null ? {} : { agentConfig: { ...update.agentConfig, extraArgs: [...update.agentConfig.extraArgs] } }),
      ...(update.agentProxy === undefined || update.agentProxy === null ? {} : { agentProxy: { ...update.agentProxy } }),
      ...(update.fullAutoEnabled === undefined ? {} : { fullAutoEnabled: update.fullAutoEnabled }),
      updatedAt: new Date().toISOString(),
    }
    if (update.agentConfig === null) delete updated.agentConfig
    if (update.agentProxy === null) delete updated.agentProxy
    await this.writeRecord(updated)
  }

  async removeArtifacts(hostId: string): Promise<void> {
    await Promise.all([
      unlink(this.registryPath(hostId)).catch(() => undefined),
      unlink(this.exitPath(hostId)).catch(() => undefined),
      unlink(`${this.exitPath(hostId)}.claude-settings.json`).catch(() => undefined),
      unlink(`${this.exitPath(hostId)}.codex-hook.cmd`).catch(() => undefined),
      unlink(`${this.exitPath(hostId)}.codex-hook.sh`).catch(() => undefined),
      ...(process.platform === 'win32' ? [] : [unlink(join(this.socketDir, `${hostId}.sock`)).catch(() => undefined)]),
    ])
  }

  private endpointFor(hostId: string): string {
    if (process.platform === 'win32') return `\\\\.\\pipe\\agent-tui-host-${process.pid}-${hostId}`
    return join(this.socketDir, `${hostId}.sock`)
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
        return new PipeHostHandle(hostId, socket, this.timeoutMs, this.managerId, this.leaseMs, this.preserveOnLeaseExpiry)
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
