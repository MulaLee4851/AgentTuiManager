import { describe, expect, it } from 'vitest'

import { TerminalReplayBuffer } from '../../electron/terminal-replay-buffer'

describe('TerminalReplayBuffer', () => {
  it('bounds the default replay retained for each xterm renderer', () => {
    const replay = new TerminalReplayBuffer()
    replay.append('x'.repeat(600 * 1024))

    expect(replay.length).toBe(512 * 1024)
  })

  it('keeps bounded output across many small appends', () => {
    const replay = new TerminalReplayBuffer(8)
    replay.append('abcd')
    replay.append('efgh')
    replay.append('ijkl')

    expect(replay.snapshot()).toBe('efghijkl')
    expect(replay.length).toBe(8)
  })

  it('keeps output from the previous clear-scrollback checkpoint', () => {
    const replay = new TerminalReplayBuffer(1_000)
    replay.append('old\x1b[3Jscreen-one')
    replay.append('\x1b[0')
    replay.append('3Jscreen-two')
    replay.append('\x1b[3Jscreen-three')

    expect(replay.snapshot()).toBe('\x1b[03Jscreen-two\x1b[3Jscreen-three')
  })

  it('clears all buffered output', () => {
    const replay = new TerminalReplayBuffer()
    replay.append('output')
    replay.clear()

    expect(replay.snapshot()).toBe('')
    expect(replay.length).toBe(0)
  })
})
