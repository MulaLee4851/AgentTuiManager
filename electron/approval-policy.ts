import type { ApprovalRisk, DangerRuleScope, DangerRuleSummary, DangerRuleTestResult } from '../src/shared/manager-api'

export type { ApprovalRisk }

export interface ApprovalDecision {
  action: 'auto-approve' | 'manual'
  risk: ApprovalRisk
  reason: string
  command?: string
  matchedRule?: string
  matchedDangerRule?: DangerRuleSummary
}

export interface ApprovalSuggestion {
  command: string
  approvalCount: number
}

export interface CustomDangerRule {
  id: string
  name: string
  keyword: string
  enabled: boolean
}

export interface FullAutoApprovalInput {
  command?: string
  risk: ApprovalRisk
  toolName?: string
  workspace: string
  filePath?: string
  targetPaths?: string[]
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

interface BuiltInDangerRule extends DangerRuleSummary {
  matcher: RegExp
}

const ALL_DANGER_SCOPES: DangerRuleScope[] = ['safe-rule', 'bulk-approval', 'full-auto']
const SAFE_RULE_SCOPE: DangerRuleScope[] = ['safe-rule']

function builtInDangerRule(
  id: string,
  name: string,
  description: string,
  pattern: string,
  matcher: RegExp,
  scopes: DangerRuleScope[] = ALL_DANGER_SCOPES,
): BuiltInDangerRule {
  return { id, name, description, pattern, matcher, scopes, patternKind: 'regex', origin: 'built-in', enabled: true }
}

// These IDs are persisted in audit entries and shown in the UI. Keep them stable.
const BUILT_IN_DANGER_RULES: BuiltInDangerRule[] = [
  builtInDangerRule('recursive-force-remove', '递归或强制删除', '递归/强制删除可能一次移除大量文件，批量批准和全自动模式都会拦截。', 'rm -r/-f/--recursive/--force', /(?:^|\s)rm\s+(?:(?:-\w*[rf]\w*|--(?:recursive|force))\s+){1,}/i),
  builtInDangerRule('remove-root-home', '删除根目录或用户目录', '删除根目录、HOME 或通配根路径会造成不可恢复的数据损失。', 'rm ... / | ~ | /* | $HOME', /(?:^|\s)rm\s+.*(?:^|\s)(?:\/|~|\/\*|\$HOME)(?:\s|$)/i),
  builtInDangerRule('powershell-recursive-force-remove', 'PowerShell 递归强制删除', 'Remove-Item 同时使用 Recurse 和 Force 时必须逐次确认。', 'Remove-Item -Recurse -Force', /(?:^|\s)Remove-Item\s+.*(?:-Recurse.*-Force|-Force.*-Recurse)/i),
  builtInDangerRule('find-delete', 'Find 批量删除', 'find -delete 会按查询结果批量删除文件。', 'find ... -delete', /(?:^|\s)find\s+.*(?:^|\s)-delete(?:\s|$)/i),
  builtInDangerRule('fork-bomb', 'Shell Fork Bomb', '该命令会快速耗尽系统进程资源。', ':(){ :|:& };:', /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/),
  builtInDangerRule('world-writable-permissions', '开放 777 权限', '递归或直接设置 777 会显著扩大文件访问权限。', 'chmod [-R] 777', /(?:^|\s)chmod\s+(?:-R\s+)?777(?:\s|$)/i),
  builtInDangerRule('root-ownership', '修改为 Root 所有者', '批量修改文件所有权到 root 可能破坏当前用户访问。', 'chown [-R] ...root', /(?:^|\s)chown\s+(?:-R\s+)?[^\s]*root(?:\s|$)/i),
  builtInDangerRule('privilege-escalation-sudo', 'Sudo 提权', '提权命令会突破当前用户权限边界。', 'sudo ...', /(?:^|\s)sudo\s+/i),
  builtInDangerRule('privilege-escalation-su', '切换 Root 用户', '切换为 root 会突破当前用户权限边界。', 'su -', /(?:^|\s)su\s+-/i),
  builtInDangerRule('download-and-execute', '下载后直接执行', '网络内容未经检查就传入 Shell 执行。', 'curl/wget ... | sh/bash', /(?:curl|wget)\s+.*\|\s*(?:ba)?sh(?:\s|$)/i),
  builtInDangerRule('dynamic-eval', '动态 Eval 执行', 'eval 会执行运行时拼接的未知代码。', 'eval(...)', /\beval\s*\(/i),
  builtInDangerRule('dynamic-exec', '动态 Exec 执行', 'exec 会替换或启动未知进程。', 'exec(...)', /\bexec\s*\(/i),
  builtInDangerRule('pipe-to-shell', '管道传入 Shell', '上游输出会直接作为 Shell 脚本执行。', '... | sh', /\|\s*sh\s*$/i),
  builtInDangerRule('overwrite-system-files', '覆盖系统认证文件', '覆盖 passwd、shadow、hosts 或 sudoers 会改变系统关键配置。', '> /etc/passwd|shadow|hosts|sudoers', />{1,2}\s*\/?etc\/(?:passwd|shadow|hosts|sudoers)(?:\s|$)/i),
  builtInDangerRule('overwrite-ssh-authorized-keys', '覆盖 SSH 授权密钥', '修改 authorized_keys 会改变远程登录权限。', '> ~/.ssh/authorized_keys', />{1,2}\s*~\/\.ssh\/authorized_keys(?:\s|$)/i),
  builtInDangerRule('overwrite-shell-profile', '覆盖 Shell 启动配置', '修改 ~/.bashrc 会影响后续所有 Shell 会话。', '> ~/.bashrc', />{1,2}\s*~\/\.bashrc(?:\s|$)/i),
  builtInDangerRule('kill-init-process', '终止 PID 1', '强制终止系统初始化进程可能导致系统不可用。', 'kill -9 1', /(?:^|\s)kill\s+-9\s+1\b/i),
  builtInDangerRule('disable-system-service', '停止或禁用系统服务', '停止/禁用系统服务可能导致关键能力中断。', 'systemctl stop|disable', /(?:^|\s)systemctl\s+(?:stop|disable)(?:\s|$)/i),
  builtInDangerRule('remove-crontab', '删除 Crontab', 'crontab -r 会删除当前用户全部计划任务。', 'crontab -r', /(?:^|\s)crontab\s+-r(?:\s|$)/i),
  builtInDangerRule('flush-firewall', '清空防火墙规则', 'iptables -F 会清空防火墙链规则。', 'iptables -F', /(?:^|\s)iptables\s+-F(?:\s|$)/i),
  builtInDangerRule('delete-command', '删除或清空命令', '删除、清空和格式化命令不能学习为安全命令。', 'rm | rmdir | del | erase | Remove-Item | Clear-Content | format', /(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('git-destructive', 'Git 清理或硬重置', 'git clean 和 reset --hard 可能永久丢失未提交内容。', 'git clean | git reset --hard', /git\s+(?:clean|reset\s+--hard)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('filesystem-write', '文件系统写入命令', '写入、移动、复制或创建文件的命令不能学习为只读安全命令。', 'Set/Add-Content | Out-File | New/Copy/Move-Item | mkdir | touch', /(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('dependency-mutation', '依赖安装或卸载', '依赖变更会修改项目文件或全局环境。', 'npm/pnpm/yarn install|add|remove|uninstall', /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('git-mutation', 'Git 写操作', '提交、切换、合并、推送等 Git 写操作不能学习为只读安全命令。', 'git add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push', /git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('search-preprocessor', '搜索命令外部预处理器', '--pre 可在搜索前执行外部程序。', '--pre / --pre=...', /--pre(?:=|\s)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('external-output-hook', '外部输出或 Diff Hook', '输出重定向、ext-diff 和 textconv 可能执行程序或写入文件。', '--output | --ext-diff | --textconv', /--(?:output|ext-diff|textconv)(?:=|\s|$)/i, SAFE_RULE_SCOPE),
]

function publicDangerRule(rule: BuiltInDangerRule): DangerRuleSummary {
  const { matcher: _matcher, ...summary } = rule
  return { ...summary, scopes: [...summary.scopes] }
}

function customDangerRuleSummary(rule: CustomDangerRule): DangerRuleSummary {
  return {
    id: rule.id,
    name: rule.name,
    description: '命令包含该关键词时，禁止保存为安全命令，并跳过批量批准和全自动批准。',
    pattern: rule.keyword,
    patternKind: 'contains',
    origin: 'custom',
    enabled: rule.enabled,
    scopes: [...ALL_DANGER_SCOPES],
  }
}

function matchingDangerRules(
  command: string,
  customRules: Iterable<CustomDangerRule>,
  scope?: DangerRuleScope,
): DangerRuleSummary[] {
  const builtIn = BUILT_IN_DANGER_RULES
    .filter((rule) => (!scope || rule.scopes.includes(scope)) && rule.matcher.test(command))
    .map(publicDangerRule)
  const lower = command.toLocaleLowerCase('en-US')
  const custom = [...customRules]
    .filter((rule) => rule.enabled && (!scope || ALL_DANGER_SCOPES.includes(scope))
      && lower.includes(rule.keyword.toLocaleLowerCase('en-US')))
    .map(customDangerRuleSummary)
  return [...builtIn, ...custom]
}

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

function normalizedDangerName(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized && normalized.length <= 80 && !/[\u0000-\u001f]/.test(normalized) ? normalized : undefined
}

function normalizedDangerKeyword(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length >= 2 && normalized.length <= 256 && !/[\u0000-\u001f]/.test(normalized)
    ? normalized
    : undefined
}


export class ApprovalPolicyEngine {
  private readonly userRules = new Set<string>()
  private readonly manualCounts = new Map<string, number>()
  private readonly customDangerRules = new Map<string, CustomDangerRule>()

  constructor(userRules: string[] = [], dangerRules: CustomDangerRule[] = []) {
    for (const rule of dangerRules) this.addDangerRule(rule)
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
    const dangerRule = this.matchDangerRules(command, 'safe-rule')[0]
    if (dangerRule) return {
      action: 'manual',
      risk,
      reason: '命中高危规则「' + dangerRule.name + '」：' + dangerRule.description,
      command,
      matchedDangerRule: dangerRule,
    }
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
    if (!command || !this.isUserRuleAllowed(command)) return undefined
    const key = command.toLocaleLowerCase('en-US')
    const approvalCount = (this.manualCounts.get(key) ?? 0) + 1
    this.manualCounts.set(key, approvalCount)
    return approvalCount >= LEARNING_THRESHOLD ? { command, approvalCount } : undefined
  }

  addRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand)
    const dangerRule = command ? this.matchDangerRules(command, 'safe-rule')[0] : undefined
    if (!command || !this.isUserRuleAllowed(command)) {
      throw new Error(dangerRule
        ? '这条命令不能加入自动批准：命中了高危规则「' + dangerRule.name + '」。'
        : '这条命令不能加入自动批准：无法记为安全命令，因为它属于可能写入或执行的工具。')
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

  addDangerRule(input: CustomDangerRule): DangerRuleSummary {
    const id = /^[a-zA-Z0-9-]{1,128}$/.test(input.id) ? input.id : undefined
    const name = normalizedDangerName(input.name)
    const keyword = normalizedDangerKeyword(input.keyword)
    if (!id || !name || !keyword) throw new Error('高危规则名称或关键词无效；关键词至少 2 个字符，且不能包含换行或控制字符')
    const duplicate = [...this.customDangerRules.values()].find((rule) =>
      rule.id !== id && rule.keyword.toLocaleLowerCase('en-US') === keyword.toLocaleLowerCase('en-US'))
    if (duplicate) throw new Error('该关键词已由高危规则「' + duplicate.name + '」使用')
    const rule: CustomDangerRule = { id, name, keyword, enabled: input.enabled }
    this.customDangerRules.set(id, rule)
    return customDangerRuleSummary(rule)
  }

  setDangerRuleEnabled(ruleId: string, enabled: boolean): void {
    const current = this.customDangerRules.get(ruleId)
    if (!current) throw new Error('只能启停用户添加的高危规则；内置安全底线始终生效')
    this.customDangerRules.set(ruleId, { ...current, enabled })
  }

  removeDangerRule(ruleId: string): void {
    if (!this.customDangerRules.delete(ruleId)) throw new Error('只能删除用户添加的高危规则；内置安全底线不能删除')
  }

  listDangerRules(): DangerRuleSummary[] {
    return [
      ...BUILT_IN_DANGER_RULES.map(publicDangerRule),
      ...[...this.customDangerRules.values()]
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
        .map(customDangerRuleSummary),
    ]
  }

  listCustomDangerRules(): CustomDangerRule[] {
    return [...this.customDangerRules.values()].map((rule) => ({ ...rule }))
  }

  testDangerCommand(rawCommand: string): DangerRuleTestResult {
    const command = normalizedCommand(rawCommand)
    if (!command) throw new Error('请输入一条完整的单行命令进行测试')
    return { command, matches: this.matchDangerRules(command) }
  }

  canBulkApproveCommand(rawCommand: string | undefined): boolean {
    if (rawCommand === undefined) return true
    const command = normalizedCommand(rawCommand)
    return Boolean(command && this.matchDangerRules(command, 'bulk-approval').length === 0)
  }

  canFullAutoApprove(input: FullAutoApprovalInput): { allowed: boolean; reason: string } {
    return evaluateFullAutoApproval(input, this.customDangerRules.values())
  }

  private matchDangerRules(command: string, scope?: DangerRuleScope): DangerRuleSummary[] {
    return matchingDangerRules(command, this.customDangerRules.values(), scope)
  }

  private isUserRuleAllowed(command: string): boolean {
    if (/^tool:/i.test(command)) return isExplicitSafeToolRule(command)
    return this.matchDangerRules(command, 'safe-rule').length === 0
  }
}

export function classifyApprovalRisk(command: string): ApprovalRisk {
  const normalized = normalizedCommand(command)
  return normalized ? riskOf(normalized) : 'unknown'
}

export function canBulkApproveCommand(command: string | undefined): boolean {
  if (command === undefined) return true
  const normalized = normalizedCommand(command)
  return Boolean(normalized && matchingDangerRules(normalized, [], 'bulk-approval').length === 0)
}

const FULL_AUTO_DELETE_TOOL = /^(?:Delete|Remove|Format)$/i
const FULL_AUTO_UNBOUNDED_SHELL_TOOL = /^tool:(?:Shell|Bash|PowerShell|Exec|Command)$/i

function evaluateFullAutoApproval(
  input: FullAutoApprovalInput,
  customRules: Iterable<CustomDangerRule>,
): { allowed: boolean; reason: string } {
  const command = input.command ? normalizedCommand(input.command) : undefined
  const toolName = input.toolName ?? (command ? /^tool:([A-Za-z][\w-]*)$/i.exec(command)?.[1] : undefined)
  if (input.risk === 'delete' || Boolean(toolName && FULL_AUTO_DELETE_TOOL.test(toolName))) {
    return { allowed: false, reason: '删除操作不参与全自动批准，仍需逐次人工确认' }
  }
  const dangerRule = command ? matchingDangerRules(command, customRules, 'full-auto')[0] : undefined
  if (dangerRule) {
    return { allowed: false, reason: '命中高危规则「' + dangerRule.name + '」：' + dangerRule.description }
  }
  if (command && /^tool:MCP$/i.test(command)) {
    return { allowed: false, reason: 'MCP 审批尚未提供服务和工具名称，需要等待完整请求后再判断' }
  }
  if (command && FULL_AUTO_UNBOUNDED_SHELL_TOOL.test(command)) {
    return { allowed: false, reason: 'Agent 没有提供完整 Shell 命令和参数，无法确认影响范围' }
  }
  if (!command && toolName && /^(?:Shell|Bash|PowerShell|Exec|Command)$/i.test(toolName)) {
    return { allowed: false, reason: 'Agent 没有提供完整 Shell 命令和参数，无法确认影响范围' }
  }
  return { allowed: true, reason: '全自动模式允许此普通操作' }
}

export function canFullAutoApprove(input: FullAutoApprovalInput): { allowed: boolean; reason: string } {
  return evaluateFullAutoApproval(input, [])
}
