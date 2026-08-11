import type { ApprovalRisk } from '../src/shared/manager-api'

export type { ApprovalRisk }

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
  { name: 'read-only-tool', pattern: /^tool:(?:Read|Glob|Grep|WebFetch|WebSearch)$/i },
  { name: 'working-directory', pattern: /^(?:pwd|Get-Location)$/i },
  { name: 'read-file', pattern: /^(?:Get-Content|type)(?:\s+.+)$/i },
  { name: 'list-directory', pattern: /^(?:Get-ChildItem|dir|ls)(?:\s+.*)?$/i },
  { name: 'search-text', pattern: /^(?:Select-String|rg)(?:\s+.+)$/i },
  { name: 'git-status', pattern: /^git\s+status(?:\s+(?:--short|--branch|-s|-b))*$/i },
  { name: 'git-revision', pattern: /^git\s+rev-parse(?:\s+(?:--show-toplevel|--show-prefix|--is-inside-work-tree|--abbrev-ref\s+HEAD))$/i },
]

const KNOWN_READ_ONLY = [
  /^git\s+(?:log|show|diff)(?:\s+.*)?$/i,
]

function normalizedCommand(command: string): string | undefined {
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes('\0') || /[\r\n]/.test(command)) return undefined
  const normalized = command.trim().replace(/\s+/g, ' ')
  return normalized || undefined
}

function riskOf(command: string): ApprovalRisk {
  if (/^tool:(?:Edit|Write|NotebookEdit|TodoWrite)$/i.test(command)) return 'write'
  if (/^tool:/i.test(command) && !/^tool:(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(command)) return 'unknown'
  if (/(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i.test(command)
    || /git\s+(?:clean|reset\s+--hard)(?:\s|$)/i.test(command)) return 'delete'
  if (/(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i.test(command)
    || /git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i.test(command)) return 'write'
  if (/[;&|><`]/.test(command) || /\$\(/.test(command) || /--pre(?:=|\s)/i.test(command)
    || /--(?:output|ext-diff|textconv)(?:=|\s|$)/i.test(command)) return 'unknown'
  if (BUILT_IN_RULES.some((rule) => rule.pattern.test(command))) return 'read'
  if (KNOWN_READ_ONLY.some((pattern) => pattern.test(command))) return 'read'
  return 'unknown'
}
function isUserRuleAllowed(command: string): boolean {
  const risk = riskOf(command)
  if (/^tool:/i.test(command)) return risk === 'read'
  if (risk === 'write' || risk === 'delete') return false
  return !(/[;&|><`]/.test(command) || /\$\(/.test(command) || /--pre(?:=|\s)/i.test(command)
    || /--(?:output|ext-diff|textconv)(?:=|\s|$)/i.test(command))
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
    if (/^tool:Shell$/i.test(command)) {
      return {
        action: 'manual',
        risk: 'unknown',
        reason: '已检测到命令审批，但 Agent 尚未提供完整命令和参数；为避免误放行，需要人工确认',
        command,
      }
    }
    const risk = riskOf(command)
    if (!isUserRuleAllowed(command)) return { action: 'manual', risk, reason: '命令包含写入、删除或复合操作，必须手动批准', command }
    if (this.userRules.has(command.toLocaleLowerCase('en-US'))) {
      return { action: 'auto-approve', risk, reason: 'matched user rule', command, matchedRule: command }
    }
    if (risk !== 'read') return { action: 'manual', risk, reason: '没有匹配到自动批准规则', command }
    const builtIn = BUILT_IN_RULES.find((rule) => rule.pattern.test(command))
    if (builtIn) return { action: 'auto-approve', risk, reason: 'matched built-in read-only rule', command, matchedRule: builtIn.name }
    return { action: 'manual', risk, reason: 'no approval rule matched', command }
  }

  noteManualApproval(rawCommand: string | undefined): ApprovalSuggestion | undefined {
    if (rawCommand === undefined) return undefined
    const command = normalizedCommand(rawCommand)
    if (!command || !isUserRuleAllowed(command)) return undefined
    const key = command.toLocaleLowerCase('en-US')
    const approvalCount = (this.manualCounts.get(key) ?? 0) + 1
    this.manualCounts.set(key, approvalCount)
    return approvalCount >= LEARNING_THRESHOLD ? { command, approvalCount } : undefined
  }

  addRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand)
    if (!command || !isUserRuleAllowed(command)) {
      throw new Error('这条命令不能加入自动批准：它可能包含写入、删除或复合操作。请填写一条完整的简单命令，例如：git log --oneline')
    }
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
