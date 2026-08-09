import { describe, expect, it } from 'vitest'

import { createAgentAdapter } from '../../electron/agent-adapters'

describe('native agent adapters', () => {
  it('requires Codex identity and prompt evidence before reporting ready', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('loading session...').ready).toBe(false)
    expect(adapter.observeOutput('\x1b[2JOpenAI Codex\r\n\r\n›\r\n').ready).toBe(true)
    expect(adapter.recoveryRecipe('codex.cmd', 'native-1')).toEqual({
      executable: 'codex.cmd', args: ['resume', 'native-1'],
    })
  })

  it('does not report ready while Codex is asking for approval', () => {
    const adapter = createAgentAdapter('codex')
    const result = adapter.observeOutput('OpenAI Codex\r\n›\r\n$ git status --short\r\nWould you like to run the following command?')
    expect(result).toEqual({ approvalRequired: true, approvalCommand: 'git status --short', ready: false })
    adapter.acknowledgeUserInput()
    expect(adapter.observeOutput('Would you like to run the following command?').approvalRequired).toBe(false)
  })

  it('recognizes Claude readiness and approval separately', () => {
    const adapter = createAgentAdapter('claude')
    expect(adapter.observeOutput('Claude Code\r\n❯\r\n')).toEqual({ approvalRequired: false, ready: true })
    expect(adapter.observeOutput('Bash command\r\n  Get-Content package.json\r\nAllow this tool use?')).toEqual({ approvalRequired: true, approvalCommand: 'Get-Content package.json', ready: false })
    adapter.acknowledgeUserInput()
    expect(adapter.observeOutput('Claude Code\r\n❯\r\n')).toEqual({ approvalRequired: false, ready: true })
    expect(adapter.recoveryRecipe('claude', 'native-2')).toEqual({
      executable: 'claude', args: ['--resume', 'native-2'],
    })
  })

  it('keeps Pi and generic recovery conservative', () => {
    const adapter = createAgentAdapter('pi')
    expect(adapter.supportsNativeSessions).toBe(false)
    expect(adapter.observeOutput('first output').ready).toBe(true)
    expect(adapter.recoveryRecipe('pi', 'unknown')).toBeUndefined()
  })
})
