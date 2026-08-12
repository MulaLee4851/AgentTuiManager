import { delimiter, win32 } from 'node:path'

import type { AgentKind, RecoveryRecipe } from '../src/shared/manager-api'

const BUILT_INS: Record<AgentKind, ReadonlySet<string>> = {
  codex: new Set(['codex', 'codex.exe', 'codex.cmd']),
  claude: new Set(['claude', 'claude.exe', 'claude.cmd']),
  pi: new Set(['pi', 'pi.exe', 'pi.cmd']),
  generic: new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']),
}

function normalizedAbsolute(value: string): string | undefined {
  if (!win32.isAbsolute(value)) return undefined
  return win32.normalize(value).toLocaleLowerCase('en-US')
}

export function validateExecutable(agentKind: AgentKind, candidate: string, configuredRaw: string): string {
  const lower = candidate.toLocaleLowerCase('en-US')
  const isBare = win32.basename(candidate) === candidate && !candidate.includes('/') && !candidate.includes('\\')
  if (isBare && BUILT_INS[agentKind].has(lower)) return candidate

  const normalizedCandidate = normalizedAbsolute(candidate)
  const configured = configuredRaw
    .split(delimiter)
    .map((item) => item.trim())
    .map(normalizedAbsolute)
    .filter((item): item is string => item !== undefined)
  if (normalizedCandidate && configured.includes(normalizedCandidate)) return candidate
  throw new Error('Executable is not allowed for this Agent type')
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameExecutable(left: string, right: string): boolean {
  return (normalizedAbsolute(left) ?? left.toLocaleLowerCase('en-US')) === (normalizedAbsolute(right) ?? right.toLocaleLowerCase('en-US'))
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
  const resumeArgs = agentKind === 'codex'
    ? ['--no-alt-screen', 'resume', nativeSessionId]
    : agentKind === 'claude'
      ? ['--resume', nativeSessionId]
      : undefined
  if (!resumeArgs || !sameStrings(initialArgs, resumeArgs) || !suppliedRecovery
    || !sameExecutable(suppliedRecovery.executable, executable)
    || !sameStrings(suppliedRecovery.args, resumeArgs)
    || suppliedRecovery.continueInput !== undefined) {
    throw new Error('Invalid native resume request')
  }
  return { executable, args: resumeArgs }
}
