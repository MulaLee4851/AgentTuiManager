import type { AgentKind, RecoveryRecipe } from '../src/shared/manager-api'

export interface AgentObservation {
  approvalRequired: boolean
  approvalCommand?: string
  ready: boolean
}

export interface AgentAdapter {
  readonly kind: AgentKind
  readonly supportsNativeSessions: boolean
  observeOutput(data: string): AgentObservation
  acknowledgeUserInput(): void
  resetForRecovery(): void
  approvalInput(): string
  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe | undefined
}

const MAX_EVIDENCE_CHARACTERS = 32_768

function terminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
}

abstract class EvidenceAdapter implements AgentAdapter {
  abstract readonly kind: AgentKind
  abstract readonly supportsNativeSessions: boolean
  private evidence = ''
  private suppressHandledApproval = false

  observeOutput(data: string): AgentObservation {
    this.evidence = `${this.evidence}${terminalText(data)}`.slice(-MAX_EVIDENCE_CHARACTERS)
    const observation = this.classify(this.evidence)
    if (this.suppressHandledApproval && observation.approvalRequired) {
      return { ready: false, approvalRequired: false }
    }
    if (!observation.approvalRequired) this.suppressHandledApproval = false
    return observation
  }

  acknowledgeUserInput(): void {
    // Old approval text remains in a full-screen terminal's scrollback. Clear it so
    // it cannot re-trigger after the user has answered the prompt.
    this.evidence = ''
    this.suppressHandledApproval = true
  }

  resetForRecovery(): void {
    this.evidence = ''
    this.suppressHandledApproval = false
  }

  approvalInput(): string { return '\r' }

  abstract recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe | undefined
  protected abstract classify(evidence: string): AgentObservation
}

const EXPLICIT_APPROVAL = [
  /approval required/i,
  /requires? (?:your )?approval/i,
  /permission required/i,
]

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function commandFromApproval(evidence: string): string | undefined {
  const shellLines = [...evidence.matchAll(/(?:^|\n)\s*\$\s+([^\n]+)/g)]
  const shellCommand = shellLines.at(-1)?.[1]?.trim()
  if (shellCommand) return shellCommand
  return /(?:^|\n)\s*Bash command\s*\n\s*([^\n]+)/i.exec(evidence)?.[1]?.trim() || undefined
}

class CodexAdapter extends EvidenceAdapter {
  readonly kind = 'codex' as const
  readonly supportsNativeSessions = true

  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe {
    return { executable, args: ['resume', nativeSessionId] }
  }

  protected classify(evidence: string): AgentObservation {
    const approvalRequired = includesAny(evidence, [
      ...EXPLICIT_APPROVAL,
      /would you like to run the following command/i,
      /do you want to (?:allow|run|execute) (?:this|the) command/i,
      /allow command execution/i,
    ])
    const hasIdentity = /(?:openai\s+)?codex/i.test(evidence)
    const hasPrompt = /(?:^|[\r\n])\s*[›❯]\s*(?:$|[\r\n])/m.test(evidence)
      || /type \/ to select a command/i.test(evidence)
    const approvalCommand = approvalRequired ? commandFromApproval(evidence) : undefined
    return { approvalRequired, ...(approvalCommand ? { approvalCommand } : {}), ready: !approvalRequired && hasIdentity && hasPrompt }
  }
}

class ClaudeAdapter extends EvidenceAdapter {
  readonly kind = 'claude' as const
  readonly supportsNativeSessions = true

  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe {
    return { executable, args: ['--resume', nativeSessionId] }
  }

  protected classify(evidence: string): AgentObservation {
    const approvalRequired = includesAny(evidence, [
      ...EXPLICIT_APPROVAL,
      /allow this tool use/i,
      /do you want to proceed\?/i,
      /would you like to proceed\?/i,
      /do you want to allow (?:this|the) (?:tool|command)/i,
    ])
    const hasIdentity = /claude\s+code/i.test(evidence)
    const hasPrompt = /(?:^|[\r\n])\s*[❯›]\s*(?:$|[\r\n])/m.test(evidence)
      || /\? for shortcuts/i.test(evidence)
    const approvalCommand = approvalRequired ? commandFromApproval(evidence) : undefined
    return { approvalRequired, ...(approvalCommand ? { approvalCommand } : {}), ready: !approvalRequired && hasIdentity && hasPrompt }
  }
}

class GenericAdapter extends EvidenceAdapter {
  readonly supportsNativeSessions = false
  constructor(readonly kind: 'generic' | 'pi') { super() }

  recoveryRecipe(): undefined { return undefined }

  protected classify(evidence: string): AgentObservation {
    return {
      approvalRequired: includesAny(evidence, EXPLICIT_APPROVAL),
      ready: evidence.trim().length > 0,
    }
  }
}

export function createAgentAdapter(kind: AgentKind): AgentAdapter {
  if (kind === 'codex') return new CodexAdapter()
  if (kind === 'claude') return new ClaudeAdapter()
  return new GenericAdapter(kind)
}
