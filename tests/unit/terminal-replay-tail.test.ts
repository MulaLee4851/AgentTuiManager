import { expect, it } from 'vitest'
import { TerminalReplayBuffer } from '../../electron/terminal-replay-buffer'

it('reads a bounded tail across chunks without changing full scrollback', () => {
  const buffer = new TerminalReplayBuffer(100)
  buffer.append('abc')
  buffer.append('defgh')
  expect(buffer.tail(4)).toBe('efgh')
  expect(buffer.tail(7)).toBe('bcdefgh')
  expect(buffer.tail(20)).toBe('abcdefgh')
  expect(buffer.tail(0)).toBe('')
  expect(buffer.snapshot()).toBe('abcdefgh')
  buffer.append('x'.repeat(100))
  expect(buffer.tail(8)).toBe('xxxxxxxx')
  expect(buffer.snapshot()).toHaveLength(100)
})
