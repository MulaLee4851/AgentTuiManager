import { describe, expect, it } from 'vitest'
import { TerminalInputState } from '../../electron/terminal-input-state'

describe('terminal input framing', () => {
  it('recognizes paste and submit in one batch', () => {
    const input = new TerminalInputState()
    expect(input.observe('\x1b[200~continue\nnext\x1b[201~\r', 1)).toBe(true)
    expect(input.pending).toBe(false)
  })
  it('preserves multiline paste until an external submit', () => {
    const input = new TerminalInputState()
    expect(input.observe('\x1b[200~hello\nworld\x1b[201~', 1)).toBe(false)
    expect(input.pending).toBe(true)
    expect(input.observe('\r', 2)).toBe(true)
    expect(input.pending).toBe(false)
  })
  it('handles framing split at every possible boundary', () => {
    const data = '\x1b[200~continue\x1b[201~\r'
    for (let i = 1; i < data.length; i++) {
      const input = new TerminalInputState()
      input.observe(data.slice(0, i), 1)
      input.observe(data.slice(i), 2)
      expect(input.pending).toBe(false)
    }
  })
  it.each(['\x1b]4;0;rgb:ffff/ffff/ffff\x1b\\', '\x1bP1$r0m\x1b\\',
    '\x1b[?1;2c', '\x1b[12;30R', '\x1b[I', '\x1b[O', '\x1b[C', '\x1b[D'])('ignores fragmented protocol/navigation %j', data => {
    const input = new TerminalInputState()
    for (const char of data) input.observe(char, 1)
    expect(input.pending).toBe(false)
    input.observe('draft', 2)
    expect(input.pending).toBe(true)
  })
  it('does not clear a new draft following a submission', () => {
    const input = new TerminalInputState()
    input.observe('first\rsecond', 1)
    expect(input.pending).toBe(true)
  })
  it('protects the first character typed after Escape', () => {
    const input = new TerminalInputState()
    input.observe('\x1b', 1)
    input.observe('x', 2)
    expect(input.pending).toBe(true)
  })
  it('resets framing for a restarted process', () => {
    const input = new TerminalInputState()
    input.observe('\x1b[200~draft', 1)
    input.reset()
    input.observe('new\r', 2)
    expect(input.pending).toBe(false)
  })
})
