import type { CodexTerminalMode } from '../src/shared/terminal-settings'

// Skip option values so a profile/model/prompt named "resume" or
// "--no-alt-screen" is never mistaken for a display flag or subcommand.
const VALUE_OPTIONS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
  '-a', '--ask-for-approval', '-C', '--cd', '-i', '--image', '--add-dir', '--enable', '--disable', '--oss-provider', '--local-provider'])
const DISPLAY_CONFIG = /^\s*tui\.(?:alternate_screen|fullscreen_transcript)\s*=/
const FULLSCREEN_CONFIG = ['-c', 'tui.alternate_screen="always"', '-c', 'tui.fullscreen_transcript=true']

/** Rewrite display options only, at the final PTY launch boundary. Canonical
 * recovery commands remain stable and contain no global UI preferences.
 * Missing mode denotes a legacy HostCommand, not a new Manager's preference. */
export function codexTerminalModeArgs(args: string[], mode: CodexTerminalMode = 'scrollback'): string[] {
  const result: string[] = []
  let subcommand = -1
  let hasLocalConfig = false
  let positionalSeen = false
  let hasNoAlt = false
  let tail: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') { tail = args.slice(i); break }
    const configValue = arg === '-c' || arg === '--config' ? args[i + 1]
      : arg.startsWith('--config=') ? arg.slice(9) : arg.startsWith('-c') && arg.length > 2 ? arg.slice(2).replace(/^=/, '') : undefined
    if (configValue !== undefined && subcommand >= 0) hasLocalConfig = true
    if (mode === 'native-fullscreen' && configValue !== undefined && DISPLAY_CONFIG.test(configValue)) {
      if (arg === '-c' || arg === '--config') i += 1
      continue
    }
    if (arg === '--no-alt-screen') {
      hasNoAlt = true
      if (mode === 'native-fullscreen') continue
    }
    if (!arg.startsWith('-') && !positionalSeen) {
      positionalSeen = true
      if (arg === 'resume' || arg === 'fork') subcommand = result.length
    }
    result.push(arg)
    if (VALUE_OPTIONS.has(arg) && i + 1 < args.length) result.push(args[++i]!)
  }
  if (mode !== 'native-fullscreen') return [...(hasNoAlt ? [] : ['--no-alt-screen']), ...result, ...tail]
  // Never introduce a new resume-local -c scope: some Codex versions replace
  // root overrides when one is present. If the caller already uses that scope,
  // place the display overrides there too, after its original overrides.
  if (subcommand >= 0) {
    result.splice(subcommand, 0, ...FULLSCREEN_CONFIG)
    if (hasLocalConfig) result.push(...FULLSCREEN_CONFIG)
  } else result.push(...FULLSCREEN_CONFIG)
  return [...result, ...tail]
}
