import type { ApprovalInputIssue, ApprovalRisk, DangerRuleScope, DangerRuleSummary, DangerRuleTestResult } from '../src/shared/manager-api'
import { MAX_APPROVAL_COMMAND_LENGTH, normalizeApprovalInputIssue } from '../src/shared/approval-input'
import { executableCode, parseApprovalCommand, type ParsedApprovalCommand, type ParsedCommandTokens } from './approval-command-parser'
import { permissionHookFields } from './permission-hook-input'

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
  toolInput?: unknown
  inputSummary?: string
  cwd?: string
  inputTruncated?: boolean
  inputIssue?: ApprovalInputIssue
}

export interface LocalApprovalAssessment {
  status: 'ordinary' | 'high-risk' | 'incomplete'
  reason: string
  reasonCode: string
  matchedRules: DangerRuleSummary[]
}

const LEARNING_THRESHOLD = 3
const MAX_SAVED_COMMAND_LENGTH = 16_384

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
  matchesCode?: (parsed: ParsedApprovalCommand) => boolean
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
  builtInDangerRule('recursive-force-remove', '递归或强制删除', '递归或强制删除可能一次移除大量文件。', 'rm -r/-f/--recursive/--force', /^rm\s+(?:.*\s)?(?:-\w*[rf]\w*|--(?:recursive|force))(?=\s|$)/i),
  builtInDangerRule('remove-root-home', '删除根目录或用户目录', '删除根目录、HOME 或通配根路径会造成数据损失。', 'rm ... / | ~ | /* | $HOME', /^rm\s+.*(?:^|\s)(?:\/|~|\/\*|\$HOME)(?:\s|$)/i),
  builtInDangerRule('powershell-recursive-force-remove', 'PowerShell 递归强制删除', '递归强制删除可能移除整个目录树。', 'Remove-Item/ri -Recurse -Force', /^(?:Remove-Item|ri|rm|rmdir|del|erase)\s+.*(?:-Rec(?:urse)?.*-Fo(?:rce)?|-Fo(?:rce)?.*-Rec(?:urse)?)/i),
  builtInDangerRule('cmd-recursive-remove', 'CMD 递归删除目录', 'rd/rmdir /s 会移除整个目录树。', 'rd/rmdir /s', /^(?:rd|rmdir)\s+(?:.*\s)?\/s(?:\s|$)/i),
  builtInDangerRule('find-delete', 'Find 批量删除', 'find -delete 会按查询结果批量删除文件。', 'find ... -delete', /^find\s+.*(?:^|\s)-delete(?:\s|$)/i),
  builtInDangerRule('fork-bomb', 'Shell Fork Bomb', '该命令会快速耗尽系统进程资源。', ':(){ :|:& };:', /^:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/),
  builtInDangerRule('world-writable-permissions', '开放 777 权限', '设置 777 会显著扩大文件访问权限。', 'chmod [-R] 777', /^chmod\s+(?:-R\s+)?777(?:\s|$)/i),
  builtInDangerRule('root-ownership', '修改为 Root 所有者', '修改文件所有权到 root 可能破坏当前用户访问。', 'chown [-R] ...root', /^chown\s+(?:-R\s+)?[^\s]*root(?:\s|$)/i),
  builtInDangerRule('privilege-escalation-sudo', 'Sudo 提权', '提权命令会突破当前用户权限边界。', 'sudo ...', /^sudo\s+/i),
  builtInDangerRule('privilege-escalation-su', '切换 Root 用户', '切换为 root 会突破当前用户权限边界。', 'su -', /^su\s+-/i),
  builtInDangerRule('download-and-execute', '下载后直接执行', '网络内容未经检查就传入解释器执行。', 'curl/wget ... | sh/bash', /^\|\s*(?:bash|sh|zsh|dash|pwsh|powershell)$/i),
  builtInDangerRule('dynamic-eval', '动态 Eval 执行', 'eval 会执行运行时拼接的未知代码。', 'eval(...)', /^eval(?:\s|$)/i),
  builtInDangerRule('dynamic-exec', '动态 Exec 执行', 'exec 会替换或启动未知进程。', 'exec(...)', /^exec$/i),
  builtInDangerRule('pipe-to-shell', '管道传入 Shell', '上游输出会直接作为 Shell 脚本执行。', '... | sh', /^\|\s*(?:bash|sh|zsh|dash|pwsh|powershell)$/i),
  builtInDangerRule('powershell-invoke-expression', 'PowerShell 动态脚本执行', 'Invoke-Expression/iex 会执行传入的脚本，包括下载的内容。', 'Invoke-Expression / iex', /^(?:Invoke-Expression|iex)(?:\s|$)/i),
  builtInDangerRule('overwrite-system-files', '覆盖系统认证文件', '覆盖 passwd、shadow、hosts 或 sudoers 会改变系统关键配置。', '> /etc/passwd|shadow|hosts|sudoers', />{1,2}\s*\/?etc\/(?:passwd|shadow|hosts|sudoers)(?:\s|$)/i),
  builtInDangerRule('overwrite-ssh-authorized-keys', '覆盖 SSH 授权密钥', '修改 authorized_keys 会改变远程登录权限。', '> ~/.ssh/authorized_keys', />{1,2}\s*~\/\.ssh\/authorized_keys(?:\s|$)/i),
  builtInDangerRule('overwrite-shell-profile', '覆盖 Shell 启动配置', '修改 ~/.bashrc 会影响后续所有 Shell 会话。', '> ~/.bashrc', />{1,2}\s*~\/\.bashrc(?:\s|$)/i),
  builtInDangerRule('kill-init-process', '终止 PID 1', '强制终止系统初始化进程可能导致系统不可用。', 'kill -9 1', /^kill\s+-9\s+1\b/i),
  builtInDangerRule('disable-system-service', '停止或禁用系统服务', '停止或禁用系统服务可能导致关键能力中断。', 'systemctl stop|disable', /^systemctl\s+(?:stop|disable)(?:\s|$)/i),
  builtInDangerRule('remove-crontab', '删除 Crontab', 'crontab -r 会删除当前用户全部计划任务。', 'crontab -r', /^crontab\s+-r(?:\s|$)/i),
  builtInDangerRule('flush-firewall', '清空防火墙规则', 'iptables -F 会清空防火墙链规则。', 'iptables -F', /^iptables\s+-F(?:\s|$)/i),
  builtInDangerRule('disk-partition-destruction', '磁盘格式化或分区删除', '清盘、格式化或删除分区会破坏存储数据。', 'Clear-Disk | Format-Volume | Remove-Partition | format', /^(?:Clear-Disk|Format-Volume|Remove-Partition|Initialize-Disk|format|mkfs(?:\.\w+)?)(?:\s|$)/i),
  builtInDangerRule('robocopy-delete-mirror', 'Robocopy 镜像或清除', 'MIR/PURGE 会删除目标中未出现在源目录的文件。', 'robocopy /MIR /PURGE', /^robocopy\s+.*(?:^|\s)\/(?:MIR|PURGE)(?:\s|$)/i),
  builtInDangerRule('disable-windows-protection', '关闭安全防护或防火墙', '关闭防护会降低系统保护能力。', 'Set-MpPreference -Disable* $true | Set-NetFirewallProfile -Enabled $false | netsh ... off', /^(?:Set|Add)-MpPreference\s+.*-Disable\w+(?::|\s+)(?:\$?true|1)(?:\s|$)|^Set-NetFirewallProfile\s+.*-Enabled(?::|\s+)(?:\$?false|0)(?:\s|$)|^netsh\s+(?:advfirewall\s+set\s+\w+\s+state\s+off|firewall\s+set\s+opmode\s+(?:disable|mode=disable))(?:\s|$)/i),
  builtInDangerRule('critical-windows-service', '停止或修改关键 Windows 服务', '停止、删除或禁用关键服务会影响系统和安全能力。', 'Stop/Set-Service | sc stop/delete/config (关键服务)', /^(?:(?:Stop-Service|Set-Service)\s+|sc\s+(?:stop|delete|config)\s+|net\s+stop\s+).*\b(?:WinDefend|MpsSvc|BFE|EventLog|RpcSs|SamSs|wuauserv|WinRM|sshd)\b/i),
  builtInDangerRule('critical-windows-registry', '修改关键注册表配置', '修改系统启动、安全或认证配置可能破坏系统保护和可用性。', 'reg add/delete HKLM\\SYSTEM or security policies', /^reg\s+(?:add|delete|import|restore)\s+.*(?:HKEY_LOCAL_MACHINE|HKLM)[\\/:](?:SYSTEM(?:[\\/]|\s|$)|SOFTWARE[\\/]Policies[\\/]Microsoft[\\/](?:Windows Defender|WindowsFirewall))/i),
  builtInDangerRule('critical-registry-property', '修改关键注册表属性', '更改启动、安全服务或防护策略会影响系统保护和可用性。', 'Set/New/Remove-ItemProperty HKLM:\\SYSTEM or security policies', /^(?:Set|New|Remove)-ItemProperty\s+.*(?:HKLM:|Registry::HKEY_LOCAL_MACHINE)[\\/](?:SYSTEM(?:[\\/]|\s|$)|SOFTWARE[\\/](?:Policies[\\/])?Microsoft[\\/](?:Windows Defender|WindowsFirewall))/i),
  builtInDangerRule('critical-windows-files', '修改 Windows 关键配置文件', '覆盖系统 hosts、启动配置或 PowerShell 配置会改变系统行为。', 'Set/Add-Content | Out-File | redirection -> Windows hosts / $PROFILE', /^(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|ri)\s+.*(?:[\\/]Windows[\\/]System32[\\/]drivers[\\/]etc[\\/]hosts|\$env:(?:windir|SystemRoot)[\\/]System32[\\/]drivers[\\/]etc[\\/]hosts|\$PROFILE)(?:\s|$)|>{1,2}\s*(?:[A-Z]:[\\/]Windows[\\/]System32[\\/]drivers[\\/]etc[\\/]hosts|\$PROFILE)(?:\s|$)/i),
  builtInDangerRule('boot-configuration-write', '修改系统启动配置', '写入启动配置可能导致系统无法正常启动。', 'bcdedit /set /delete /import | bootrec /fix*', /^bcdedit\s+\/(?:set|delete|deletevalue|import|create|copy)(?:\s|$)|^bootrec\s+\/(?:fixmbr|fixboot|rebuildbcd)(?:\s|$)/i),
  builtInDangerRule('git-force-push', 'Git 强制推送', '强制更新远程引用可能覆盖他人的提交。', 'git push --force / -f / +ref', /^git\s+push\s+(?:.*\s)?(?:--force(?:-with-lease|-if-includes)?(?:=\S+)?|-[A-Za-z]*f[A-Za-z]*|\+\S+)(?:\s|$)/i),
  builtInDangerRule('delete-operation', '删除或清空操作', '删除操作需要结合目标路径判断影响范围。', 'rm | rd | ri | Remove-Item | Clear-Content', /^(?:rm|rd|ri|rmdir|del|erase|Remove-Item|Clear-Content)(?:\s|$)/i, ['full-auto']),
  builtInDangerRule('delete-command', '删除或清空命令', '删除、清空和格式化命令不能学习为安全命令。', 'rm | rd | ri | rmdir | del | erase | Remove-Item | Clear-Content | format', /^(?:rm|rd|ri|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('git-destructive', 'Git 清理或硬重置', 'git clean 和 reset --hard 可能永久丢失未提交内容。', 'git clean | git reset --hard', /^git\s+(?:clean(?:\s|$)|reset\s+(?:.*\s)?--hard(?:\s|$))/i, ['safe-rule', 'full-auto']),
  builtInDangerRule('filesystem-write', '文件系统写入命令', '写入、移动、复制或创建文件的命令不能学习为只读安全命令。', 'Set/Add-Content | Out-File | New/Copy/Move-Item | mkdir | touch', /^(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('dependency-mutation', '依赖安装或卸载', '依赖变更会修改项目文件或全局环境。', 'npm/pnpm/yarn install|add|remove|uninstall', /^(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('git-mutation', 'Git 写操作', '提交、切换、合并、推送等 Git 写操作不能学习为只读安全命令。', 'git add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push', /^git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('search-preprocessor', '搜索命令外部预处理器', '--pre 可在搜索前执行外部程序。', '--pre / --pre=...', /^rg\s+.*--pre(?:=|\s)/i, SAFE_RULE_SCOPE),
  builtInDangerRule('external-output-hook', '外部输出或 Diff Hook', '输出重定向、ext-diff 和 textconv 可能执行程序或写入文件。', '--output | --ext-diff | --textconv', /--(?:output|ext-diff|textconv)(?:=|\s|$)/i, SAFE_RULE_SCOPE),
  {
    ...builtInDangerRule('python-recursive-remove', 'Python 递归删除', 'shutil.rmtree 会删除整个目录树。', 'shutil.rmtree(...)', /$^/),
    matchesCode: (parsed) => parsed.code.some(({ language, source }) => {
      if (language !== 'python') return false
      const code = executableCode(source, language)
      if (/\b(?:shutil\s*\.\s*rmtree|rmtree)\s*\(/.test(code)) return true
      const aliases = [...code.matchAll(/\bimport\s+shutil\s+as\s+(\w+)|\bfrom\s+shutil\s+import\s+rmtree\s+as\s+(\w+)/g)]
      return aliases.some((match) => new RegExp('\\b' + (match[1] ? match[1] + '\\s*\\.\\s*rmtree' : match[2]) + '\\s*\\(').test(code))
    }),
  },
  {
    ...builtInDangerRule('node-recursive-remove', 'Node 递归删除', '递归 rm/rmdir 会删除整个目录树。', 'fs.rmSync(..., {recursive: true})', /$^/),
    matchesCode: (parsed) => parsed.code.some(({ language, source }) => language === 'javascript'
      && /\b(?:rmSync|rmdirSync|rm|rmdir)\s*\([^;]*?\brecursive\s*:\s*true\b/.test(executableCode(source, language))),
  },
  {
    ...builtInDangerRule('inline-dynamic-execution', '内联代码动态执行', 'eval/exec 会执行运行时生成的代码。', 'python/node eval(...) or exec(...)', /$^/),
    matchesCode: (parsed) => parsed.code.some(({ language, source }) => {
      let code = executableCode(source, language)
      if (language === 'javascript') {
        // A literal RegExp's exec only matches text. Keep arguments and all other
        // eval/exec calls visible so nested or subsequent side effects still match.
        code = code.replace(/\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])*\/[dgimsuvy]*\s*\.\s*exec\s*\(/g, match => ' '.repeat(match.length))
      }
      return /\b(?:eval|exec)\s*\(/.test(code)
    }),
  },
]

/** Exempt only a real non-mutating flag on this command, never words in a path,
 * an excluded pattern, a quoted PowerShell argument or another subcommand. */
function isNonMutatingPreview(ruleId: string, command: ParsedCommandTokens | undefined): boolean {
  if (!command || command.piped) return false
  const args = command.args
  if (ruleId === 'git-destructive' && command.name === 'git' && args[0]?.value.toLowerCase() === 'clean') {
    let dryRun = false
    for (let index = 1; index < args.length; index++) {
      const token = args[index]!
      if (token.value === '--') break
      if (token.dynamic) return false
      if (token.value === '--no-dry-run') return false
      if (token.value === '-e' || token.value === '--exclude') { index++; continue }
      if (token.value === '--dry-run' || /^-[ndfxXqi]+$/.test(token.value) && token.value.includes('n')) dryRun = true
    }
    return dryRun
  }
  if (ruleId === 'robocopy-delete-mirror' && command.name === 'robocopy') {
    // A job file may carry switches not visible in this request.
    if (args.some(arg => /^\/JOB(?::|$)/i.test(arg.value) || arg.dynamic)) return false
    return args.some(arg => /^\/L$/i.test(arg.value))
  }
  if ((ruleId === 'powershell-recursive-force-remove' || ruleId === 'delete-operation')
    && /^(?:Remove-Item|Clear-Content)$/i.test(command.name)
    && /^(?:(?:Microsoft\.PowerShell\.Management)\\)?(?:Remove-Item|Clear-Content)$/i.test(command.executable.raw)) {
    if (args.some(arg => arg.value === '--%')) return false
    const flags = args.filter(arg => !arg.quoted && /^-WhatIf(?::|$)/i.test(arg.raw))
    return flags.length > 0 && flags.every(arg => /^-WhatIf(?::\$true)?$/i.test(arg.raw))
  }
  return false
}

function publicDangerRule(rule: BuiltInDangerRule): DangerRuleSummary {
  const { matcher: _matcher, matchesCode: _matchesCode, ...summary } = rule
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
  const parsed = parseApprovalCommand(command)
  const builtIn = BUILT_IN_DANGER_RULES
    .filter((rule) => (!scope || rule.scopes.includes(scope))
      && ((rule.id.startsWith('overwrite-') ? parsed.redirections
        : rule.id === 'critical-windows-files'
          ? [...parsed.redirections, ...parsed.commands.filter((part) => /^(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|ri)\s/i.test(part))]
          : parsed.commands).some((command, index) => rule.matcher.test(command) && !isNonMutatingPreview(rule.id, parsed.commandTokens?.[index]))
        || rule.matchesCode?.(parsed)))
    .map(publicDangerRule)
  const lower = command.toLocaleLowerCase('en-US')
  const custom = [...customRules]
    .filter((rule) => rule.enabled && (!scope || ALL_DANGER_SCOPES.includes(scope))
      && lower.includes(rule.keyword.toLocaleLowerCase('en-US')))
    .map(customDangerRuleSummary)
  return [...builtIn, ...custom]
}

function normalizedCommand(command: string, maximum = MAX_APPROVAL_COMMAND_LENGTH): string | undefined {
  if (!command.trim() || command.length > maximum || command.includes('\0')) return undefined
  const normalized = /[\r\n]/.test(command) ? command : command.trim().replace(/\s+/g, ' ')
  return normalized || undefined
}

function riskOf(command: string): ApprovalRisk {
  if (/^tool:(?:Edit|Write|NotebookEdit|TodoWrite)$/i.test(command)) return 'write'
  if (/^tool:/i.test(command) && !/^tool:(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(command)) return 'unknown'
  const commands = parseApprovalCommand(command).commands
  if (commands.some((part) => /^(?:rm|rd|ri|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i.test(part)
    || /^git\s+(?:clean|reset\s+--hard)(?:\s|$)/i.test(part))) return 'delete'
  if (commands.some((part) => /^(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|touch)(?:\s|$)/i.test(part)
    || /^(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)(?:\s|$)/i.test(part)
    || /^git\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|push)(?:\s|$)/i.test(part))) return 'write'
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
    const assessment = this.assessApprovalRequest({ command: rawCommand, risk, workspace: '' })
    if (assessment.status === 'incomplete') return { action: 'manual', risk, reason: assessment.reason, command }
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
    const command = normalizedCommand(rawCommand, MAX_SAVED_COMMAND_LENGTH)
    if (!command || !this.isUserRuleAllowed(command)) return undefined
    const key = command.toLocaleLowerCase('en-US')
    const approvalCount = (this.manualCounts.get(key) ?? 0) + 1
    this.manualCounts.set(key, approvalCount)
    return approvalCount >= LEARNING_THRESHOLD ? { command, approvalCount } : undefined
  }

  addRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand, MAX_SAVED_COMMAND_LENGTH)
    const dangerRule = command ? this.matchDangerRules(command, 'safe-rule')[0] : undefined
    if (!command || !this.isUserRuleAllowed(command)) {
      throw new Error(dangerRule
        ? '这条命令不能加入自动批准：命中了高危规则「' + dangerRule.name + '」。'
        : '这条命令不能加入自动批准：无法记为安全命令，因为它属于可能写入或执行的工具。')
    }
    this.userRules.add(command.toLocaleLowerCase('en-US'))
  }

  removeRule(rawCommand: string): void {
    const command = normalizedCommand(rawCommand, MAX_SAVED_COMMAND_LENGTH)
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
    const command = normalizedCommand(rawCommand, MAX_SAVED_COMMAND_LENGTH)
    if (!command) throw new Error('请输入完整命令，最多 16384 个字符')
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

  assessApprovalRequest(input: FullAutoApprovalInput): LocalApprovalAssessment {
    return assessRequest(input, this.customDangerRules.values())
  }

  private matchDangerRules(command: string, scope?: DangerRuleScope): DangerRuleSummary[] {
    return matchingDangerRules(command, this.customDangerRules.values(), scope)
  }

  private isUserRuleAllowed(command: string): boolean {
    if (this.matchDangerRules(command, 'safe-rule').length) return false
    if (/^tool:/i.test(command)) return isExplicitSafeToolRule(command)
    return !parseApprovalCommand(command).incomplete
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

function validToolInput(value: unknown): boolean {
  const pending = [value]
  const visited = new Set<object>()
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string' && current.includes('\0')) return false
    if (typeof current === 'function' || typeof current === 'symbol' || typeof current === 'bigint') return false
    if (current && typeof current === 'object') {
      if (visited.has(current)) return false
      visited.add(current)
      for (const field of Object.values(current)) pending.push(field)
    }
  }
  return true
}

function inputIssueReason(issue: ApprovalInputIssue): string {
  const count = issue.actualLength === undefined ? '' : String(issue.actualLength)
  switch (issue.code) {
    case 'declared-truncation': return '上游已声明审批输入被截断，需要重新提交完整请求'
    case 'command-too-long': return `审批命令${count ? '完整长度为 ' + count + ' 个字符，' : ''}超过 ${issue.limit ?? MAX_APPROVAL_COMMAND_LENGTH} 个字符的本地处理上限；请缩短命令或将大块数据保存到文件后引用`
    case 'invalid-command': return '审批命令为空、不是文本或包含无效字符，需要重新提交完整命令'
    case 'invalid-command-arguments': return '命令参数数组为空、缺少可执行文件或包含无效参数，需要重新提交完整参数'
    case 'invalid-path': return '审批目标路径为空、类型无效或包含无效字符，需要重新提交完整路径'
    case 'path-too-long': return `审批目标路径${count ? '长度为 ' + count + ' 个字符，' : ''}超过 ${issue.limit ?? 4096} 个字符的本地处理上限`
    case 'too-many-paths': return `审批目标路径${count ? '数量为 ' + count + '，' : ''}超过 ${issue.limit ?? 100} 项的本地处理上限，请拆分请求`
    case 'invalid-input': return '工具参数包含无效字符或结构，需要重新提交完整请求'
  }
}

function assessRequest(
  input: FullAutoApprovalInput,
  customRules: Iterable<CustomDangerRule>,
): LocalApprovalAssessment {
  const incomplete = (reasonCode: string, reason: string): LocalApprovalAssessment => ({ status: 'incomplete', reason, reasonCode, matchedRules: [] })
  const payload = input.toolInput && typeof input.toolInput === 'object' && !Array.isArray(input.toolInput)
    ? input.toolInput as Record<string, unknown>
    : undefined
  const declaredIssue = normalizeApprovalInputIssue(input.inputIssue)
  if (input.inputIssue !== undefined && !declaredIssue) return incomplete('invalid-input', '审批输入诊断结构无效，需要重新提交完整请求')
  const extractedIssue = permissionHookFields(payload).inputIssue
  const directIssue = permissionHookFields({
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    ...(input.targetPaths !== undefined ? { targetPaths: input.targetPaths } : {}),
  }).inputIssue
  const inputIssue = declaredIssue ?? extractedIssue ?? directIssue
  if (inputIssue) return incomplete(inputIssue.code, inputIssueReason(inputIssue))
  if (!validToolInput(input.toolInput)) return incomplete('invalid-input', '工具参数包含无效字符或结构')
  if (input.inputTruncated) {
    return incomplete('truncated-input', '审批参数已被截断，需要完整请求后再判断')
  }
  let command = input.command
  const embedded = payload?.command ?? payload?.cmd ?? payload?.script
  if (Array.isArray(embedded)) {
    if (!embedded.length || embedded.some((part) => typeof part !== 'string' || part.includes('\0')) || !embedded[0]?.trim()) {
      return incomplete('invalid-command-arguments', '命令参数数组包含缺失或无效的参数')
    }
    // Preserve argument boundaries. This representation is parsed locally, never executed.
    command = embedded.map((part: string) => "'" + part.replace(/'/g, "''") + "'").join(' ')
  } else if (typeof embedded === 'string') {
    if (command === undefined || /^tool:/i.test(command)) command = embedded
    else if (command !== embedded) return incomplete('conflicting-command-input', '显示命令与工具原始参数不一致，需要完整请求后再判断')
  } else if (embedded !== undefined) {
    return incomplete('invalid-command-arguments', '工具命令参数结构无效')
  }
  if (command !== undefined) {
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) return incomplete('invalid-input', '审批命令为空或包含无效字符')
    if (/(?:\[\s*(?:truncated|截断|内容已截断)\s*\]|<truncated>)\s*$/i.test(command)) {
      return incomplete('truncated-input', '审批命令包含截断标记，需要完整请求后再判断')
    }
  }
  const toolName = input.toolName ?? (command ? /^tool:([A-Za-z][\w-]*)$/i.exec(command)?.[1] : undefined)
  if (command && /^tool:MCP$/i.test(command)) {
    return incomplete('missing-tool-identity', 'MCP 审批尚未提供服务和工具名称，需要等待完整请求后再判断')
  }
  if (command && FULL_AUTO_UNBOUNDED_SHELL_TOOL.test(command)) {
    return incomplete('missing-shell-command', 'Agent 没有提供完整 Shell 命令和参数，无法确认影响范围')
  }
  if (!command && toolName && /^(?:Shell|Bash|PowerShell|Exec|Command)$/i.test(toolName)) {
    return incomplete('missing-shell-command', 'Agent 没有提供完整 Shell 命令和参数，无法确认影响范围')
  }
  if (!command && !input.toolInput && !input.filePath && !input.targetPaths?.length && !input.inputSummary?.trim()) {
    return incomplete('missing-input', '审批请求没有提供完整命令或工具参数')
  }
  const parsed = command && !/^tool:/i.test(command) ? parseApprovalCommand(command) : undefined
  if (parsed?.incomplete) return incomplete(parsed.incomplete, '审批命令结构不完整，无法确认全部参数')
  const matchedRules = command ? matchingDangerRules(command, customRules, 'full-auto') : []
  if (((input.risk === 'delete' && (!command || /^tool:/i.test(command))) || Boolean(toolName && FULL_AUTO_DELETE_TOOL.test(toolName)))
    && !matchedRules.some((rule) => rule.id === 'delete-operation')) {
    matchedRules.push(publicDangerRule(BUILT_IN_DANGER_RULES.find((rule) => rule.id === 'delete-operation')!))
  }
  if (matchedRules.length) return {
    status: 'high-risk',
    reason: matchedRules.map((rule) => '命中高危规则「' + rule.name + '」：' + rule.description).join('；'),
    reasonCode: 'high-risk-rule',
    matchedRules,
  }
  return { status: 'ordinary', reason: '未命中高危规则，属于普通操作', reasonCode: 'ordinary', matchedRules: [] }
}

export function assessApprovalRequest(input: FullAutoApprovalInput): LocalApprovalAssessment {
  return assessRequest(input, [])
}

function evaluateFullAutoApproval(input: FullAutoApprovalInput, customRules: Iterable<CustomDangerRule>): { allowed: boolean; reason: string } {
  const assessment = assessRequest(input, customRules)
  return { allowed: assessment.status === 'ordinary', reason: assessment.status === 'ordinary' ? '全自动模式允许此普通操作' : assessment.reason }
}

export function canFullAutoApprove(input: FullAutoApprovalInput): { allowed: boolean; reason: string } {
  return evaluateFullAutoApproval(input, [])
}
