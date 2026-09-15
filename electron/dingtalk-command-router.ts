import type { ApprovalRequest, AuditEntry, BulkApprovalResult, SessionSummary } from '../src/shared/manager-api'
import { SESSION_STATUS_LABEL, sessionDisplayStatus, parseSessionDisplayStatus, type SessionDisplayStatus } from '../src/shared/session-state'
import type { StoredDingTalkSettings } from './dingtalk-settings-store'
import type { DingTalkAgentInterpreter } from './dingtalk-agent-interpreter'
import { terminalReplayText } from './terminal-state-replay'

export interface DingTalkCommandContext {
  staffId: string
  senderName?: string
}

export interface DingTalkManagerPort {
  listSessions(): SessionSummary[]
  listPendingApprovals(): ApprovalRequest[]
  terminalReplay(sessionId: string): { data: string; sequence: number }
  terminalText?(sessionId: string): Promise<string>
  approveRequest(requestId: string): void | Promise<void>
  approveAllPendingForced(): Promise<BulkApprovalResult>
  write(sessionId: string, data: string): void | Promise<void>
  sendMessage?(sessionId: string, content: string): Promise<void>
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
  '/approve-all-force - 忽略风险限制，强制批准全部',
  '/status <Agent> - 查看状态和最近错误',
  '/tail <Agent> - 查看最近终端输出',
  '/workspace <名称或路径> - 查看工作区最近活动',
  '/send <Agent> <内容> - 向终端提交消息',
  '/send-status <状态> <内容> - 向该状态的全部 Agent 发送消息，如 /send-status 待命 continue',
  '状态：已停止、运行中、待命、待审批、异常；批量发消息不会代替批准，也不会重启已退出窗口。',
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

function workspaceKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase('en-US')
}

function shortId(value: string): string { return value.slice(0, 8) }

export class DingTalkCommandRouter {
  private readonly rateWindows = new Map<string, number[]>()
  private readonly sending = new Set<string>()

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
    let routedCommands = [command]
    let interpretationReason: string | undefined
    if (!command.startsWith('/')) {
      if (!settings.agentModeEnabled || !this.agentInterpreter) return '只接受 / 开头的固定命令。发送 /help 查看可用命令。'
      try {
        // Listing/counting Agents is observational and must reflect the whole Manager.
        // Workspace allowlists still gate every mutating or session-specific command in
        // route(), so exposing the complete inventory does not grant access to a session.
        const translation = await this.agentInterpreter.translate(command, settings, { sessions: this.visibleSessions(), approvals: this.manager.listPendingApprovals() })
        if (typeof translation === 'string') routedCommands = [translation]
        else {
          routedCommands = translation.commands
          interpretationReason = translation.reason
        }
        if (routedCommands.length === 0) throw new Error('Agent 模式没有生成任何可执行操作')
        this.audit.record({ level: 'info', action: 'remote_agent_interpreted', message: '钉钉 Agent 模式已转换自然语言请求', details: { staffId: context.staffId, command: routedCommands[0]?.split(/\s/, 1)[0] ?? '', commandCount: routedCommands.length } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.audit.record({ level: 'error', action: 'remote_agent_failed', message: '钉钉 Agent 模式转换失败', details: { staffId: context.staffId, error: message } })
        return `Agent 模式处理失败：${message}`
      }
    }

    if (!command.startsWith('/') && routedCommands.every((item) => item === '/help')) {
      return `未执行：${interpretationReason ?? '没有识别到明确且受支持的 Manager 操作'}\n\n${HELP}`
    }
    const results: Array<{ command: string; ok: boolean; result: string }> = []
    for (const routedCommand of routedCommands) {
      const firstSpace = routedCommand.search(/\s/)
      const verb = (firstSpace < 0 ? routedCommand : routedCommand.slice(0, firstSpace)).toLocaleLowerCase('en-US')
      const args = firstSpace < 0 ? '' : routedCommand.slice(firstSpace).trim()
      try {
        const result = await this.route(verb, args, settings)
        this.audit.record({ level: 'info', action: 'remote_command_executed', message: `已执行钉钉命令 ${verb}`, details: { staffId: context.staffId, command: verb } })
        results.push({ command: routedCommand, ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.audit.record({ level: 'error', action: 'remote_command_failed', message: `钉钉命令 ${verb} 执行失败`, details: { staffId: context.staffId, command: verb, error: message } })
        results.push({ command: routedCommand, ok: false, result: `执行失败：${message}` })
      }
    }
    if (results.length === 1) return results[0]!.result
    return results.map((item, index) => `${index + 1}. ${item.ok ? '成功' : '失败'} · ${item.command}\n${item.result}`).join('\n\n')
  }

  private async route(verb: string, args: string, settings: StoredDingTalkSettings): Promise<string> {
    const sessions = this.visibleSessions()
    switch (verb) {
      case '/help': return HELP
      case '/agents': {
        const visible = this.visibleSessions()
        return visible.length ? visible.map((session) => `${shortId(session.sessionId)}  ${session.displayName}  ${SESSION_STATUS_LABEL[sessionDisplayStatus(session)]}\n${session.workspace}`).join('\n\n') : '当前没有 Agent。'
      }
      case '/pending': return this.pending()
      case '/approve': return this.approve(args)
      case '/approve-all-force': return this.approveAllForced()
      case '/status': {
        const session = this.resolveSession(args, sessions)
        return `${session.displayName} (${shortId(session.sessionId)})\n状态：${SESSION_STATUS_LABEL[sessionDisplayStatus(session)]}\nAgent：${session.agentKind}\n工作区：${session.workspace}${session.activityError || session.lastError ? `\n最近错误：${session.activityError ?? session.lastError}` : ''}`
      }
      case '/tail': {
        const session = this.resolveSession(args, sessions)
        const output = this.manager.terminalText
          ? await this.manager.terminalText(session.sessionId)
          : await terminalReplayText(this.manager.terminalReplay(session.sessionId).data)
        return output ? `${session.displayName} 最近输出：\n${output.slice(-3_500)}` : `${session.displayName} 暂无终端输出。`
      }
      case '/workspace': return this.workspaceActivity(args)
      case '/send': {
        const split = args.search(/\s/)
        if (split < 1) throw new Error('用法：/send <Agent> <内容>')
        const session = this.resolveSession(args.slice(0, split), sessions)
        const content = args.slice(split).trim()
        await this.sendMessage(session.sessionId, content)
        return `已向 ${session.displayName} 发送消息。`
      }
      case '/send-status': {
        const split = args.search(/\s/)
        if (split < 1) throw new Error('用法：/send-status <状态> <内容>')
        const status = parseSessionDisplayStatus(args.slice(0, split))
        if (!status) throw new Error('未知状态，请使用 /agents 查看 Agent，或 /help 查看支持的状态')
        const content = args.slice(split).trim()
        this.validateMessage(content)
        const targets = sessions.filter((session) => sessionDisplayStatus(session) === status)
        if (!targets.length) return '没有处于“' + SESSION_STATUS_LABEL[status] + '”状态的 Agent。'
        const results: string[] = []
        let sent = 0
        for (const session of targets) {
          try {
            await this.sendMessage(session.sessionId, content, status)
            sent += 1
            results.push('成功 · ' + session.displayName + ' (' + shortId(session.sessionId) + ')')
            this.audit.record({ level: 'info', action: 'remote_status_message_sent', message: '已按状态批量发送消息', sessionId: session.sessionId, details: { status } })
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            results.push('未发送 · ' + session.displayName + ' (' + shortId(session.sessionId) + ')：' + reason)
            this.audit.record({ level: 'warning', action: 'remote_status_message_skipped', message: '按状态批量发送消息未完成', sessionId: session.sessionId, details: { status, reason } })
          }
        }
        return '匹配 ' + targets.length + ' 个，成功 ' + sent + ' 个，未发送 ' + (targets.length - sent) + ' 个。\n' + results.join('\n')
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
      case '/audit': return this.recentAudit()
      default: return `未知命令：${verb}\n\n${HELP}`
    }
  }

  private validateMessage(content: string): void {
    if (!content || content.length > 4000 || /[\x00-\x1f\x7f]/.test(content)) throw new Error('发送内容应为一行且不超过 4000 个字符，不能包含控制字符')
  }

  private async sendMessage(sessionId: string, content: string, expectedStatus?: SessionDisplayStatus): Promise<void> {
    this.validateMessage(content)
    if (this.sending.has(sessionId)) throw new Error('该 Agent 正在发送其他消息，请稍后重试')
    const check = (): void => {
      const current = this.manager.listSessions().find((session) => session.sessionId === sessionId)
      if (!current) throw new Error('Agent 已移除')
      if (['completed', 'stopped', 'failed'].includes(current.status) || current.recoveryAction === 'resume') throw new Error('Agent 当前未运行，请先重新启动')
      if (current.agentKind === 'deepseek') throw new Error('DeepSeek Harness 请在官方 Web 界面发送消息')
      if (current.status === 'starting' || current.status === 'recovering' || current.activity === 'starting') throw new Error('Agent 尚未就绪，请稍后重试')
      if (current.status === 'needs_approval' || this.manager.listPendingApprovals().some((request) => request.sessionId === sessionId)) throw new Error('Agent 正在等待授权，请先处理审批；发送消息不会代替批准')
      if (expectedStatus && sessionDisplayStatus(current) !== expectedStatus) throw new Error('Agent 状态已变化，本次跳过')
    }
    this.sending.add(sessionId)
    try {
      check()
      if (this.manager.sendMessage) {
        await this.manager.sendMessage(sessionId, content)
        return
      }
      await this.manager.write(sessionId, content)
      await wait(TERMINAL_SUBMIT_DELAY_MS)
      // A new approval must not consume the Enter intended for a chat message.
      check()
      await this.manager.write(sessionId, '\r')
    } finally {
      this.sending.delete(sessionId)
    }
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
    throw new Error('找不到该 Agent')
  }

  private pending(): string {
    const requests = this.manager.listPendingApprovals()
    if (!requests.length) return '当前没有待审批请求。'
    return requests.map((request) => [
      request.requestId,
      `${request.displayName} · ${request.toolName ?? request.agentKind} · 风险 ${request.risk}`,
      request.command ?? request.inputSummary ?? '参数待确认',
      request.agentReason ?? request.reason,
    ].join('\n')).join('\n\n')
  }

  private async approve(requestId: string): Promise<string> {
    if (!requestId) throw new Error('用法：/approve <审批ID>')
    const request = this.manager.listPendingApprovals().find((candidate) => candidate.requestId === requestId)
    if (!request) throw new Error('找不到该审批请求')
    await this.manager.approveRequest(request.requestId)
    return `已批准 ${request.displayName} 的 ${request.toolName ?? '工具请求'}。`
  }

  private async approveAllForced(): Promise<string> {
    const result = await this.manager.approveAllPendingForced()
    this.audit.record({
      level: 'warning',
      action: 'remote_approval_force_all',
      message: '钉钉已忽略风险限制并强制批准全部待审批请求',
      details: { approved: result.approved, failed: result.failed },
    })
    return `强制批准完成：${result.approved} 个批准，${result.failed} 个失败。`
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

  private workspaceActivity(selector: string): string {
    const value = selector.trim().toLocaleLowerCase('en-US')
    if (!value) throw new Error('用法：/workspace <名称或路径>')
    const workspaces = new Set(this.visibleSessions().map((session) => session.workspace))
    for (const entry of this.audit.list()) {
      if (typeof entry.details?.workspace === 'string') workspaces.add(String(entry.details.workspace))
    }
    const matches = [...workspaces].filter((candidate) => workspaceKey(candidate) === workspaceKey(selector) || candidate.split(/[\\/]/).filter(Boolean).at(-1)?.toLocaleLowerCase('en-US') === value)
    if (matches.length !== 1) throw new Error(matches.length ? '匹配到多个工作区，请使用完整路径' : '找不到该工作区')
    const key = workspaceKey(matches[0]!)
    const entries = this.audit.list().filter((entry) => typeof entry.details?.workspace === 'string' && workspaceKey(String(entry.details.workspace)) === key).slice(0, 10)
    return entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toLocaleString('zh-CN')}  ${entry.message}`).join('\n') : '该工作区暂无审计活动。'
  }

  private recentAudit(): string {
    const entries = this.audit.list().slice(0, 10)
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
