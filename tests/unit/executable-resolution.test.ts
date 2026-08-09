import { describe, expect, it, vi } from 'vitest'

import { resolveExecutableForPty } from '../../electron/executable-resolution'

describe('resolveExecutableForPty', () => {
  it('resolves a bare npm command to the complete cmd shim path on Windows', () => {
    const isFile = vi.fn((path: string) => path.toLocaleLowerCase('en-US') === 'd:\\node-global\\codex.cmd')
    expect(resolveExecutableForPty('codex', {
      platform: 'win32', path: 'C:\\Windows\\System32;D:\\node-global', pathExt: '.EXE;.CMD', isFile,
    })).toBe('D:\\node-global\\codex.CMD')
  })

  it('keeps configured absolute paths and non-Windows commands unchanged', () => {
    expect(resolveExecutableForPty('C:\\Tools\\agent.exe', { platform: 'win32' })).toBe('C:\\Tools\\agent.exe')
    expect(resolveExecutableForPty('codex', { platform: 'linux' })).toBe('codex')
  })

  it('fails with the missing command name instead of an empty node-pty error', () => {
    expect(() => resolveExecutableForPty('missing-agent', {
      platform: 'win32', path: 'C:\\bin', pathExt: '.EXE;.CMD', isFile: () => false,
    })).toThrow('Executable not found in PATH: missing-agent')
  })
})
