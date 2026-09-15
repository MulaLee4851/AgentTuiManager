export interface MessageTarget {
  generation: number
  nativeSessionId?: string
}

/** One submission per session. Never retries Enter into an unknown approval menu. */
export class SessionMessageDelivery {
  private readonly pending = new Map<string, {
    text: string; startedAt: number; cancelled: boolean; confirmed: boolean
  }>()

  constructor(
    private readonly check: (id: string) => MessageTarget,
    private readonly write: (id: string, data: string) => void,
    private readonly delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {}

  busy(id: string): boolean { return this.pending.has(id) }

  interrupt(id: string): void {
    const pending = this.pending.get(id)
    if (pending) pending.cancelled = true
  }

  observe(id: string, text: string, timestamp: number): void {
    const pending = this.pending.get(id)
    if (pending && !pending.cancelled && timestamp >= pending.startedAt && text.trim() === pending.text) {
      pending.confirmed = true
    }
  }

  async send(id: string, text: string, confirmReceipt = true): Promise<void> {
    if (!text.trim() || text.length > 4000 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('消息应为一行且不超过 4000 字符，不能包含控制字符')
    if (this.pending.has(id)) throw new Error('该 Agent 正在提交消息，请稍后重试')
    const target = this.check(id)
    const pending = { text: text.trim(), startedAt: Date.now(), cancelled: false, confirmed: false }
    const validate = () => {
      const current = this.check(id)
      if (pending.cancelled || current.generation !== target.generation || current.nativeSessionId !== target.nativeSessionId) {
        throw new Error('发送期间会话或本地输入已变化，已取消后续提交，请检查终端')
      }
    }
    this.pending.set(id, pending)
    try {
      // Delimit paste explicitly, then allow the TUI paste debounce to settle.
      this.write(id, '\x1b[200~' + pending.text + '\x1b[201~')
      await this.delay(600)
      validate()
      this.write(id, '\r')
      // Recovery sends once; no transcript waiter, polling or Enter retry.
      if (!confirmReceipt) return
      for (let elapsed = 0; elapsed < 12000; elapsed += 100) {
        if (pending.confirmed && !pending.cancelled) return
        validate()
        await this.delay(100)
      }
      throw new Error('已尝试提交，但未确认 Agent 接收；请查看终端。为避免重复消息或误批授权，不会自动补按回车')
    } finally {
      this.pending.delete(id)
    }
  }
}
