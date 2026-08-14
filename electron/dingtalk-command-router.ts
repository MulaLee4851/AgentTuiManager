import type { ApprovalRequest, AuditEntry, BulkApprovalResult, SessionSummary } from '../src/shared/manager-api'
import type { StoredDingTalkSettings } from './dingtalk-settings-store'
import type { DingTalkAgentInterpreter } from './dingtalk-agent-interpreter'

export interface DingTalkCommandContext {
  staffId: string
  senderName?: string
}

export interface DingTalkManagerPort {
  listSessions(): SessionSummary[]
  listPendingApprovals(): ApprovalRequest[]
  terminalReplay(sessionId: string): { data: string; sequence: number }
  approveRequest(requestId: string): void | Promise<void>
  approveAllPending(): BulkApprovalResult
  write(sessionId: string, data: string): void | Promise<void>
  stopSession(sessionId: string): Promise<void>
  restartSession(sessionId: string): Promise<void>
  setFullAutoMode(sessionId: string, enabled: boolean): Promise<void>
}

export interface DingTalkAuditPort {
  list(): AuditEntry[]
  record(entry: { level: 'info' | 'warning' | 'error'; action: string; message: string; sessionId?: string; details?: Record<string, string | number | boolean> }): void
}

const HELP = [
  '/agents - Agent 运行列表',
  '/pending - 待审批列表',
  '/approve <审批ID> - 批准指定请求',
  '/approve-all - 按本地安全策略批准全部',
  '/status <Agent> - 查看状态和最近错误',
  '/tail <Agent> - 查看最近终端输出',
  '/workspace <名称或路径> - 查看工作区最近活动',
  '/send <Agent> <内容> - 向终端提交消息',
  '/stop <Agent> - 停止 Agent',
  '/restart <Agent> - 重新启动 Agent',
  '/auto <Agent> on|off - 开启或关闭指定 Agent 的全自动模式',
  '/audit - 查看最近审计记录',
].join('\n')
const TERMINAL_SUBMIT_DELAY_MS = 100

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function cleanTerminal(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\r/g, '')
    .trim()
}

function workspaceKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase('en-US')
}

function shortId(value: string): string { return value.slice(0, 8) }

export class DingTalkCommandRouter {
  private readonly rateWindows = new Map<string, number[]>()

  constructor(
    private readonly manager: DingTalkManagerPort,
    private readonly audit: DingTalkAuditPort,
    private readonly settings: () => StoredDingTalkSettings,
    private readonly bindAccount?: (key: string, staffId: string, senderName?: string) => Promise<boolean>,
    private readonly agentInterpreter?: DingTalkAgentInterpreter,
  ) {}

  async execute(raw: string, context: DingTalkCommandContext): Promise<string> {
    const command = raw.trim()
    const settings = this.settings()
    if (!settings.enabled) return '钉钉远程开发未启用。'
    if (/^\/init(?:\s|$)/i.test(command)) {
      if (settings.boundStaffId) return settings.boundStaffId === context.staffId ? '该钉钉账号已经完成绑定。' : '机器人已经绑定其他账号。'
      const key = command.replace(/^\/init\s*/i, '').trim()
      if (!key || !this.bindAccount || !(await this.bindAccount(key, context.staffId, context.senderName))) {
        this.audit.record({ level: 'warning', action: 'remote_binding_failed', message: '钉钉账号绑定失败', details: { staffId: context.staffId } })
        return '绑定失败：初始化 Key 无效。'
      }
      this.audit.record({ level: 'info', action: 'remote_account_bound', message: '钉钉远程账号已绑定', details: { staffId: context.staffId } })
      return '绑定成功。此后只有当前钉钉账号可以使用远程开发。发送 /help 查看命令。'
    }
    if (!settings.boundStaffId) return '机器人尚未绑定。请在 Manager 的钉钉设置中查看初始化 Key，并发送 /init <Key>。'
    if (settings.boundStaffId !== context.staffId) {
      this.audit.record({ level: 'warning', action: 'remote_access_denied', message: '钉钉远程消息被非绑定账号拒绝', details: { staffId: context.staffId } })
      return '没有权限使用此机器人。'
    }
    if (!this.consumeRateLimit(context.staffId, settings.commandsPerMinute)) {
      this.audit.record({ level: 'warning', action: 'remote_rate_limited', message: '钉钉远程命令触发频率限制', details: { staffId: context.staffId } })
      return `操作过于频繁，每分钟最多 ${settings.commandsPerMinute} 条命令。`
    }
    let routedCommand = command
    if (!command.startsWith('/')) {
      if (!settings.agentModeEnabled || !this.agentInterpreter) return '只接受 / 开头的固定命令。发送 /help 查看可用命令。'
      try {
        // Listing/counting Agents is observational and must reflect the whole Manager.
        // Workspace allowlists still gate every mutating or session-specific command in
        // route(), so exposing the complete inventory does not grant access to a session.
        routedCommand = await this.agentInterpreter.translate(command, settings, { sessions: this.visibleSessions(), approvals: this.manager.listPendingApprovals() })
        this.audit.record({ level: 'info', action: 'remote_agent_interpreted', message: '钉钉 Agent 模式已转换自然语言请求', details: { staffId: context.staffId, command: routedCommand.split(/\s/, 1)[0] ?? '' } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.audit.record({ level: 'error', action: 'remote_agent_failed', message: '钉钉 Agent 模式转换失败', details: { staffId: context.staffId, error: message } })
        return `Agent 模式处理失败：${message}`
      }
    }

    const firstSpace = routedCommand.search(/\s/)
    const verb = (firstSpace < 0 ? routedCommand : routedCommand.slice(0, firstSpace)).toLocaleLowerCase('en-US')
    const args = firstSpace < 0 ? '' : routedCommand.slice(firstSpace).trim()
    try {
      const result = await this.route(verb, args, settings)
      this.audit.record({ level: 'info', action: 'remote_command_executed', message: `已执行钉钉命令 ${verb}`, details: { staffId: context.staffId, command: verb } })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit.record({ level: 'error', action: 'remote_command_failed', message: `钉钉命令 ${verb} 执行失败`, details: { staffId: context.staffId, command: verb, error: message } })
      return `执行失败：${message}`
    }
  }

  private async route(verb: string, args: string, settings: StoredDingTalkSettings): Promise<string> {
    const sessions = this.allowedSessions(settings)
    switch (verb) {
      case '/help': return HELP
      case '/agents': {
        const visible = this.visibleSessions()
        return visible.length ? visible.map((session) => `${shortId(session.sessionId)}  ${session.displayName}  ${session.status}\n${session.workspace}`).join('\n\n') : '当前没有 Agent。'
      }
      case '/pending': return this.pending(settings)
      case '/approve': return this.approve(args, settings)
      case '/approve-all': return this.approveAll(settings)
      case '/status': {
        const session = this.resolveSession(args, sessions)
        return `${session.displayName} (${shortId(session.sessionId)})\n状态：${session.status}\nAgent：${session.agentKind}\n工作区：${session.workspace}${session.lastError ? `\n最近错误：${session.lastError}` : ''}`
      }
      case '/tail': {
        const session = this.resolveSession(args, sessions)
        const output = cleanTerminal(this.manager.terminalReplay(session.sessionId).data)
        return output ? `${session.displayName} 最近输出：\n${output.slice(-3_500)}` : `${session.displayName} 暂无终端输出。`
      }
      case '/workspace': return this.workspaceActivity(args, settings)
      case '/send': {
        const split = args.search(/\s/)
        if (split < 1) throw new Error('用法：/send <Agent> <内容>')
        const session = this.resolveSession(args.slice(0, split), sessions)
        if (!['starting', 'running', 'recovering', 'needs_approval', 'needs_attention'].includes(session.status)) throw new Error('Agent 当前未运行，请先重新启动')
        const content = args.slice(split).trim()
        if (!content || content.length > 4_000 || content.includes('\0') || /[\r\n]/.test(content)) throw new Error('发送内容应为一行且不超过 4000 个字符')
        await this.manager.write(session.sessionId, content)
        await wait(TERMINAL_SUBMIT_DELAY_MS)
        await this.manager.write(session.sessionId, '\r')
        return `已向 ${session.displayName} 发送消息。`
      }
      case '/stop': {
        const session = this.resolveSession(args, sessions)
        await this.manager.stopSession(session.sessionId)
        return `已停止 ${session.displayName}。`
      }
      case '/restart': {
        const session = this.resolveSession(args, sessions)
        await this.manager.restartSession(session.sessionId)
        return `已重新启动 ${session.displayName}。`
      }
      case '/auto': return this.setFullAutoMode(args, sessions)
      case '/audit': return this.recentAudit(settings)
      default: return `未知命令：${verb}\n\n${HELP}`
    }
  }

  private allowedSessions(settings: StoredDingTalkSettings): SessionSummary[] {
    const allowed = new Set(settings.allowedWorkspaces.map(workspaceKey))
    return this.visibleSessions().filter((session) => allowed.has(workspaceKey(session.workspace)))
  }

  private visibleSessions(): SessionSummary[] { return this.manager.listSessions() }

  private resolveSession(selector: string, sessions: SessionSummary[]): SessionSummary {
    const value = selector.trim().toLocaleLowerCase('en-US')
    if (!value) throw new Error('缺少 Agent 名称或会话 ID')
    const idMatches = sessions.filter((session) => session.sessionId.toLocaleLowerCase('en-US').startsWith(value))
    if (idMatches.length === 1) return idMatches[0]!
    const nameMatches = sessions.filter((session) => session.displayName.toLocaleLowerCase('en-US') === value)
    if (nameMatches.length === 1) return nameMatches[0]!
    if (idMatches.length + nameMatches.length > 1) throw new Error('匹配到多个 Agent，请使用 /agents 中的会话 ID 前缀')
    throw new Error('找不到该 Agent，或它不在允许的工作区内')
  }

  private pending(settings: StoredDingTalkSettings): string {
    const allowedIds = new Set(this.allowedSessions(settings).map((session) => session.sessionId))
    const requests = this.manager.listPendingApprovals().filter((request) => allowedIds.has(request.sessionId))
    if (!requests.length) return '当前没有待审批请求。'
    return requests.map((request) => [
      request.requestId,
      `${request.displayName} · ${request.toolName ?? request.agentKind} · 风险 ${request.risk}`,
      request.command ?? request.inputSummary ?? '参数待确认',
      request.agentReason ?? request.reason,
    ].join('\n')).join('\n\n')
  }

  private async approve(requestId: string, settings: StoredDingTalkSettings): Promise<string> {
    if (!requestId) throw new Error('用法：/approve <审批ID>')
    const allowedIds = new Set(this.allowedSessions(settings).map((session) => session.sessionId))
    const request = this.manager.listPendingApprovals().find((candidate) => candidate.requestId === requestId)
    if (!request || !allowedIds.has(request.sessionId)) throw new Error('找不到该审批请求，或它不在允许的工作区内')
    await this.manager.approveRequest(request.requestId)
    return `已批准 ${request.displayName} 的 ${request.toolName ?? '工具请求'}。`
  }

  private approveAll(settings: StoredDingTalkSettings): string {
    const allPending = this.manager.listPendingApprovals()
    const allowedIds = new Set(this.allowedSessions(settings).map((session) => session.sessionId))
    if (allPending.some((request) => !allowedIds.has(request.sessionId))) throw new Error('存在工作区白名单外的审批，不能远程执行一键批准；请使用 /approve 指定请求')
    const result = this.manager.approveAllPending()
    return `批准完成：${result.approved} 个批准，${result.skipped} 个高风险跳过，${result.failed} 个失败。`
  }

  private async setFullAutoMode(args: string, sessions: SessionSummary[]): Promise<string> {
    const match = args.trim().match(/^(.*?)\s+(on|off|enable|disable|开启|关闭)$/i)
    if (!match?.[1] || !match[2]) throw new Error('用法：/auto <Agent> on|off')
    const session = this.resolveSession(match[1], sessions)
    if (session.agentKind === 'deepseek') throw new Error('DeepSeek Harness 的审批由官方 Web 管理，不能在 Manager 中开启全自动模式')
    const enabled = /^(?:on|enable|开启)$/i.test(match[2])
    await this.manager.setFullAutoMode(session.sessionId, enabled)
    return enabled
      ? `已为 ${session.displayName} 开启全自动模式。高风险操作仍会等待人工审批。`
      : `已为 ${session.displayName} 关闭全自动模式。`
  }

  private workspaceActivity(selector: string, settings: StoredDingTalkSettings): string {
    const value = selector.trim().toLocaleLowerCase('en-US')
    if (!value) throw new Error('用法：/workspace <名称或路径>')
    const matches = settings.allowedWorkspaces.filter((workspace) => workspaceKey(workspace) === workspaceKey(selector) || workspace.split(/[\\/]/).filter(Boolean).at(-1)?.toLocaleLowerCase('en-US') === value)
    if (matches.length !== 1) throw new Error(matches.length ? '匹配到多个工作区，请使用完整路径' : '找不到允许的工作区')
    const key = workspaceKey(matches[0]!)
    const entries = this.audit.list().filter((entry) => typeof entry.details?.workspace === 'string' && workspaceKey(String(entry.details.workspace)) === key).slice(0, 10)
    return entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toLocaleString('zh-CN')}  ${entry.message}`).join('\n') : '该工作区暂无审计活动。'
  }

  private recentAudit(settings: StoredDingTalkSettings): string {
    const allowed = new Set(settings.allowedWorkspaces.map(workspaceKey))
    const entries = this.audit.list().filter((entry) => typeof entry.details?.workspace !== 'string' || allowed.has(workspaceKey(String(entry.details.workspace)))).slice(0, 10)
    return entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toLocaleString('zh-CN')}  [${entry.level}] ${entry.message}`).join('\n') : '暂无审计记录。'
  }

  private consumeRateLimit(staffId: string, limit: number): boolean {
    const now = Date.now()
    const recent = (this.rateWindows.get(staffId) ?? []).filter((timestamp) => now - timestamp < 60_000)
    if (recent.length >= limit) { this.rateWindows.set(staffId, recent); return false }
    recent.push(now)
    this.rateWindows.set(staffId, recent)
    return true
  }
}
