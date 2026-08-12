import { win32 } from 'node:path'
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

// Exact user rules may cover ordinary commands, but these operations remain
// outside the learning boundary because they can cause broad system damage.
const HIGH_RISK_COMMANDS: RegExp[] = [
  /(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i,
  /git\s+(?:clean|reset\s+--hard)(?:\s|$)/i,
  /(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i,
  /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i,
  /git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i,
  /(?:^|\s)rm\s+(?:(?:-\w*[rf]\w*|--(?:recursive|force))\s+){1,}(?:\/|~|\$HOME)(?:\s|$)/i,
  /(?:^|\s)find\s+.*(?:^|\s)-delete(?:\s|$)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /(?:^|\s)chmod\s+(?:-R\s+)?777(?:\s|$)/i,
  /(?:^|\s)chown\s+(?:-R\s+)?[^\s]*root(?:\s|$)/i,
  /(?:^|\s)sudo\s+/i,
  /(?:^|\s)su\s+-/i,
  /(?:curl|wget)\s+.*\|\s*(?:ba)?sh(?:\s|$)/i,
  /--pre(?:=|\s)/i,
  /--(?:output|ext-diff|textconv)(?:=|\s|$)/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\|\s*sh\s*$/i,
  />{1,2}\s*\/?etc\/(?:passwd|shadow|hosts|sudoers)(?:\s|$)/i,
  />{1,2}\s*~\/\.ssh\/authorized_keys(?:\s|$)/i,
  />{1,2}\s*~\/\.bashrc(?:\s|$)/i,
  /(?:^|\s)kill\s+-9\s+1\b/i,
  /(?:^|\s)systemctl\s+(?:stop|disable)(?:\s|$)/i,
  /(?:^|\s)crontab\s+-r(?:\s|$)/i,
  /(?:^|\s)iptables\s+-F(?:\s|$)/i,
]

const BULK_BLOCKED_COMMANDS: RegExp[] = [
  /(?:^|\s)rm\s+(?:(?:-\w*[rf]\w*|--(?:recursive|force))\s+){1,}/i,
  /(?:^|\s)rm\s+.*(?:^|\s)(?:\/|~|\/\*|\$HOME)(?:\s|$)/i,
  /(?:^|\s)Remove-Item\s+.*(?:-Recurse.*-Force|-Force.*-Recurse)/i,
  /(?:^|\s)find\s+.*(?:^|\s)-delete(?:\s|$)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /(?:^|\s)chmod\s+(?:-R\s+)?777(?:\s|$)/i,
  /(?:^|\s)chown\s+(?:-R\s+)?[^\s]*root(?:\s|$)/i,
  /(?:^|\s)sudo\s+/i,
  /(?:^|\s)su\s+-/i,
  /(?:curl|wget)\s+.*\|\s*(?:ba)?sh(?:\s|$)/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\|\s*sh\s*$/i,
  />{1,2}\s*\/?etc\/(?:passwd|shadow|hosts|sudoers)(?:\s|$)/i,
  />{1,2}\s*~\/\.ssh\/authorized_keys(?:\s|$)/i,
  />{1,2}\s*~\/\.bashrc(?:\s|$)/i,
  /(?:^|\s)kill\s+-9\s+1\b/i,
  /(?:^|\s)systemctl\s+(?:stop|disable)(?:\s|$)/i,
  /(?:^|\s)crontab\s+-r(?:\s|$)/i,
  /(?:^|\s)iptables\s+-F(?:\s|$)/i,
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

const UNSAFE_TOOL_NAME = /(?:edit|write|delete|remove|shell|bash|powershell|exec|command|task|apply|patch|move|copy|create|upload|publish|deploy|install|uninstall|kill|stop|restart|format)/i

function isExplicitSafeToolRule(command: string): boolean {
  const match = /^tool:([A-Za-z][\w-]{0,63})$/.exec(command)
  return Boolean(match?.[1] && !UNSAFE_TOOL_NAME.test(match[1]))
}

function isUserRuleAllowed(command: string): boolean {
  if (/^tool:/i.test(command)) return isExplicitSafeToolRule(command)
  return !HIGH_RISK_COMMANDS.some((pattern) => pattern.test(command))
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
    if (!isUserRuleAllowed(command)) return { action: 'manual', risk, reason: '命令命中高危操作保护规则，必须手动批准', command }
    if (this.userRules.has(command.toLocaleLowerCase('en-US'))) {
      return {
        action: 'auto-approve',
        risk: risk === 'unknown' && isExplicitSafeToolRule(command) ? 'read' : risk,
        reason: isExplicitSafeToolRule(command) ? '已匹配用户确认的安全工具' : 'matched user rule',
        command,
        matchedRule: command,
      }
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
      throw new Error('这条命令不能加入自动批准：无法记为安全命令，因为命中了删除、提权、下载执行、敏感覆盖或系统破坏等高危保护规则。')
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

export function canBulkApproveCommand(command: string | undefined): boolean {
  if (command === undefined) return true
  const normalized = normalizedCommand(command)
  return Boolean(normalized && !BULK_BLOCKED_COMMANDS.some((pattern) => pattern.test(normalized)))
}

const FULL_AUTO_BLOCKED_COMMANDS: RegExp[] = [
  ...BULK_BLOCKED_COMMANDS,
  /(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i,
  /git\s+(?:clean|reset\s+--hard)(?:\s|$)/i,
  /(?:^|\s)(?:sudo|su)\s+/i,
  /(?:^|\s)(?:chmod|chown)(?:\s|$)/i,
  /(?:^|\s)(?:Set-Content|Out-File)\b/i,
  /(?:^|[^<])>{1,2}(?![>&])/,
]

const FULL_AUTO_BLOCKED_TOOL = /^(?:Delete|Remove|Task|ApplyPatch|Move|Copy|Create|Upload|Publish|Deploy|Install|Uninstall|Kill|Stop|Restart|Format)$/i
const FULL_AUTO_UNBOUNDED_SHELL_TOOL = /^tool:(?:Shell|Bash|PowerShell|Exec|Command)$/i

function workspaceContains(workspace: string, candidate: string): boolean {
  const normalizedWorkspace = workspace.replace(/\//g, '\\')
  const normalizedCandidate = candidate.replace(/\//g, '\\')
  const root = win32.resolve(normalizedWorkspace).toLocaleLowerCase('en-US')
  const target = win32.resolve(root, normalizedCandidate).toLocaleLowerCase('en-US')
  return target === root || target.startsWith(root.endsWith('\\') ? root : root + '\\')
}

export function canFullAutoApprove(input: {
  command?: string
  risk: ApprovalRisk
  toolName?: string
  workspace: string
  filePath?: string
  targetPaths?: string[]
}): { allowed: boolean; reason: string } {
  const command = input.command ? normalizedCommand(input.command) : undefined
  if (!command) return { allowed: false, reason: 'Agent 没有提供完整命令或工具名称，无法确认影响范围' }
  if (FULL_AUTO_UNBOUNDED_SHELL_TOOL.test(command)) {
    return { allowed: false, reason: 'Agent 没有提供完整 Shell 命令和参数，无法确认影响范围' }
  }
  if (input.risk === 'delete' || FULL_AUTO_BLOCKED_COMMANDS.some((pattern) => pattern.test(command))) {
    return { allowed: false, reason: '命中删除、覆盖、提权或系统破坏保护规则' }
  }
  const toolName = input.toolName ?? (/^tool:([A-Za-z][\w-]*)$/i.exec(command)?.[1])
  if (/^tool:/i.test(command) && toolName && FULL_AUTO_BLOCKED_TOOL.test(toolName)) {
    return { allowed: false, reason: '该工具可能执行删除、提权或无法限定范围的系统操作' }
  }
  const paths = [input.filePath, ...(input.targetPaths ?? [])].filter((value): value is string => Boolean(value))
  if (input.risk === 'write' && paths.length === 0 && /^tool:/i.test(command)) {
    return { allowed: false, reason: '写入工具没有提供目标路径，无法确认它位于当前工作区' }
  }
  if (paths.some((path) => !workspaceContains(input.workspace, path))) {
    return { allowed: false, reason: '目标路径位于当前工作区之外' }
  }
  return { allowed: true, reason: '全自动模式允许此普通操作' }
}
