import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_OUTPUT_CHUNK_SIZE, writeTerminalOutput } from '../../src/terminal-output'

describe('bounded terminal output', () => {
  it('queues a complete ordered batch with one final completion before accepting later data', () => {
    const write = vi.fn()
    const complete = vi.fn()
    const data = 'a'.repeat(TERMINAL_OUTPUT_CHUNK_SIZE - 1) + '😀中文' + 'b'.repeat(TERMINAL_OUTPUT_CHUNK_SIZE * 2)
    writeTerminalOutput({ write }, data, complete)
    const chunks = write.mock.calls.map(call => call[0] as string)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(data)
    expect(chunks.every(chunk => chunk.length <= TERMINAL_OUTPUT_CHUNK_SIZE && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
    expect(write.mock.calls.slice(0, -1).every(call => call[1] === undefined)).toBe(true)
    expect(write.mock.lastCall?.[1]).toBe(complete)
    expect(complete).not.toHaveBeenCalled()
  })

  it.each(['\x1b[31mRED\x1b[0m', '\x1b]0;title\x07', '\r\n中文😀', '\x1b[?1049hALT\x1b[?1049l', '\x1b[6n'])
    ('preserves actual xterm state and protocol responses across a split %j', async suffix => {
      const data = 'x'.repeat(TERMINAL_OUTPUT_CHUNK_SIZE - 1) + suffix + '\r\nlatest'
      const baseline = new Terminal({ cols: 80, rows: 24, scrollback: 2000, convertEol: true })
      const chunked = new Terminal({ cols: 80, rows: 24, scrollback: 2000, convertEol: true })
      const originalSerializer = new SerializeAddon(), chunkedSerializer = new SerializeAddon()
      baseline.loadAddon(originalSerializer); chunked.loadAddon(chunkedSerializer)
      const originalResponses: string[] = [], chunkedResponses: string[] = []
      baseline.onData(value => originalResponses.push(value)); chunked.onData(value => chunkedResponses.push(value))
      try {
        await new Promise<void>(resolve => baseline.write(data + '\r\nAFTER', resolve))
        const complete = vi.fn()
        writeTerminalOutput(chunked, data, complete)
        await new Promise<void>(resolve => chunked.write('\r\nAFTER', resolve))
        expect(complete).toHaveBeenCalledTimes(1)
        expect(chunkedSerializer.serialize()).toBe(originalSerializer.serialize())
        expect(chunkedResponses).toEqual(originalResponses)
      } finally { baseline.dispose(); chunked.dispose() }
    })
})
