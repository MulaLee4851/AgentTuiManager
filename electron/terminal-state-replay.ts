import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'

const DEFAULT_SCROLLBACK_LINES = 10_000

export class TerminalStateReplay {
  private readonly terminal: Terminal
  private readonly serializer = new SerializeAddon()
  private readonly responseSubscription?: { dispose(): void }

  constructor(cols: number, rows: number, scrollback = DEFAULT_SCROLLBACK_LINES, onResponse?: (data: string) => void) {
    this.terminal = new Terminal({ cols, rows, scrollback, convertEol: true })
    this.terminal.loadAddon(this.serializer)
    if (onResponse) this.responseSubscription = this.terminal.onData(onResponse)
  }

  append(data: string): void {
    if (data) this.terminal.write(data)
  }

  resize(cols: number, rows: number): void {
    // PTY output is parsed asynchronously. Preserve its order relative to resize:
    // old-width output must not be interpreted using the new column count.
    this.terminal.write('', () => this.terminal.resize(cols, rows))
  }

  snapshot(): Promise<string> {
    return new Promise((resolve) => {
      // An empty write callback runs after all previously queued PTY output has been parsed.
      this.terminal.write('', () => resolve(this.serializer.serialize()))
    })
  }

  textSnapshot(maxLines = 80, maxCharacters = 3_500): Promise<string> {
    return new Promise((resolve, reject) => {
      this.terminal.write('', () => {
        try {
          const buffer = this.terminal.buffer.active
          const lines: string[] = []
          let end = buffer.length
          while (end > 0 && !buffer.getLine(end - 1)?.translateToString(true)) end--
          const start = Math.max(0, end - maxLines)
          for (let index = start; index < end; index++) {
            const line = buffer.getLine(index)
            if (!line) continue
            const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped)
            if (line.isWrapped && lines.length) lines[lines.length - 1] += text
            else lines.push(text)
          }
          resolve(lines.join('\n').trimEnd().slice(-maxCharacters))
        } catch (error) { reject(error) }
      })
    })
  }

  dispose(): void {
    this.responseSubscription?.dispose()
    this.terminal.dispose()
  }
}

// Only used on an explicit remote read. No extra persistent terminal, timer or
// output listener is created, and the temporary scrollback has a small ceiling.
export async function terminalReplayText(data: string, cols = 100, rows = 30): Promise<string> {
  const replay = new TerminalStateReplay(cols, rows, 200)
  try {
    replay.append(data)
    return await replay.textSnapshot()
  } finally {
    replay.dispose()
  }
}
