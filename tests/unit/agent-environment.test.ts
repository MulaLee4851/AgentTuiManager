import { describe, expect, it } from 'vitest'

import { environmentForAgent, MANAGED_TERMINAL_CAPABILITIES } from '../../electron/agent-environment'

describe('environmentForAgent', () => {
  it('removes parent Codex credentials and orchestration state while preserving user config discovery', () => {
    const result = environmentForAgent('codex', {
      USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'D:\\my-codex', DASHSCOPE_API_KEY: 'user-provider-key',
      CODEX_API_KEY: 'parent-key', OPENAI_API_KEY: 'parent-openai-key', CODEX_THREAD_ID: 'parent-thread',
      CODEX_PERMISSION_PROFILE: 'parent-profile', PATH: 'C:\\bin',
    })
    expect(result).toMatchObject({
      USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'D:\\my-codex', DASHSCOPE_API_KEY: 'user-provider-key', PATH: 'C:\\bin',
    })
    expect(result).not.toHaveProperty('CODEX_API_KEY')
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('CODEX_THREAD_ID')
    expect(result).not.toHaveProperty('CODEX_PERMISSION_PROFILE')
  })

  it('keeps normal user credentials when Manager was not launched by a parent Codex', () => {
    expect(environmentForAgent('codex', { CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me', WT_SESSION: 'dev-wt' }))
      .toEqual({ CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me', WT_SESSION: 'dev-wt' })
  })

  it('enables Claude inline scrollback without changing other inherited settings', () => {
    const source = { CODEX_API_KEY: 'unrelated', CODEX_THREAD_ID: 'parent', WT_SESSION: 'dev-wt' }
    expect(environmentForAgent('claude', source))
      .toEqual({ ...source, CLAUDE_CODE_NO_FLICKER: '0' })
    expect(environmentForAgent('claude', { CLAUDE_CODE_NO_FLICKER: '1', ANTHROPIC_BASE_URL: 'https://gateway.example', WT_SESSION: 'dev-wt' }))
      .toEqual({ CLAUDE_CODE_NO_FLICKER: '0', ANTHROPIC_BASE_URL: 'https://gateway.example', WT_SESSION: 'dev-wt' })
    expect(environmentForAgent('generic', source)).toEqual(source)
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

  it('fills terminal capabilities for packaged Explorer launches without inventing WT identity', () => {
    const result = environmentForAgent('claude', {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      USERPROFILE: 'C:\\Users\\me',
    })
    expect(result).toMatchObject({
      ...MANAGED_TERMINAL_CAPABILITIES,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      USERPROFILE: 'C:\\Users\\me',
      CLAUDE_CODE_NO_FLICKER: '0',
    })
    expect(result.TERM_PROGRAM).toBe('vscode')
    expect(result.TERM_PROGRAM_VERSION).toBe('1.110.0')
    expect(result).not.toHaveProperty('WT_SESSION')
    expect(result).not.toHaveProperty('FORCE_COLOR')
    expect(result).not.toHaveProperty('CLICOLOR_FORCE')
    expect(result).not.toHaveProperty('MSYSTEM')
  })

  it('does not override an already-set TERM and never strips Electron-as-node', () => {
    const result = environmentForAgent('generic', {
      TERM: 'xterm-256color',
      ELECTRON_RUN_AS_NODE: '1',
      USERPROFILE: 'C:\\Users\\me',
    })
    expect(result.TERM).toBe('xterm-256color')
    expect(result.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(result.COLORTERM).toBe(MANAGED_TERMINAL_CAPABILITIES.COLORTERM)
    expect(result.COLORFGBG).toBe(MANAGED_TERMINAL_CAPABILITIES.COLORFGBG)
  })

  it('strips color-disable flags that would force a monochrome TUI', () => {
    const result = environmentForAgent('codex', {
      NO_COLOR: '1',
      NODE_DISABLE_COLORS: '1',
      USERPROFILE: 'C:\\Users\\me',
    })
    expect(result).not.toHaveProperty('NO_COLOR')
    expect(result).not.toHaveProperty('NODE_DISABLE_COLORS')
    expect(result).toMatchObject(MANAGED_TERMINAL_CAPABILITIES)
  })
})
