import { posix, win32 } from 'node:path'

import type { AgentKind, RecoveryRecipe } from '../src/shared/manager-api'

const BUILT_INS: Record<AgentKind, ReadonlySet<string>> = {
  codex: new Set(['codex', 'codex.exe', 'codex.cmd']),
  claude: new Set(['claude', 'claude.exe', 'claude.cmd']),
  pi: new Set(['pi', 'pi.exe', 'pi.cmd']),
  deepseek: new Set(['dsh', 'dsh.exe', 'dsh.cmd']),
  generic: new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash', 'zsh']),
}

function normalizedAbsolute(value: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return posix.isAbsolute(value) ? posix.normalize(value) : undefined
  if (!win32.isAbsolute(value)) return undefined
  return win32.normalize(value).toLocaleLowerCase('en-US')
}

export function validateExecutable(
  agentKind: AgentKind,
  candidate: string,
  configuredRaw: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const lower = candidate.toLocaleLowerCase('en-US')
  const isBare = win32.basename(candidate) === candidate && !candidate.includes('/') && !candidate.includes('\\')
  if (isBare && BUILT_INS[agentKind].has(lower)) return candidate

  const normalizedCandidate = normalizedAbsolute(candidate, platform)
  const configured = configuredRaw
    .split(platform === 'win32' ? ';' : ':')
    .map((item) => item.trim())
    .map((item) => normalizedAbsolute(item, platform))
    .filter((item): item is string => item !== undefined)
  if (normalizedCandidate && configured.includes(normalizedCandidate)) return candidate
  throw new Error('Executable is not allowed for this Agent type')
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameExecutable(left: string, right: string): boolean {
  return (normalizedAbsolute(left, process.platform) ?? left.toLocaleLowerCase('en-US')) === (normalizedAbsolute(right, process.platform) ?? right.toLocaleLowerCase('en-US'))
}

export function terminalScrollbackArgs(agentKind: AgentKind, args: string[]): string[] {
  if (agentKind !== 'codex' || args.includes('--no-alt-screen')) return [...args]
  return ['--no-alt-screen', ...args]
}

export function canonicalNativeRecovery(
  agentKind: AgentKind,
  nativeSessionId: string,
  executable: string,
  initialArgs: string[],
  suppliedRecovery: RecoveryRecipe | undefined,
): RecoveryRecipe {
  const resumePrefix = agentKind === 'codex'
    ? ['--no-alt-screen', 'resume', nativeSessionId]
    : agentKind === 'claude'
      ? ['--resume', nativeSessionId]
      : undefined
  const hasCanonicalArgs = Boolean(resumePrefix
    && initialArgs.length >= resumePrefix.length
    && resumePrefix.every((value, index) => initialArgs[index] === value)
    && (agentKind === 'codex' || sameStrings(initialArgs, resumePrefix)))
  if (!resumePrefix || !hasCanonicalArgs || !suppliedRecovery
    || !sameExecutable(suppliedRecovery.executable, executable)
    || !sameStrings(suppliedRecovery.args, initialArgs)
    || suppliedRecovery.continueInput !== undefined) {
    throw new Error('Invalid native resume request')
  }
  return { executable, args: [...initialArgs] }
}
