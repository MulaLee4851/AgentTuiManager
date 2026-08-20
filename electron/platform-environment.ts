import { execFileSync } from 'node:child_process'

import { environmentWithFreshWindowsPath, pathFromEnvironment, type WindowsPathRefreshOptions } from './windows-environment'

export interface PlatformPathRefreshOptions extends WindowsPathRefreshOptions {
  loginPath?: string
}

function keyOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
}

function macLoginPath(): string | undefined {
  try {
    const output = execFileSync('/bin/zsh', ['-lic', 'printf "\\n__AGENT_TUI_PATH__%s\\n" "$PATH"'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    })
    return output.match(/__AGENT_TUI_PATH__([^\r\n]+)/)?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

function mergePosixPaths(values: readonly (string | undefined)[]): string | undefined {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    for (const rawEntry of value?.split(':') ?? []) {
      const entry = rawEntry.trim()
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.length ? entries.join(':') : undefined
}

export function environmentWithFreshPath(
  source: NodeJS.ProcessEnv = process.env,
  options: PlatformPathRefreshOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return environmentWithFreshWindowsPath(source, options)

  const environment = { ...source }
  if (platform !== 'darwin') return environment
  const pathKey = keyOf(environment, 'PATH') ?? 'PATH'
  const merged = mergePosixPaths([
    environment[pathKey],
    options.loginPath ?? macLoginPath(),
    '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  ])
  if (merged) environment[pathKey] = merged
  return environment
}

export { pathFromEnvironment }
