export type TerminalWriteCompletion = (timedOut: boolean) => void
export type TerminalWriteCallback = (() => void) & { progress: () => void }

/**
 * Guards xterm's asynchronous `write(data, callback)` completion callback.
 *
 * A missing callback must not permanently lock the renderer's output queue. Each arm
 * returns an idempotent completion callback; if xterm misses the deadline, the watchdog
 * releases that write once. A late callback cannot release a newer write, but callers may
 * use `onLateComplete` to repaint after xterm eventually finishes processing it.
 */
export class TerminalWriteWatchdog {
  private generation = 0
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly timeoutMs: number) {}

  arm(onComplete: TerminalWriteCompletion, onLateComplete?: () => void): TerminalWriteCallback {
    const generation = ++this.generation
    let completionSent = false
    let callbackSeen = false

    const expire = (): void => {
      this.timers.delete(generation)
      if (this.disposed || completionSent) return
      completionSent = true
      onComplete(true)
    }
    const renew = (): void => {
      const previous = this.timers.get(generation)
      if (previous) clearTimeout(previous)
      this.timers.set(generation, setTimeout(expire, this.timeoutMs))
    }
    renew()

    return Object.assign(() => {
      if (callbackSeen || this.disposed) return
      callbackSeen = true
      const pendingTimer = this.timers.get(generation)
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        this.timers.delete(generation)
      }
      if (!completionSent && generation === this.generation) {
        completionSent = true
        onComplete(false)
      } else {
        onLateComplete?.()
      }
    }, {
      // Parsing may yield between chunks of one logical replay. A progressing
      // batch is not stalled: keep its protocol/resize latch until the final chunk.
      progress: () => {
        if (!this.disposed && !completionSent && !callbackSeen && generation === this.generation) renew()
      },
    })
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
