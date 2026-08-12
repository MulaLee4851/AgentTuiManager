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
    this.terminal.resize(cols, rows)
  }

  snapshot(): Promise<string> {
    return new Promise((resolve) => {
      // An empty write callback runs after all previously queued PTY output has been parsed.
      this.terminal.write('', () => resolve(this.serializer.serialize()))
    })
  }

  dispose(): void {
    this.responseSubscription?.dispose()
    this.terminal.dispose()
  }
}
