export type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'

export interface ApprovalDecision {
  action: 'auto-approve' | 'manual'
  risk: ApprovalRisk
  reason: string
  command?: string
  matchedRule?: string
}

export interface ApprovalSuggestion {
  command: string
  approvalCount: number
}

const LEARNING_THRESHOLD = 3
const MAX_COMMAND_LENGTH = 2_048

const BUILT_IN_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'working-directory', pattern: /^(?:pwd|Get-Location)$/i },
  { name: 'read-file', pattern: /^(?:Get-Content|type)(?:\s+.+)$/i },
  { name: 'list-directory', pattern: /^(?:Get-ChildItem|dir|ls)(?:\s+.*)?$/i },
  { name: 'search-text', pattern: /^(?:Select-String|rg)(?:\s+.+)$/i },
  { name: 'git-status', pattern: /^git\s+status(?:\s+(?:--short|--branch|-s|-b))*$/i },
  { name: 'git-revision', pattern: /^git\s+rev-parse(?:\s+(?:--show-toplevel|--show-prefix|--is-inside-work-tree|--abbrev-ref\s+HEAD))$/i },
]

function normalizedCommand(command: string): string | undefined {
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes('\0') || /[\r\n]/.test(command)) return undefined
  const normalized = command.trim().replace(/\s+/g, ' ')
  return normalized || undefined
}

function riskOf(command: string): ApprovalRisk {
  if (/(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i.test(command)
    || /git\s+(?:clean|reset\s+--hard)(?:\s|$)/i.test(command)) return 'delete'
  if (/(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i.test(command)
    || /git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i.test(command)) return 'write'
  if (/[;&|><`]/.test(command) || /\$\(/.test(command) || /--pre(?:=|\s)/i.test(command)) return 'unknown'
  if (BUILT_IN_RULES.some((rule) => rule.pattern.test(command))) return 'read'
  return 'unknown'
}

export class ApprovalPolicyEngine {
  private readonly userRules = new Set<string>()
  private readonly manualCounts = new Map<string, number>()

  constructor(userRules: string[] = []) {
    for (const rule of userRules) this.addRule(rule)
  }

  decide(rawCommand: string | undefined): ApprovalDecision {
    if (rawCommand === undefined) return { action: 'manual', risk: 'unknown', reason: 'approval command was not recognized' }
    const command = normalizedCommand(rawCommand)
    if (!command) return { action: 'manual', risk: 'unknown', reason: 'approval command is invalid' }
    const risk = riskOf(command)
    if (risk !== 'read') return { action: 'manual', risk, reason: `${risk} commands require manual approval`, command }
    if (this.userRules.has(command.toLocaleLowerCase('en-US'))) {
      return { action: 'auto-approve', risk, reason: 'matched user rule', command, matchedRule: command }
    }
    const builtIn = BUILT_IN_RULES.find((rule) => rule.pattern.test(command))
    if (builtIn) return { action: 'auto-approve', risk, reason: 'matched built-in read-only rule', command, matchedRule: builtIn.name }
    return { action: 'manual', risk, reason: 'no approval rule matched', command }
  }

  noteManualApproval(rawCommand: string | undefined): ApprovalSuggestion | undefined {
    if (rawCommand === undefined) return undefined
    const command = normalizedCommand(rawCommand)
    if (!command || riskOf(command) !== 'read') return undefined
    const key = command.toLocaleLowerCase('en-US')
    const approvalCount = (this.manualCounts.get(key) ?? 0) + 1
    this.manualCounts.set(key, approvalCount)
    return approvalCount >= LEARNING_THRESHOLD ? { command, approvalCount } : undefined
  }

  addRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand)
    if (!command || riskOf(command) !== 'read') throw new Error('Only read-only commands can be added to auto-approval rules')
    this.userRules.add(command.toLocaleLowerCase('en-US'))
  }

  removeRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand)
    if (command) this.userRules.delete(command.toLocaleLowerCase('en-US'))
  }

  listRules(): string[] {
    return [...this.userRules].sort()
  }
}

export function classifyApprovalRisk(command: string): ApprovalRisk {
  const normalized = normalizedCommand(command)
  return normalized ? riskOf(normalized) : 'unknown'
}
