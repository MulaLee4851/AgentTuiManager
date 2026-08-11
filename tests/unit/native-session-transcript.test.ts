import { describe, expect, it } from 'vitest'

import { formatTranscript, type TranscriptEntry } from '../../electron/native-session-transcript'

describe('native session transcript display', () => {
  it('keeps the latest agent message so history never silently loses content', () => {
    const entries: TranscriptEntry[] = [
      { role: 'user', text: 'inspect the project' },
      { role: 'agent', text: 'current live answer' },
    ]

    expect(formatTranscript(entries, 'codex')).toEqual({
      entries: [
        { role: 'user', text: 'inspect the project', title: '你' },
        { role: 'agent', text: 'current live answer', title: 'Codex' },
      ],
      truncated: false,
    })
  })

  it('folds history only at complete message boundaries', () => {
    const entries: TranscriptEntry[] = [
      { role: 'user', text: `old-${'a'.repeat(100_000)}` },
      { role: 'agent', text: `answer-${'b'.repeat(100_000)}` },
      { role: 'user', text: 'latest request' },
    ]

    const output = formatTranscript(entries, 'codex')
    expect(output.truncated).toBe(true)
    expect(output.entries[0]).toMatchObject({ role: 'agent', title: 'Codex' })
    expect(output.entries.at(-1)).toEqual({ role: 'user', text: 'latest request', title: '你' })
    expect(output.entries.some((entry) => entry.text.includes('old-'))).toBe(false)
  })

  it('keeps tool names separate from their complete arguments and results', () => {
    const output = formatTranscript([
      { role: 'tool', title: '工具调用 · Read', text: '{\n  file_path: README.md\n}' },
      { role: 'tool_result', title: '工具结果', text: 'file contents' },
    ], 'claude')

    expect(output.entries).toEqual([
      { role: 'tool', title: '工具调用 · Read', text: '{\n  file_path: README.md\n}' },
      { role: 'tool_result', title: '工具结果', text: 'file contents' },
    ])
  })
})
