import { describe, expect, it } from 'vitest'

import { canonicalNativeRecovery, terminalScrollbackArgs, validateExecutable } from '../../electron/start-request-policy'

describe('start request policy', () => {
  it('binds bare built-in commands to their agent kind and removes node', () => {
    expect(validateExecutable('codex', 'codex.cmd', '')).toBe('codex.cmd')
    expect(validateExecutable('claude', 'claude.exe', '')).toBe('claude.exe')
    expect(validateExecutable('pi', 'pi', '')).toBe('pi')
    expect(validateExecutable('generic', 'cmd.exe', '')).toBe('cmd.exe')
    expect(validateExecutable('generic', 'pwsh.exe', '')).toBe('pwsh.exe')
    expect(() => validateExecutable('codex', 'claude.cmd', '')).toThrow(/allowed/i)
    expect(() => validateExecutable('generic', 'node.exe', '')).toThrow(/allowed/i)
    expect(() => validateExecutable('codex', 'C:\\tools\\codex.exe', '')).toThrow(/allowed/i)
  })

  it('allows only an exactly configured normalized absolute executable path', () => {
    expect(validateExecutable('codex', 'C:\\Tools\\agent-wrapper.exe', 'c:\\tools\\agent-wrapper.exe')).toBe('C:\\Tools\\agent-wrapper.exe')
    expect(() => validateExecutable('codex', 'C:\\Other\\agent-wrapper.exe', 'c:\\tools\\agent-wrapper.exe')).toThrow(/allowed/i)
    expect(() => validateExecutable('codex', 'agent-wrapper.exe', 'agent-wrapper.exe')).toThrow(/allowed/i)
  })

  it('accepts only exact native resume arguments and rebuilds recovery from the start executable', () => {
    expect(canonicalNativeRecovery('codex', 'native-1', 'codex', ['--no-alt-screen', 'resume', 'native-1'], {
      executable: 'codex', args: ['--no-alt-screen', 'resume', 'native-1'],
    })).toEqual({ executable: 'codex', args: ['--no-alt-screen', 'resume', 'native-1'] })
    expect(() => canonicalNativeRecovery('codex', 'native-1', 'codex', ['--no-alt-screen', 'resume', 'native-1', '--extra'], {
      executable: 'codex', args: ['--no-alt-screen', 'resume', 'native-1'],
    })).toThrow(/resume/i)
    expect(() => canonicalNativeRecovery('claude', 'native-1', 'claude', ['--resume', 'native-1'], {
      executable: 'pwsh.exe', args: ['--resume', 'native-1'],
    })).toThrow(/resume/i)
  })

  it('adds Codex inline scrollback once and leaves other agents unchanged', () => {
    expect(terminalScrollbackArgs('codex', ['resume', 'native-1'])).toEqual(['--no-alt-screen', 'resume', 'native-1'])
    expect(terminalScrollbackArgs('codex', ['--no-alt-screen'])).toEqual(['--no-alt-screen'])
    expect(terminalScrollbackArgs('claude', ['--resume', 'native-2'])).toEqual(['--resume', 'native-2'])
  })
})
