import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { TerminalStateReplay, terminalReplayText } from '../../electron/terminal-state-replay'

function parse(data: string, cols = 20, rows = 4): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 100, convertEol: true })
  return new Promise((resolve) => terminal.write(data, () => resolve(terminal)))
}

describe('TerminalStateReplay', () => {
  it('tracks split mouse encoding controls and clears them on disable or hard reset', async () => {
    const replay = new TerminalStateReplay(20, 4, 100)
    try {
      replay.append('\x1b[?10'); replay.append('06h')
      expect(await replay.snapshot()).toContain('\x1b[?1006h')
      replay.append('\x1b[?1006l')
      expect(await replay.snapshot()).not.toContain('\x1b[?1006h')
      replay.append('\x1b[?1016h')
      expect(await replay.snapshot()).toContain('\x1b[?1016h')
      replay.append('\x1bc')
      expect(await replay.snapshot()).not.toContain('\x1b[?1016h')
    } finally { replay.dispose() }
  })
  it('restores fullscreen buffer, mouse reporting, paste mode and the normal buffer on return', async () => {
    const replay = new TerminalStateReplay(20, 4, 100)
    replay.append('normal-history\r\n\x1b[?1049h\x1b[2J\x1b[Hcomposer\x1b[?1002h\x1b[?1006h\x1b[?2004h')
    const snapshot = await replay.snapshot()
    const restored = await parse(snapshot)
    try {
      expect(restored.buffer.active.type).toBe('alternate')
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('composer')
      expect(restored.modes.mouseTrackingMode).toBe('drag')
      expect(restored.modes.bracketedPasteMode).toBe(true)
      expect(snapshot).toContain('\x1b[?1006h')
      await new Promise<void>(resolve => restored.write('\x1b[?1049l', resolve))
      expect(restored.buffer.active.type).toBe('normal')
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('normal-history')
    } finally { replay.dispose(); restored.dispose() }
  })
  it('parses queued old-width output before resizing', async () => {
    const queued = new TerminalStateReplay(20, 4, 100)
    const reference = new TerminalStateReplay(20, 4, 100)
    try {
      const oldFrame = 'abcdefghijklmnopqrstUVWXYZ\r\n\x1b[2;15HOLD'
      queued.append(oldFrame)
      queued.resize(10, 6)
      queued.append('\x1b[3;2HNEW')
      reference.append(oldFrame)
      await reference.snapshot()
      reference.resize(10, 6)
      await reference.snapshot()
      reference.append('\x1b[3;2HNEW')
      expect(await queued.snapshot()).toBe(await reference.snapshot())
    } finally { queued.dispose(); reference.dispose() }
  })

  it('extracts the final screen instead of concatenating redraw traffic', async () => {
    const text = await terminalReplayText('progress 10%\rprogress 20%\r\x1b[2Kdone\r\nold status\x1b[1A\r\x1b[2Kcompleted', 30, 4)
    expect(text).toContain('completed')
    expect(text).not.toContain('progress')
    expect(text).not.toContain('done')
    expect(text).not.toContain('\x1b')
  })

  it('handles screen erasure, alternate buffers and wide-character wrapping', async () => {
    expect(await terminalReplayText('prompt at top', 100, 200)).toBe('prompt at top')
    expect(await terminalReplayText('123456789 next', 10, 4)).toBe('123456789 next')
    expect(await terminalReplayText('obsolete\x1b[2J\x1b[Hcurrent', 20, 4)).toBe('current')
    expect(await terminalReplayText('main\x1b[?1049h\x1b[Happroval', 20, 4)).toBe('approval')
    expect(await terminalReplayText('中文测试abcdefgh', 10, 4)).toBe('中文测试abcdefgh')
  })
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
