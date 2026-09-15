// Tracks input framing, not terminal output. No transcript or draft text is retained.
export class TerminalInputState {
  pending = false
  updatedAt?: number
  private paste = false
  private escape = ''
  private stringControl = false
  private stringEscape = false

  reset(): void {
    this.pending = false
    this.updatedAt = undefined
    this.paste = false
    this.escape = ''
    this.stringControl = false
    this.stringEscape = false
  }

  observe(data: string, now: number): boolean {
    let submitted = false
    for (const char of data) {
      if (this.stringControl) {
        if (char === '\x07' || (this.stringEscape && char === '\\')) this.stringControl = false
        this.stringEscape = char === '\x1b'
        continue
      }
      if (this.escape) {
        if (this.escape === '\x1b' && /[\]P_^X]/.test(char)) {
          this.stringControl = true
          this.stringEscape = false
          this.escape = ''
          continue
        }
        // A lone Escape may be followed by ordinary typing (or an Alt key).
        // Do not lose that first draft character while completing framing.
        if (this.escape === '\x1b' && char !== '[' && char >= ' ' && char !== '\x7f') {
          this.pending = true
          this.updatedAt = now
        }
        this.escape += char
        if (this.escape.startsWith('\x1b[') && this.escape.length > 2 && /[@-~]/.test(char)) {
          if (this.escape === '\x1b[200~') this.paste = true
          if (this.escape === '\x1b[201~') this.paste = false
          this.escape = ''
        } else if (this.escape.length >= 64 || (this.escape.length === 2 && char !== '[')) this.escape = ''
        continue
      }
      if (char === '\x1b') { this.escape = char; continue }
      if (!this.paste && /[\r\n]/.test(char)) {
        submitted = submitted || this.pending
        this.pending = false
      } else if (char >= ' ' && char !== '\x7f') {
        this.pending = true
        this.updatedAt = now
      }
    }
    return submitted
  }
}
