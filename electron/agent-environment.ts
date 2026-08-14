import type { AgentKind } from '../src/shared/manager-api'
import { environmentWithFreshWindowsPath, type WindowsPathRefreshOptions } from './windows-environment'

const CODEX_PARENT_MARKERS = [
  'CODEX_THREAD_ID',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SANDBOX_NETWORK_DISABLED',
] as const

function keyOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
}

function remove(environment: NodeJS.ProcessEnv, name: string): void {
  const key = keyOf(environment, name)
  if (key) delete environment[key]
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
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
