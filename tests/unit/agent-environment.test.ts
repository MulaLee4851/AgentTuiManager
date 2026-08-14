import { describe, expect, it } from 'vitest'

import { applyManagedTerminalEnvironment, environmentForAgent, MANAGED_TERMINAL_ENV } from '../../electron/agent-environment'

describe('environmentForAgent', () => {
  it('removes parent Codex credentials and orchestration state while preserving user config discovery', () => {
    const result = environmentForAgent('codex', {
      USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'D:\\my-codex', DASHSCOPE_API_KEY: 'user-provider-key',
      CODEX_API_KEY: 'parent-key', OPENAI_API_KEY: 'parent-openai-key', CODEX_THREAD_ID: 'parent-thread',
      CODEX_PERMISSION_PROFILE: 'parent-profile', PATH: 'C:\\bin',
    })
    expect(result).toMatchObject({
      USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'D:\\my-codex', DASHSCOPE_API_KEY: 'user-provider-key', PATH: 'C:\\bin',
      ...MANAGED_TERMINAL_ENV,
    })
    expect(result).not.toHaveProperty('CODEX_API_KEY')
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('CODEX_THREAD_ID')
    expect(result).not.toHaveProperty('CODEX_PERMISSION_PROFILE')
  })

  it('keeps normal user credentials when Manager was not launched by a parent Codex', () => {
    expect(environmentForAgent('codex', { CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me' }))
      .toEqual({ CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me', ...MANAGED_TERMINAL_ENV })
  })

  it('enables Claude inline scrollback without changing other inherited settings', () => {
    const source = { CODEX_API_KEY: 'unrelated', CODEX_THREAD_ID: 'parent' }
    expect(environmentForAgent('claude', source))
      .toEqual({ ...source, CLAUDE_CODE_NO_FLICKER: '0', ...MANAGED_TERMINAL_ENV })
    expect(environmentForAgent('claude', { CLAUDE_CODE_NO_FLICKER: '1', ANTHROPIC_BASE_URL: 'https://gateway.example' }))
      .toEqual({ CLAUDE_CODE_NO_FLICKER: '0', ANTHROPIC_BASE_URL: 'https://gateway.example', ...MANAGED_TERMINAL_ENV })
    expect(environmentForAgent('generic', source)).toEqual({ ...source, ...MANAGED_TERMINAL_ENV })
  })

  it('refreshes PATH only for Pi and leaves Codex and Claude untouched', () => {
    const source = { Path: 'C:\\old-bin;C:\\shared', USERPROFILE: 'C:\\Users\\me' }
    const options = {
      platform: 'win32' as const,
      registryPaths: ['%USERPROFILE%\\new-bin;C:\\shared', 'D:\\machine-bin'],
    }
    expect(environmentForAgent('pi', source, options).Path)
      .toBe('C:\\old-bin;C:\\shared;C:\\Users\\me\\new-bin;D:\\machine-bin')
    expect(environmentForAgent('codex', source, options).Path).toBe(source.Path)
    expect(environmentForAgent('claude', source, options).Path).toBe(source.Path)
  })

  it('gives a packaged Explorer launch the same dark xterm capability as a WT-hosted start.cmd', () => {
    const result = environmentForAgent('claude', {
      USERPROFILE: 'C:\\Users\\me',
      Path: 'C:\\bin',
    })
    expect(result).toMatchObject(MANAGED_TERMINAL_ENV)
    expect(result).not.toHaveProperty('WT_SESSION')
    expect(result).not.toHaveProperty('TERM_PROGRAM')
    expect(result.COLORFGBG).toBe('15;0')
  })

  it('strips Electron host leaks and color-disable flags that a GUI EXE otherwise inherits', () => {
    const result = environmentForAgent('codex', {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NO_COLOR: '1',
      NODE_DISABLE_COLORS: '1',
      USERPROFILE: 'C:\\Users\\me',
    })
    expect(result).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(result).not.toHaveProperty('ELECTRON_NO_ASAR')
    expect(result).not.toHaveProperty('ELECTRON_NO_ATTACH_CONSOLE')
    expect(result).not.toHaveProperty('NO_COLOR')
    expect(result).not.toHaveProperty('NODE_DISABLE_COLORS')
    expect(result).toMatchObject(MANAGED_TERMINAL_ENV)
  })

  it('overwrites a light-conhost COLORFGBG and a dumb TERM without inventing a WT identity', () => {
    const result = applyManagedTerminalEnvironment({
      TERM: 'dumb',
      colorfgbg: '0;15',
      WT_SESSION: 'real-session-from-windows-terminal',
      TERM_PROGRAM: 'WindowsTerminal',
    })
    expect(result.TERM).toBe('xterm-256color')
    expect(result.COLORFGBG).toBe('15;0')
    expect(result).not.toHaveProperty('colorfgbg')
    expect(result.WT_SESSION).toBe('real-session-from-windows-terminal')
    expect(result.TERM_PROGRAM).toBe('WindowsTerminal')
  })
})
