import { describe, expect, it } from 'vitest'
import { codexTerminalModeArgs } from '../../electron/codex-terminal-mode'
import { initialPromptArgs } from '../../electron/session-continuation'

const native = (args: string[]): string[] => codexTerminalModeArgs(args, 'native-fullscreen')
const overrides = ['-c', 'tui.alternate_screen="always"', '-c', 'tui.fullscreen_transcript=true']
describe('Codex terminal mode at launch', () => {
  it('keeps the legacy default and is idempotent', () => {
    expect(codexTerminalModeArgs(['resume', 'id'])).toEqual(['--no-alt-screen', 'resume', 'id'])
    const args = ['--no-alt-screen', '-c', 'tui.alternate_screen="never"', 'resume', 'id']
    expect(codexTerminalModeArgs(args)).toEqual(args)
  })
  it('preserves hooks, approval, sandbox, provider and native recovery ID', () => {
    const args = ['--no-alt-screen', '--enable', 'hooks', '-c', 'hooks.PermissionRequest=[]', '-c', 'model_provider=example', '-a', 'on-request', '-s', 'workspace-write', 'resume', 'native-id']
    expect(native(args)).toEqual([...args.slice(1, -2), ...overrides, 'resume', 'native-id'])
    expect(args[0]).toBe('--no-alt-screen')
    expect(native(native(args))).toEqual(native(args))
  })
  it.each(['-c', '--config', '--config=', '-c='])('overrides conflicting display config using %s', flag => {
    const value = 'tui.alternate_screen="never"'
    const config = flag.endsWith('=') ? [flag + value] : [flag, value]
    // -c= is accepted by clap as an attached option with an optional equals sign.
    expect(native(config).slice(-4)).toEqual(overrides)
  })
  it('does not add a resume-local config scope unless it already exists', () => {
    expect(native(['resume', 'id'])).toEqual([...overrides, 'resume', 'id'])
    const args = ['-c', 'model=original', 'resume', 'id', '-c', 'model=local', '-c', 'tui.fullscreen_transcript=false']
    const expected = ['-c', 'model=original', ...overrides, 'resume', 'id', '-c', 'model=local', ...overrides]
    expect(native(args)).toEqual(expected)
    expect(native(expected)).toEqual(expected)
  })
  it('preserves delimiters and option values literally', () => {
    const args = ['--profile', 'resume', '--model', '--no-alt-screen', '--', '--no-alt-screen', 'resume', '-c', 'tui.fullscreen_transcript=false']
    expect(native(args)).toEqual([...args.slice(0, 4), ...overrides, ...args.slice(4)])
    expect(codexTerminalModeArgs(['--', '--no-alt-screen'])).toEqual(['--no-alt-screen', '--', '--no-alt-screen'])
  })
  it('retains the mode for continuation initial prompts', () => {
    const args = initialPromptArgs('codex', native(['--no-alt-screen', '-c', 'hooks.PermissionRequest=[]']), 'continue safely')
    expect(args).toContain('tui.alternate_screen="always"')
    expect(args).toContain('hooks.PermissionRequest=[]')
    expect(args.slice(-2)).toEqual(['--', 'continue safely'])
  })
})
