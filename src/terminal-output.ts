// xterm yields between writes once its parsing time budget is spent, but cannot
// yield in the middle of one large write. Queue bounded chunks synchronously so
// its own ordered parser can yield without interleaving newer PTY output.
export const TERMINAL_OUTPUT_CHUNK_SIZE = 128 * 1024

export function writeTerminalOutput(
  terminal: { write(data: string, callback?: () => void): void },
  data: string,
  complete: () => void,
  progress?: () => void,
): void {
  if (!data.length) { terminal.write(data, complete); return }
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(data.length, offset + TERMINAL_OUTPUT_CHUNK_SIZE)
    // Keep a surrogate pair together. CSI/OSC parser state intentionally spans
    // writes; never insert/reset terminal escape sequences at these boundaries.
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!) && /[\uDC00-\uDFFF]/.test(data[end]!)) end--
    terminal.write(data.slice(offset, end), end === data.length ? complete : progress)
    offset = end
  }
}
