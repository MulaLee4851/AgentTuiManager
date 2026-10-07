import { createHash } from 'node:crypto'

/** Fallback for an interactive question menu before native session capture. */
export class TerminalQuestionSignal {
  private tail = ''
  private last?: string
  private generation = 0
  current?: string

  observe(data: string): string | undefined {
    const clear = data.lastIndexOf('\x1b[2J')
    if (clear >= 0) { this.tail = ''; this.current = undefined }
    this.tail = (this.tail + (clear >= 0 ? data.slice(clear + 4) : data)).slice(-16384)
    const text = this.tail.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[ABCEFGHJKSTf]/g, '\n')
      .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '').replace(/\r/g, '\n')
    const start = [...text.matchAll(/(?:^|\n)\s*(?:[●•]?\s*AskUserQuestion\b|Questions?\s+(?:\d|\d+\/\d+)|问题\s*\d)/gi)].at(-1)
    if (!start) {
      if (clear >= 0) this.last = undefined
      return undefined
    }
    const prompt = text.slice(start.index).trim()
    const footer = /(?:enter\s+to\s+(?:select|submit|confirm)|tab\s+to\s+(?:navigate|switch)|type\s+(?:your|an)\s+answer|按.{0,6}回车)/i.exec(prompt)
    if (!footer) {
      // A clear and its menu can arrive in separate output chunks. Re-emit the
      // completed frame so a ticket invalidated during that gap can be queued
      // again. AttentionSound still deduplicates a menu already heard/viewed.
      if (clear >= 0) this.last = undefined
      return undefined
    }
    // Cursor motion and whitespace-only redraws are the same menu.
    const normalized = prompt.slice(0, footer.index).replace(/[❯►▸]/g, '').replace(/\s+/g, ' ').trim()
    const token = this.generation + ':' + createHash('sha256').update(normalized).digest('hex').slice(0, 24)
    this.current = token
    if (token === this.last) return undefined
    this.last = token
    return token
  }

  reset(): void { this.tail = ''; this.last = undefined; this.current = undefined; this.generation += 1 }
}
