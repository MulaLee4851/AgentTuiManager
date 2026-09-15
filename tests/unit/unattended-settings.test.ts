import { describe, expect, it } from 'vitest'
import { approvalEnterCount, approvalEnterDelay, normalizeUnattendedEndWords, parseUnattendedSettings, selectedRecoveryEndWord } from '../../src/shared/unattended-settings'

describe('unattended end word migration and validation', () => {
  it('retains delay and count across the IPC settings parser', () => {
    const settings = parseUnattendedSettings({ enabled: true, endWord: 'DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 7, approvalEnterCount: 3 })
    expect(settings).toMatchObject({ approvalEnterDelaySeconds: 7, approvalEnterCount: 3 })
    expect(parseUnattendedSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
    expect(approvalEnterCount({})).toBe(1)
    for (const count of [0, -1, 21, 1.5, NaN, Infinity]) expect(() => approvalEnterCount({ approvalEnterCount: count })).toThrow('1～20')
  })
  it('validates optional approval Enter delay without enabling it for old settings', () => {
    expect(approvalEnterDelay({})).toBe(0)
    expect(approvalEnterDelay({ approvalEnterDelaySeconds: 0 })).toBe(0)
    expect(approvalEnterDelay({ approvalEnterDelaySeconds: 5 })).toBe(5)
    for (const seconds of [-1, 61, 0.5, NaN, Infinity]) {
      expect(() => approvalEnterDelay({ approvalEnterDelaySeconds: seconds })).toThrow('0～60')
    }
  })
  it('selects exactly one configured word and defaults old settings to their first word', () => {
    expect(selectedRecoveryEndWord({ endWord: 'OLD' })).toBe('OLD')
    expect(selectedRecoveryEndWord({ endWords: ['A', 'B'] })).toBe('A')
    expect(selectedRecoveryEndWord({ endWords: ['A', 'B'], recoveryEndWord: 'B' })).toBe('B')
    expect(() => selectedRecoveryEndWord({ endWords: ['A', 'B'], recoveryEndWord: 'C' })).toThrow('请选择')
  })
  it('supports legacy single-word settings', () => {
    expect(normalizeUnattendedEndWords({ endWord: ' TASK-DONE ' })).toEqual(['TASK-DONE'])
  })
  it('trims and deduplicates while preferring the new list over a stale legacy word', () => {
    expect(normalizeUnattendedEndWords({ endWord: 'OLD', endWords: [' DONE ', '', '完成', 'DONE'] })).toEqual(['DONE', '完成'])
  })
  it('does not silently reactivate a legacy word when the new list is empty', () => {
    expect(() => normalizeUnattendedEndWords({ endWord: 'OLD', endWords: [] })).toThrow('1～20')
  })
  it.each([['two words'], ['a\nb'], ['x'.repeat(101)], Array.from({ length: 21 }, (_, i) => String(i)),
    Array.from({ length: 11 }, (_, i) => String(i).padEnd(100, 'x'))])('rejects invalid or excessive end words: %j', (...words) => {
    expect(() => normalizeUnattendedEndWords({ endWords: words })).toThrow()
  })
})
