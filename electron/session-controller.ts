import { randomUUID } from 'node:crypto'

import type { HostHandle, HostMetadataUpdate, HostRecord, SessionHostManager, StartHostOptions } from './session-host-manager'
import type { HostEvent, HostExitFact } from '../src/shared/protocol'
import type { AgentKind, ManagerEvent, NativeSessionSummary, SessionSummary, StartSessionRequest } from '../src/shared/manager-api'
import { reduceSession } from '../src/shared/session-state'
import { createAgentAdapter, type AgentAdapter } from './agent-adapters'
import type { ApprovalDecision } from './approval-policy'

export interface SessionHostManagerPort {
  start(options: StartHostOptions): Promise<HostHandle>
  reconnect(hostId: string): Promise<HostHandle>
  listLiveHosts(): Promise<HostRecord[]>
  readLastExit(hostId: string): Promise<HostExitFact | undefined>
  updateMetadata(hostId: string, update: HostMetadataUpdate): Promise<void>
}

export interface NativeSessionDiscoveryPort {
  discover(agentKind: AgentKind, workspace: string): Promise<NativeSessionSummary[]>
}

export interface ApprovalPolicyPort {
  decide(command: string | undefined): ApprovalDecision
}

interface NativeSessionCapture {
  baselineIds: Set<string>
  startedAt: number
  attempts: number
  inFlight: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface ManagedSession {
  summary: SessionSummary
  request?: StartSessionRequest
  handle: HostHandle
  generation: number
  recoveryToken: number
  pendingUserInterrupt: boolean
  awaitingRecoveryReady: boolean
  adapter: AgentAdapter
  nativeCapture?: NativeSessionCapture
  pendingApprovalCommand?: string
}

type Emit = (event: ManagerEvent) => void

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out waiting for host event/i.test(error.message)
}

export class SessionController {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly manager: SessionHostManagerPort
  private readonly emit: Emit
  private readonly discovery?: NativeSessionDiscoveryPort
  private readonly approvalPolicy?: ApprovalPolicyPort

  constructor(
    manager: SessionHostManager | SessionHostManagerPort,
    emit: Emit = () => undefined,
    discovery?: NativeSessionDiscoveryPort,
    approvalPolicy?: ApprovalPolicyPort,
  ) {
    this.manager = manager
    this.emit = emit
    this.discovery = discovery
    this.approvalPolicy = approvalPolicy
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(({ summary }) => ({ ...summary }))
  }

  async startSession(request: StartSessionRequest): Promise<SessionSummary> {
    const adapter = createAgentAdapter(request.agentKind)
    const nativeCapture = !request.nativeSessionId && adapter.supportsNativeSessions
      ? await this.prepareNativeCapture(request.agentKind, request.workspace)
      : undefined
    const sessionId = randomUUID()
    const handle = await this.manager.start(this.hostOptions(request))
    const managed: ManagedSession = {
      summary: {
        sessionId,
        displayName: request.displayName,
        agentKind: request.agentKind,
        workspace: request.workspace,
        status: 'running',
        recoveryAttempts: 0,
        userStopRequested: false,
        ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
      },
      request,
      handle,
      generation: 1,
      recoveryToken: 0,
      pendingUserInterrupt: false,
      awaitingRecoveryReady: false,
      adapter,
      ...(nativeCapture ? { nativeCapture } : {}),
    }
    this.sessions.set(sessionId, managed)
    this.changed(sessionId)
    void this.pump(managed, managed.generation)
    return { ...managed.summary }
  }

  async restoreLiveHosts(): Promise<void> {
    for (const record of await this.manager.listLiveHosts()) {
      if (this.sessions.has(record.hostId)) continue
      try {
        const handle = await this.manager.reconnect(record.hostId)
        const agentKind = record.agentKind ?? 'generic'
        const managed: ManagedSession = {
          summary: {
            sessionId: record.hostId,
            displayName: `已恢复 Agent ${record.hostId.slice(0, 8)}`,
            agentKind,
            workspace: record.cwd,
            status: 'running',
            recoveryAttempts: 0,
            userStopRequested: false,
            ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
          },
          handle,
          generation: 1,
          recoveryToken: 0,
          pendingUserInterrupt: false,
          awaitingRecoveryReady: false,
          adapter: createAgentAdapter(agentKind),
        }
        if (record.recovery) {
          managed.request = {
            displayName: managed.summary.displayName,
            agentKind,
            workspace: record.cwd,
            executable: record.recovery.executable,
            args: [...record.recovery.args],
            cols: record.cols ?? 80,
            rows: record.rows ?? 24,
            ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
            recovery: {
              executable: record.recovery.executable,
              args: [...record.recovery.args],
              ...(record.recovery.continueInput ? { continueInput: record.recovery.continueInput } : {}),
            },
          }
        }
        this.sessions.set(record.hostId, managed)
        this.changed(record.hostId)
        void this.pump(managed, managed.generation)
      } catch {
        // A live host can be between endpoint restarts; the next app launch probes again.
      }
    }
  }

  write(sessionId: string, data: string): void {
    const managed = this.required(sessionId)
    if (data === '\x03' || data === '\x1b') managed.pendingUserInterrupt = true
    else if (data.length > 0) {
      managed.pendingUserInterrupt = false
      managed.adapter.acknowledgeUserInput()
      if (managed.summary.status === 'needs_approval' && /[\r\n]/.test(data)) {
        managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
        this.changed(sessionId)
      }
    }
    managed.handle.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.required(sessionId).handle.resize(cols, rows)
  }

  approveSession(sessionId: string): void {
    const managed = this.required(sessionId)
    if (managed.summary.status !== 'needs_approval') throw new Error('Session is not awaiting approval')
    managed.adapter.acknowledgeUserInput()
    managed.handle.write(managed.adapter.approvalInput())
    managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
    delete managed.pendingApprovalCommand
    this.changed(sessionId)
  }

  async stopSession(sessionId: string): Promise<void> {
    const managed = this.required(sessionId)
    managed.recoveryToken += 1
    const generation = managed.generation
    const hostId = managed.handle.hostId
    managed.pendingUserInterrupt = true
    managed.summary = reduceSession(managed.summary, { type: 'user-stop-requested' }) as SessionSummary
    this.changed(sessionId)
    await managed.handle.stop().catch(() => undefined)
    const exit = await this.manager.readLastExit(hostId).catch(() => undefined)
    if (exit) await this.onExit(managed, generation, exit.exitCode)
  }

  private async pump(managed: ManagedSession, generation: number): Promise<void> {
    while (managed.generation === generation) {
      let event: HostEvent
      try {
        event = await managed.handle.nextEvent()
      } catch (error) {
        if (managed.generation !== generation) return
        if (isTimeout(error)) continue
        const exit = await this.readExitFact(managed.handle.hostId)
        if (exit) await this.onExit(managed, generation, exit.exitCode)
        else if (managed.pendingUserInterrupt || managed.summary.userStopRequested) {
          managed.summary = reduceSession(managed.summary, {
            type: 'process-exited', exitCode: 1, userInitiated: true, adapterCompletion: false,
          }) as SessionSummary
          this.changed(managed.summary.sessionId)
        } else {
          managed.handle.disconnect()
          await this.failOrRecover(managed, generation, 'Host connection lost')
        }
        return
      }
      if (managed.generation !== generation) return
      this.emit({ sessionId: managed.summary.sessionId, ...event })
      if (event.type === 'output') {
        const observation = managed.adapter.observeOutput(event.data)
        if (observation.approvalRequired && managed.summary.status !== 'needs_approval') {
          const decision = this.approvalPolicy?.decide(observation.approvalCommand)
          if (decision?.action === 'auto-approve') {
            managed.adapter.acknowledgeUserInput()
            managed.handle.write(managed.adapter.approvalInput())
            managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
          } else {
            managed.pendingApprovalCommand = observation.approvalCommand
            managed.summary = reduceSession(managed.summary, { type: 'approval-required' }) as SessionSummary
          }
          this.changed(managed.summary.sessionId)
        }
        if (managed.awaitingRecoveryReady && observation.ready) {
          managed.awaitingRecoveryReady = false
          managed.summary = reduceSession(managed.summary, { type: 'started' }) as SessionSummary
          managed.handle.write(managed.request?.recovery?.continueInput ?? 'continue\r')
          this.changed(managed.summary.sessionId)
        }
        this.scheduleNativeCapture(managed)
      } else if (event.type === 'exit') {
        await this.onExit(managed, generation, event.exitCode)
        return
      } else if (event.type === 'error') {
        managed.summary = { ...managed.summary, lastError: event.message }
        this.changed(managed.summary.sessionId)
      }
    }
  }

  private async onExit(managed: ManagedSession, generation: number, exitCode: number): Promise<void> {
    if (managed.generation !== generation) return
    managed.handle.disconnect()
    if (exitCode === 0) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited', exitCode: 0, userInitiated: false, adapterCompletion: false,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }
    if (managed.pendingUserInterrupt || managed.summary.userStopRequested) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited',
        exitCode,
        userInitiated: true,
        adapterCompletion: false,
      }) as SessionSummary
      this.changed(managed.summary.sessionId)
      return
    }
    await this.failOrRecover(managed, generation, `Process exited with code ${exitCode}`)
  }

  private async failOrRecover(managed: ManagedSession, generation: number, reason: string): Promise<void> {
    if (managed.generation !== generation) return
    if (!managed.request?.recovery) {
      managed.summary = reduceSession(managed.summary, {
        type: 'process-exited', exitCode: 1, userInitiated: false, adapterCompletion: false,
      }) as SessionSummary
      managed.summary = { ...managed.summary, lastError: reason }
      this.changed(managed.summary.sessionId)
      return
    }
    managed.summary = reduceSession(managed.summary, {
      type: managed.summary.status === 'recovering' ? 'recovery-failed' : 'abnormal-exit', reason,
    }) as SessionSummary
    this.changed(managed.summary.sessionId)
    if (managed.summary.status !== 'recovering') return
    await this.startRecovery(managed)
  }

  private async startRecovery(managed: ManagedSession): Promise<void> {
    const recipe = managed.request?.recovery
    if (!recipe) return
    const generation = managed.generation
    const recoveryToken = ++managed.recoveryToken
    try {
      const handle = await this.manager.start({
        agentKind: managed.summary.agentKind,
        executable: recipe.executable,
        args: recipe.args,
        cwd: managed.summary.workspace,
        cols: managed.request?.cols ?? 80,
        rows: managed.request?.rows ?? 24,
        ...(managed.summary.nativeSessionId ? { nativeSessionId: managed.summary.nativeSessionId } : {}),
        recovery: recipe,
      })
      if (managed.generation !== generation || managed.recoveryToken !== recoveryToken
        || managed.summary.userStopRequested || managed.summary.status === 'stopped') {
        await handle.stop().catch(() => undefined)
        handle.disconnect()
        return
      }
      managed.handle = handle
      managed.generation += 1
      managed.pendingUserInterrupt = false
      managed.awaitingRecoveryReady = true
      managed.adapter.resetForRecovery()
      void this.pump(managed, managed.generation)
    } catch (error) {
      if (managed.generation !== generation || managed.recoveryToken !== recoveryToken
        || managed.summary.userStopRequested || managed.summary.status === 'stopped') return
      await this.failOrRecover(managed, generation, error instanceof Error ? error.message : String(error))
    }
  }

  private hostOptions(request: StartSessionRequest): StartHostOptions {
    return {
      agentKind: request.agentKind,
      executable: request.executable,
      args: request.args,
      cwd: request.workspace,
      cols: request.cols,
      rows: request.rows,
      ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
      ...(request.recovery ? { recovery: request.recovery } : {}),
    }
  }

  private async readExitFact(hostId: string): Promise<HostExitFact | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const exit = await this.manager.readLastExit(hostId).catch(() => undefined)
      if (exit) return exit
      if (attempt < 2) await Promise.resolve()
    }
    return undefined
  }

  private async prepareNativeCapture(agentKind: AgentKind, workspace: string): Promise<NativeSessionCapture | undefined> {
    if (!this.discovery) return undefined
    try {
      const existing = await this.discovery.discover(agentKind, workspace)
      return {
        baselineIds: new Set(existing.map((session) => session.id)),
        startedAt: Date.now(),
        attempts: 0,
        inFlight: false,
      }
    } catch {
      return undefined
    }
  }

  private scheduleNativeCapture(managed: ManagedSession): void {
    const capture = managed.nativeCapture
    if (!capture || capture.inFlight || capture.timer || managed.summary.nativeSessionId || !this.discovery) return
    const delays = [0, 250, 750, 2_000, 5_000]
    const delay = delays[capture.attempts]
    if (delay === undefined) return
    capture.timer = setTimeout(() => {
      capture.timer = undefined
      void this.tryCaptureNativeSession(managed)
    }, delay)
    capture.timer.unref?.()
  }

  private async tryCaptureNativeSession(managed: ManagedSession): Promise<void> {
    const capture = managed.nativeCapture
    const discovery = this.discovery
    if (!capture || !discovery || capture.inFlight || managed.summary.nativeSessionId) return
    capture.inFlight = true
    capture.attempts += 1
    try {
      const sessions = await discovery.discover(managed.summary.agentKind, managed.summary.workspace)
      const candidates = sessions.filter((session) => !capture.baselineIds.has(session.id)
        && session.updatedAt >= capture.startedAt - 5_000)
      if (candidates.length !== 1) return
      const nativeSessionId = candidates[0]!.id
      const request = managed.request
      if (!request) return
      const recovery = managed.adapter.recoveryRecipe(request.executable, nativeSessionId)
      if (!recovery) return
      await this.manager.updateMetadata(managed.handle.hostId, { nativeSessionId, recovery })
      request.nativeSessionId = nativeSessionId
      request.recovery = recovery
      managed.summary = { ...managed.summary, nativeSessionId }
      delete managed.nativeCapture
      this.changed(managed.summary.sessionId)
    } catch {
      // Native history is advisory. A failed read must not interrupt the live Agent.
    } finally {
      capture.inFlight = false
      if (managed.nativeCapture === capture) this.scheduleNativeCapture(managed)
    }
  }

  private required(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error('Unknown session')
    return managed
  }

  private changed(sessionId: string): void {
    this.emit({ type: 'sessions-changed', sessionId })
  }
}
