import type { ApprovalRequest, SessionSummary } from '../src/shared/manager-api'
import { approvalModeOf } from '../src/shared/approval-mode'

export interface AttentionSoundDecision {
  sessionId: string
  kind: 'approval' | 'question' | 'completion' | 'attention'
  outcome: 'queued' | 'suppressed-active' | 'invalidated' | 'played'
}

interface SoundPort {
  session(id: string): SessionSummary | undefined
  approvals(id: string): ApprovalRequest[]
  isActive(id: string): boolean
  play(): void
  onDecision?(event: AttentionSoundDecision): void
}
interface Question { id: string; timestamp: number }
interface Ticket { sessionId: string; key: string; valid: () => boolean }

/** Only observes attention; never approves, submits input or changes a session. */
export class AttentionSound {
  private readonly snapshots = new Map<string, SessionSummary>()
  private readonly seen = new Map<string, Set<string>>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly questions = new Map<string, Set<string>>()
  private readonly terminalQuestions = new Map<string, {
    key: string; timestamp: number; valid: () => boolean; nativeIds: Set<string>; distinctMenu: boolean
  }>()
  private readonly lastTerminalKeys = new Map<string, string>()
  private timer?: ReturnType<typeof setTimeout>
  private ready = false
  private lastSoundAt = -Infinity
  private readonly startedAt: number

  constructor(private readonly port: SoundPort, private readonly now = Date.now) { this.startedAt = now() }

  seed(sessions: SessionSummary[]): void {
    for (const session of sessions) this.snapshots.set(session.sessionId, { ...session })
    this.ready = true
  }

  sessionChanged(id: string): void {
    if (!this.ready) return
    const current = this.port.session(id)
    const previous = this.snapshots.get(id)
    if (!current) { this.forget(id); return }
    if (previous && previous.activitySince !== current.activitySince) this.forget(id)
    this.snapshots.set(id, { ...current })
    if (approvalModeOf(current) === 'manual') {
      for (const request of this.port.approvals(id)) this.approvalNeedsUser(request)
    }
    if (!previous || current.userStopRequested || current.status === 'stopped') return
    const completed = (session: SessionSummary): boolean => session.status === 'completed' || session.activity === 'completed'
    const unattendedFinished = previous.unattended?.enabled && !current.unattended?.enabled
      && /无监管已完成/.test(current.unattended?.reason ?? '')
    if (completed(current) && (!completed(previous) || unattendedFinished)
      && !current.unattended?.enabled
      && (current.status === 'completed' || (current.activityUpdatedAt ?? 0) >= this.startedAt)) {
      this.notify(id, 'completed:' + (current.activitySince ?? '') + ':' + (current.activityUpdatedAt ?? this.now()), () => {
        const latest = this.port.session(id)
        return Boolean(latest && !latest.userStopRequested && latest.status !== 'stopped'
          && !latest.unattended?.enabled && completed(latest))
      })
    }
    if (['needs_attention', 'failed'].includes(current.status) && current.status !== previous.status) {
      this.notify(id, 'attention:' + this.now(), () => {
        const latest = this.port.session(id)
        return Boolean(latest && !latest.userStopRequested && ['needs_attention', 'failed'].includes(latest.status))
      })
    }
  }

  approvalNeedsUser(request: ApprovalRequest): void {
    if (!this.ready) return
    const original = this.port.session(request.sessionId)
    if (!original) return
    const mode = approvalModeOf(original)
    this.notify(request.sessionId, 'approval:' + request.requestId, () => {
      const session = this.port.session(request.sessionId)
      const current = this.port.approvals(request.sessionId).find(item => item.requestId === request.requestId)
      return Boolean(session && !session.userStopRequested && !['stopped', 'completed', 'failed'].includes(session.status)
        && mode !== 'unattended' && approvalModeOf(session) === mode && current && current.llmReviewStatus !== 'pending')
    })
  }

  observeQuestions(id: string, pending: readonly Question[]): boolean {
    const answered = Boolean(this.questions.get(id)?.size) && pending.length === 0
    // Native capture can arrive just after the terminal menu. Transfer that
    // notification to the call ID instead of ringing for the same question twice.
    const terminal = this.terminalQuestions.get(id)
    if (terminal && (pending.length || answered)) {
      const matching = terminal.valid() ? pending.find(question => !terminal.nativeIds.has(question.id)
        && question.timestamp >= terminal.timestamp - 30_000
        && question.timestamp <= terminal.timestamp + 1000) : undefined
      if (matching && this.seen.get(id)?.has(terminal.key)) this.remember(id, 'question:' + matching.id)
      if (answered) this.remember(id, terminal.key)
      // Repeated old snapshots must not cancel a newer on-screen menu while
      // the native transcript is delayed or temporarily unavailable.
      if (matching || answered) {
        this.tickets.delete(id + '\0' + terminal.key)
        this.terminalQuestions.delete(id)
      }
    }
    this.questions.set(id, new Set(pending.map(question => question.id)))
    const since = this.port.session(id)?.activitySince ?? this.startedAt
    for (const question of pending) {
      // Restored managed runs can still be waiting on a question asked before
      // this window started. Native capture has already removed answered calls.
      if (question.timestamp < since) continue
      this.notify(id, 'question:' + question.id, () => Boolean(this.questions.get(id)?.has(question.id)
        && this.liveSession(id)))
    }
    return answered
  }

  terminalQuestion(id: string, token: string, stillPending: () => boolean): void {
    const key = 'terminal-question:' + token
    const previous = this.terminalQuestions.get(id)
    const lastKey = this.lastTerminalKeys.get(id)
    const distinctMenu = lastKey !== undefined && lastKey !== key
      || previous?.key === key && previous.distinctMenu
    this.lastTerminalKeys.set(id, key)
    this.terminalQuestions.set(id, previous?.key === key ? { ...previous, valid: stillPending }
      : { key, timestamp: this.now(), valid: stillPending, nativeIds: new Set(this.questions.get(id)), distinctMenu })
    // The last native snapshot may still describe the previous question. Defer
    // to native detection without claiming this new menu was heard or viewed;
    // otherwise its unseen call ID inherits a false acknowledgement later.
    if (this.questions.get(id)?.size && !this.port.isActive(id) && !distinctMenu) return
    this.notify(id, key, () => this.liveSession(id) && stillPending())
  }

  acknowledge(id: string): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.sessionId !== id) continue
      this.remember(id, ticket.key)
      this.tickets.delete(key)
      this.decision(ticket, this.port.isActive(id) ? 'suppressed-active' : 'invalidated')
    }
  }

  dispose(): void {
    this.ready = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.tickets.clear(); this.snapshots.clear(); this.seen.clear(); this.questions.clear(); this.terminalQuestions.clear(); this.lastTerminalKeys.clear()
  }

  private liveSession(id: string): boolean {
    const session = this.port.session(id)
    return Boolean(session && !session.userStopRequested && !['stopped', 'completed', 'failed'].includes(session.status))
  }

  private forget(id: string): void {
    this.acknowledge(id); this.snapshots.delete(id); this.seen.delete(id); this.questions.delete(id); this.terminalQuestions.delete(id); this.lastTerminalKeys.delete(id)
  }

  private remember(id: string, key: string): void {
    const seen = this.seen.get(id) ?? new Set<string>()
    seen.add(key)
    while (seen.size > 256) seen.delete(seen.values().next().value!)
    this.seen.set(id, seen)
  }

  private notify(sessionId: string, key: string, valid: () => boolean): void {
    if (!this.ready || this.seen.get(sessionId)?.has(key)) return
    // Events already seen in the active Agent must not ring after changing tabs.
    if (this.port.isActive(sessionId)) {
      if (valid()) { this.remember(sessionId, key); this.decision({ sessionId, key }, 'suppressed-active') }
      return
    }
    const queued = this.tickets.has(sessionId + '\0' + key)
    this.tickets.set(sessionId + '\0' + key, { sessionId, key, valid })
    if (!queued) this.decision({ sessionId, key }, 'queued')
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), Math.max(400, this.lastSoundAt + 1500 - this.now()))
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = undefined
    let play = false
    for (const ticket of this.tickets.values()) {
      if (!ticket.valid()) { this.decision(ticket, 'invalidated'); continue }
      this.remember(ticket.sessionId, ticket.key)
      if (!this.port.isActive(ticket.sessionId)) { play = true; this.decision(ticket, 'played') }
      else this.decision(ticket, 'suppressed-active')
    }
    this.tickets.clear()
    if (play) {
      this.lastSoundAt = this.now()
      try { this.port.play() } catch { /* Missing audio must never interrupt Agent management. */ }
    }
  }

  private decision(ticket: Pick<Ticket, 'sessionId' | 'key'>, outcome: AttentionSoundDecision['outcome']): void {
    const kind = ticket.key.startsWith('approval:') ? 'approval'
      : ticket.key.startsWith('completed:') ? 'completion'
        : ticket.key.startsWith('attention:') ? 'attention' : 'question'
    try { this.port.onDecision?.({ sessionId: ticket.sessionId, kind, outcome }) } catch { /* Diagnostics are optional. */ }
  }
}
