import { describe, expect, it } from 'vitest'

import { environmentForAgent } from '../../electron/agent-environment'

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
    expect(environmentForAgent('codex', { CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me' }))
      .toEqual({ CODEX_API_KEY: 'user-key', USERPROFILE: 'C:\\Users\\me' })
  })

  it('enables Claude inline scrollback without changing other inherited settings', () => {
    const source = { CODEX_API_KEY: 'unrelated', CODEX_THREAD_ID: 'parent' }
    expect(environmentForAgent('claude', source))
      .toEqual({ ...source, CLAUDE_CODE_NO_FLICKER: '0' })
    expect(environmentForAgent('claude', { CLAUDE_CODE_NO_FLICKER: '1', ANTHROPIC_BASE_URL: 'https://gateway.example' }))
      .toEqual({ CLAUDE_CODE_NO_FLICKER: '0', ANTHROPIC_BASE_URL: 'https://gateway.example' })
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
})
