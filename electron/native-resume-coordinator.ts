import type { SessionSummary, StartSessionRequest } from '../src/shared/manager-api'

/** Coalesce launcher double-clicks and concurrent IPC calls before creating profiles or PTYs. */
export class NativeResumeCoordinator {
  private readonly pending = new Map<string, Promise<SessionSummary>>()
  run(request: StartSessionRequest, sessions: () => SessionSummary[], start: () => Promise<SessionSummary>): Promise<SessionSummary> {
    if (!request.nativeSessionId || !['codex', 'claude'].includes(request.agentKind)) return start()
    const key = `${request.agentKind}\0${request.nativeSessionId}`
    const running = sessions().find(session => session.agentKind === request.agentKind && session.nativeSessionId === request.nativeSessionId
      && !['stopped', 'failed', 'completed'].includes(session.status))
    if (running) return Promise.resolve(running)
    const pending = this.pending.get(key)
    if (pending) return pending
    const operation = Promise.resolve().then(start).finally(() => {
      if (this.pending.get(key) === operation) this.pending.delete(key)
    })
    this.pending.set(key, operation)
    return operation
  }
}
