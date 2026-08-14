import type { AgentKind } from '../src/shared/manager-api'
import { environmentWithFreshWindowsPath, type WindowsPathRefreshOptions } from './windows-environment'

const CODEX_PARENT_MARKERS = [
  'CODEX_THREAD_ID',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SANDBOX_NETWORK_DISABLED',
] as const

const COLOR_DISABLE_VARS = ['NO_COLOR', 'NODE_DISABLE_COLORS'] as const

// Capability + the one emulator identity Claude's Windows VT allowlist accepts
// that is not Windows Terminal. Claude.exe:
//   windowsConsoleSupportsVirtualTerminalSequences()
//     WT_SESSION → true
//     TERM_PROGRAM=vscode && TERM_PROGRAM_VERSION → true
//     mintty / MSYSTEM → true
//     else → false
// Without that, it keeps a dark COLORFGBG theme but emits no color/rich SGR.
// Do not invent WT_SESSION (approval/input profile). Do not set MSYSTEM (path
// translation). Do not set FORCE_COLOR (truecolor-on-every-cell).
// vscode 1.110.0 is outside Claude's known-bad version windows
// (1.92–1.104 and 1.123–1.124).
export const MANAGED_TERMINAL_CAPABILITIES = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  COLORFGBG: '15;0',
  TERM_PROGRAM: 'vscode',
  TERM_PROGRAM_VERSION: '1.110.0',
} as const

function keyOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
}

function remove(environment: NodeJS.ProcessEnv, name: string): void {
  const key = keyOf(environment, name)
  if (key) delete environment[key]
}

function applyManagedTerminalCapabilities(environment: NodeJS.ProcessEnv): void {
  for (const name of COLOR_DISABLE_VARS) remove(environment, name)
  // start.cmd inherits Windows Terminal. Leave that env byte-identical so the
  // already-working approval hook path does not change. Packaged Explorer
  // launches have no WT_SESSION and no TERM; fill only the missing keys.
  if (keyOf(environment, 'WT_SESSION')) return
  for (const [name, value] of Object.entries(MANAGED_TERMINAL_CAPABILITIES)) {
    if (!keyOf(environment, name)) environment[name] = value
  }
}

export function environmentForAgent(
  agentKind: AgentKind,
  source: NodeJS.ProcessEnv = process.env,
  pathRefreshOptions: WindowsPathRefreshOptions = {},
): Record<string, string> {
  const environment: NodeJS.ProcessEnv = agentKind === 'pi'
    ? environmentWithFreshWindowsPath(source, pathRefreshOptions)
    : { ...source }
  if (agentKind === 'codex' && CODEX_PARENT_MARKERS.some((name) => keyOf(source, name) !== undefined)) {
    for (const name of CODEX_PARENT_MARKERS) remove(environment, name)
    // When Manager itself is launched by Codex, these credentials belong to the
    // parent Agent. Let the nested native CLI load the user's own config.toml.
    remove(environment, 'CODEX_API_KEY')
    remove(environment, 'OPENAI_API_KEY')
  }
  if (agentKind === 'claude') {
    // Claude Code's official inline fallback keeps completed messages in the
    // containing terminal scrollback instead of an alternate-screen viewport.
    environment.CLAUDE_CODE_NO_FLICKER = '0'
  }
  applyManagedTerminalCapabilities(environment)
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
