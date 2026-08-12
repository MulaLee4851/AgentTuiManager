import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { TerminalStateReplay } from '../../electron/terminal-state-replay'

function parse(data: string, cols = 20, rows = 4): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 100, convertEol: true })
  return new Promise((resolve) => terminal.write(data, () => resolve(terminal)))
}

describe('TerminalStateReplay', () => {
  it('answers cursor position probes without waiting for a renderer', async () => {
    const responses: string[] = []
    const replay = new TerminalStateReplay(20, 4, 100, (data) => responses.push(data))

    replay.append('\x1b[6n')
    await replay.snapshot()

    expect(responses).toEqual(['\x1b[1;1R'])
    replay.dispose()
  })

  it('serializes parsed scrollback instead of repeated raw redraw traffic', async () => {
    const replay = new TerminalStateReplay(20, 4, 100)
    replay.append('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')
    for (let index = 0; index < 50; index += 1) {
      replay.append(`\x1b[Hworking ${index}\x1b[K\r\nstatus\x1b[K`)
    }

    const snapshot = await replay.snapshot()
    const restored = await parse(snapshot)

    expect(snapshot.length).toBeLessThan(2_000)
    expect(restored.buffer.active.baseY).toBeGreaterThan(0)
    expect(snapshot).toContain('one')
    expect(snapshot).toContain('working 49')
    replay.dispose()
    restored.dispose()
  })
})
