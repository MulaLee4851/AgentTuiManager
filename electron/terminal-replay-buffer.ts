// The renderer keeps 10,000 lines of xterm scrollback, but this buffer bounds raw PTY
// bytes, and heavily styled agent output costs far more per line than plain text: a
// measured 6,000 message Claude Code session is ~772 KiB of ANSI. At the previous 512 KiB
// the renderer was handed only the tail of a long session — roughly the last 2,000 of
// those 6,000 messages — so reconnecting or remounting silently dropped older history.
// 4 MiB comfortably covers the scrollback the renderer can actually display.
const DEFAULT_MAX_CHARACTERS = 4 * 1024 * 1024
const CHECKPOINTS = ['\x1b[3J', '\x1b[03J'] as const
const CHECKPOINT_OVERLAP = Math.max(...CHECKPOINTS.map((value) => value.length)) - 1

export class TerminalReplayBuffer {
  private chunks: string[] = []
  private head = 0
  private startOffset = 0
  private endOffset = 0
  private checkpoints: number[] = []
  private scanTail = ''

  constructor(private readonly maxCharacters = DEFAULT_MAX_CHARACTERS) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
      throw new Error('maxCharacters must be a positive integer')
    }
  }

  append(data: string): void {
    if (!data) return

    const scan = this.scanTail + data
    const scanOffset = this.endOffset - this.scanTail.length
    for (const checkpoint of CHECKPOINTS) {
      let index = scan.indexOf(checkpoint)
      while (index >= 0) {
        const absoluteOffset = scanOffset + index
        if (!this.checkpoints.includes(absoluteOffset)) this.checkpoints.push(absoluteOffset)
        index = scan.indexOf(checkpoint, index + 1)
      }
    }
    this.checkpoints.sort((left, right) => left - right)

    this.chunks.push(data)
    this.endOffset += data.length
    this.scanTail = scan.slice(-CHECKPOINT_OVERLAP)

    const previousCheckpoint = this.checkpoints.at(-2)
    const boundedStart = this.endOffset - this.maxCharacters
    this.trimBefore(Math.max(this.startOffset, boundedStart, previousCheckpoint ?? this.startOffset))
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.startOffset = 0
    this.endOffset = 0
    this.checkpoints = []
    this.scanTail = ''
  }

  snapshot(): string {
    return this.chunks.slice(this.head).join('')
  }

  get length(): number {
    return this.endOffset - this.startOffset
  }

  private trimBefore(targetOffset: number): void {
    let remove = targetOffset - this.startOffset
    while (remove > 0 && this.head < this.chunks.length) {
      const first = this.chunks[this.head]!
      if (remove < first.length) {
        this.chunks[this.head] = first.slice(remove)
        this.startOffset += remove
        remove = 0
      } else {
        this.chunks[this.head] = ''
        this.head += 1
        this.startOffset += first.length
        remove -= first.length
      }
    }
    if (this.head >= 8_192 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
    this.checkpoints = this.checkpoints.filter((offset) => offset >= this.startOffset).slice(-2)
  }
}
