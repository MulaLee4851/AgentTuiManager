import type { AgentKind } from '../src/shared/manager-api'
import { environmentWithFreshWindowsPath, type WindowsPathRefreshOptions } from './windows-environment'

const CODEX_PARENT_MARKERS = [
  'CODEX_THREAD_ID',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SANDBOX_NETWORK_DISABLED',
] as const

// Host-only Electron variables. Session Host is started with ELECTRON_RUN_AS_NODE=1
// so it can load session-host.js; that flag must not leak into Claude/Codex/Pi.
// If the child is an Electron-based or SEA binary, the flag makes it skip its
// normal TUI startup and look like a raw Node process.
const ELECTRON_HOST_LEAKS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'ELECTRON_NO_ATTACH_CONSOLE',
] as const

const COLOR_DISABLES = ['NO_COLOR', 'NODE_DISABLE_COLORS'] as const

// Honest xterm-256/truecolor identity that matches the renderer (xterm.js + dark
// NATIVE_TERMINAL_THEME). Capability flags only — do not add WT_SESSION or
// TERM_PROGRAM=WindowsTerminal. Claude Code then takes a WT-specific input and
// approval path that this app does not implement, which is what broke 审批.
export const MANAGED_TERMINAL_ENV = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
  CLICOLOR: '1',
  CLICOLOR_FORCE: '1',
  // fg;bg in ANSI numbers. 15;0 = white on black → TUI dark theme.
  // The reverse (0;15) is the Windows conhost default and produces 白底黑字.
  COLORFGBG: '15;0',
} as const

function keyOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
}

function remove(environment: NodeJS.ProcessEnv, name: string): void {
  const key = keyOf(environment, name)
  if (key) delete environment[key]
}

function set(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  remove(environment, name)
  environment[name] = value
}

export function applyManagedTerminalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of ELECTRON_HOST_LEAKS) remove(environment, name)
  for (const name of COLOR_DISABLES) remove(environment, name)
  // Keep a real WT_SESSION if the parent inherited one (start.cmd inside
  // Windows Terminal). Do not invent one — Claude Code treats a fake
  // Windows Terminal identity as a different input/approval profile.
  for (const [name, value] of Object.entries(MANAGED_TERMINAL_ENV)) set(environment, name, value)
  return environment
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
    set(environment, 'CLAUDE_CODE_NO_FLICKER', '0')
  }
  applyManagedTerminalEnvironment(environment)
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
