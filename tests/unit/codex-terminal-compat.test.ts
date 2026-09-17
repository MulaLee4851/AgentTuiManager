import { describe, expect, it } from 'vitest'
import { codexTerminalCompatibilityArgs } from '../../electron/codex-terminal-compat'
import { applyAgentLaunchProfile } from '../../electron/agent-launch-profile'

describe('Manager Codex decorative effect compatibility', () => {
  it.each([
    { args: [], expected: ['-c', 'tui.whimsy=false'] },
    { args: ['resume', 'native-id'], expected: ['-c', 'tui.whimsy=false', 'resume', 'native-id'] },
    { args: ['resume', '--last'], expected: ['-c', 'tui.whimsy=false', 'resume', '--last'] },
    { args: ['--profile', 'work', 'resume', 'native-id'], expected: ['--profile', 'work', '-c', 'tui.whimsy=false', 'resume', 'native-id'] },
  ])('disables whimsy in root options for $args', ({ args, expected }) => {
    expect(codexTerminalCompatibilityArgs(args)).toEqual(expected)
  })
  it('overrides an earlier setting while preserving animations, hooks and bypass flags', () => {
    const args = ['-c', 'tui.whimsy=true', '-c', 'tui.animations=true', '--enable', 'hooks', '--dangerously-bypass-approvals-and-sandbox']
    expect(codexTerminalCompatibilityArgs(args)).toEqual([...args, '-c', 'tui.whimsy=false'])
    expect(args).toHaveLength(7)
  })
  it('inserts before positional delimiter without changing the user prompt', () => {
    expect(codexTerminalCompatibilityArgs(['resume', 'id', '--', 'my task'])).toEqual(['-c', 'tui.whimsy=false', 'resume', 'id', '--', 'my task'])
  })
  it('does not interpret a prompt after -- as a resume subcommand', () => {
    expect(codexTerminalCompatibilityArgs(['--', 'resume'])).toEqual(['-c', 'tui.whimsy=false', '--', 'resume'])
  })
  it('keeps independent provider and hook overrides in the same root scope when resuming', () => {
    const configured = applyAgentLaunchProfile('codex', ['resume', 'native-id'], {
      profileId: 'test-profile', source: 'custom', baseUrl: 'https://gateway.example/v1',
      apiKey: 'test-key', extraArgs: [],
    }, { id: 'custom', configurable: true })
    const args = ['-c', 'hooks.PermissionRequest=[]', ...configured.args]
    const original = [...args]
    const result = codexTerminalCompatibilityArgs(args)
    const root = result.slice(0, result.indexOf('resume'))
    expect(root).toContain('model_provider=custom')
    expect(root).toContain('model_providers.custom.base_url=https://gateway.example/v1')
    expect(root).toContain('hooks.PermissionRequest=[]')
    expect(root.slice(-2)).toEqual(['-c', 'tui.whimsy=false'])
    expect(result.slice(result.indexOf('resume'))).toEqual(['resume', 'native-id'])
    expect(args).toEqual(original)
    expect(result.join(' ')).not.toContain('test-key')
  })
})
