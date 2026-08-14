import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface WindowsPathRefreshOptions {
  platform?: NodeJS.Platform
  registryPaths?: readonly string[]
}

function keyOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
}

function expandEnvironmentVariables(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = keyOf(environment, name)
    return key && environment[key] !== undefined ? environment[key] : match
  })
}

function currentWindowsPaths(): string[] {
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    const executable = systemRoot
      ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    const script = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
      '$name = -join [char[]](80, 97, 116, 104)',
      '$machine = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Machine)',
      '$user = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::User)',
      'ConvertTo-Json -Compress @($machine, $user)',
    ].join('; ')
    const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    })
    const result: unknown = JSON.parse(output.trim())
    return (Array.isArray(result) ? result : [result]).filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function normalizePathEntry(entry: string): string {
  return entry.trim().replace(/^\x22|\x22$/g, '').replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

export function mergeWindowsPaths(values: readonly (string | undefined)[]): string | undefined {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    for (const rawEntry of value?.split(';') ?? []) {
      const entry = rawEntry.trim()
      const normalized = normalizePathEntry(entry)
      if (!entry || !normalized || seen.has(normalized)) continue
      seen.add(normalized)
      entries.push(entry)
    }
  }
  return entries.length ? entries.join(';') : undefined
}

export function environmentWithFreshWindowsPath(
  source: NodeJS.ProcessEnv = process.env,
  options: WindowsPathRefreshOptions = {},
): NodeJS.ProcessEnv {
  const environment = { ...source }
  if ((options.platform ?? process.platform) !== 'win32') return environment
  const pathKey = keyOf(environment, 'PATH') ?? 'Path'
  const registryPaths = options.registryPaths ?? currentWindowsPaths()
  const expanded = registryPaths.map((value) => value ? expandEnvironmentVariables(value, environment) : undefined)
  const merged = mergeWindowsPaths([environment[pathKey], ...expanded])
  if (merged) environment[pathKey] = merged
  return environment
}

export function pathFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const key = keyOf(environment, 'PATH')
  return key ? environment[key] : undefined
}
