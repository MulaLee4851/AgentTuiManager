import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotMessage } from 'dingtalk-stream'

import type { DingTalkSettingsSummary } from '../src/shared/manager-api'
import type { ApprovalRequest } from '../src/shared/manager-api'
import type { StoredDingTalkSettings } from './dingtalk-settings-store'
import type { DingTalkCommandRouter } from './dingtalk-command-router'

export interface DingTalkStreamActivityPort {
  connected(): void
  disconnected(): void
  error(message: string): void
  message(staffId: string, command: string): void
}

export class DingTalkStreamService {
  private client: DWClient | undefined
  private status: NonNullable<DingTalkSettingsSummary['connectionStatus']> = 'disabled'
  private connectionError: string | undefined
  private readonly processedMessages = new Map<string, number>()
  private readonly notifiedApprovals = new Map<string, number>()
  private accessTokenValue: string | undefined
  private accessTokenExpiresAt = 0
  private accessTokenClientId: string | undefined

  constructor(
    private readonly router: DingTalkCommandRouter,
    private readonly activity?: DingTalkStreamActivityPort,
  ) {}

  getStatus(): Pick<DingTalkSettingsSummary, 'connectionStatus' | 'connectionError'> {
    return { connectionStatus: this.status, ...(this.connectionError ? { connectionError: this.connectionError } : {}) }
  }

  async restart(settings: StoredDingTalkSettings): Promise<void> {
    this.stop()
    if (!settings.enabled) { this.status = 'disabled'; return }
    if (!settings.clientId || !settings.clientSecret) throw new Error('缺少钉钉 Client ID 或 Client Secret')
    this.status = 'connecting'
    this.connectionError = undefined
    const client = new DWClient({ clientId: settings.clientId, clientSecret: settings.clientSecret, keepAlive: true, debug: false })
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      void this.onRobotMessage(client, message)
    })
    client.on('error', (error: unknown) => this.onError(error))
    client.on('close', () => {
      if (this.client !== client) return
      this.status = 'error'
      this.connectionError = '钉钉 Stream 连接已断开，SDK 正在尝试重连'
      this.activity?.disconnected()
    })
    this.client = client
    try {
      await client.connect()
      if (this.client !== client) { client.disconnect(); return }
      this.status = 'connected'
      this.activity?.connected()
    } catch (error) {
      if (this.client === client) this.onError(error)
      client.disconnect()
      if (this.client === client) this.client = undefined
      throw error
    }
  }

  stop(): void {
    const client = this.client
    this.client = undefined
    if (client) client.disconnect()
    this.status = 'disabled'
    this.connectionError = undefined
  }

  async notifyApproval(request: ApprovalRequest, settings: StoredDingTalkSettings): Promise<boolean> {
    if (!settings.enabled || !settings.clientId || !settings.clientSecret || !settings.boundStaffId) return false
    const allowed = new Set(settings.allowedWorkspaces.map(workspaceKey))
    if (!allowed.has(workspaceKey(request.workspace))) return false
    const now = Date.now()
    for (const [requestId, timestamp] of this.notifiedApprovals) {
      if (now - timestamp > 24 * 60 * 60_000) this.notifiedApprovals.delete(requestId)
    }
    if (this.notifiedApprovals.has(request.requestId)) return false
    this.notifiedApprovals.set(request.requestId, now)
    try {
      const detail = request.command ?? request.inputSummary ?? request.filePath ?? '参数待确认'
      const reason = request.agentReason ?? request.reason
      const content = [
        '【Agent TUI Manager · 待审批】',
        `Agent：${request.displayName}（${request.sessionId.slice(0, 8)}）`,
        `工具：${request.toolName ?? request.agentKind}`,
        `风险：${request.risk}`,
        `工作区：${request.workspace}`,
        `内容：${detail.slice(0, 2_000)}`,
        `原因：${reason.slice(0, 1_000)}`,
        `审批 ID：${request.requestId}`,
        '',
        `批准：/approve ${request.requestId}`,
        '查看全部：/pending',
      ].join('\n')
      await this.sendProactiveText(settings, content)
      return true
    } catch (error) {
      this.notifiedApprovals.delete(request.requestId)
      throw error
    }
  }

  private async onRobotMessage(client: DWClient, message: DWClientDownStream): Promise<void> {
    const now = Date.now()
    for (const [messageId, timestamp] of this.processedMessages) {
      if (now - timestamp > 10 * 60_000) this.processedMessages.delete(messageId)
    }
    if (this.processedMessages.has(message.headers.messageId)) {
      client.socketCallBackResponse(message.headers.messageId, { status: 'SUCCESS' })
      return
    }
    this.processedMessages.set(message.headers.messageId, now)

    let robot: RobotMessage
    try { robot = JSON.parse(message.data) as RobotMessage }
    catch { return }
    const content = robot.msgtype === 'text' && typeof robot.text?.content === 'string' ? robot.text.content.trim() : ''
    if (typeof robot.senderStaffId !== 'string' || !robot.senderStaffId || typeof robot.sessionWebhook !== 'string') return
    this.activity?.message(robot.senderStaffId, content.split(/\s/, 1)[0] ?? '')
    const reply = await this.router.execute(content, { staffId: robot.senderStaffId, senderName: robot.senderNick })
    await this.reply(robot.sessionWebhook, reply).catch((error) => this.onError(error))
    client.socketCallBackResponse(message.headers.messageId, { status: 'SUCCESS' })
  }

  private async reply(sessionWebhook: string, text: string): Promise<void> {
    const url = new URL(sessionWebhook)
    if (url.protocol !== 'https:' || !/(?:^|\.)dingtalk\.com$/i.test(url.hostname)) throw new Error('拒绝非钉钉官方回复地址')
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 18_000) } }),
    })
    if (!response.ok) throw new Error(`钉钉回复失败（HTTP ${response.status}）`)
  }

  private async sendProactiveText(settings: StoredDingTalkSettings, content: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const accessToken = await this.accessToken(settings)
        const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-acs-dingtalk-access-token': accessToken,
          },
          body: JSON.stringify({
            robotCode: settings.clientId,
            userIds: [settings.boundStaffId],
            msgKey: 'sampleText',
            msgParam: JSON.stringify({ content: content.slice(0, 18_000) }),
          }),
        })
        if (response.ok) return
        if (response.status === 401) this.clearAccessToken()
        const error = new Error(`钉钉主动提醒失败（HTTP ${response.status}）`)
        if (response.status < 500 && response.status !== 401 && response.status !== 408 && response.status !== 429) throw error
        lastError = error
      } catch (error) {
        lastError = error
      }
      if (attempt < 2) await retryDelay(500 * (attempt + 1))
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '钉钉主动提醒失败'))
  }

  private async accessToken(settings: StoredDingTalkSettings): Promise<string> {
    const now = Date.now()
    if (this.accessTokenValue && this.accessTokenClientId === settings.clientId && now < this.accessTokenExpiresAt) return this.accessTokenValue
    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ appKey: settings.clientId, appSecret: settings.clientSecret }),
    })
    if (!response.ok) throw new Error(`获取钉钉访问令牌失败（HTTP ${response.status}）`)
    const body = await response.json() as { accessToken?: unknown; expireIn?: unknown }
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('钉钉访问令牌响应无效')
    const expireSeconds = typeof body.expireIn === 'number' && body.expireIn > 120 ? body.expireIn : 7_200
    this.accessTokenValue = body.accessToken
    this.accessTokenClientId = settings.clientId
    this.accessTokenExpiresAt = now + (expireSeconds - 60) * 1_000
    return body.accessToken
  }

  private clearAccessToken(): void {
    this.accessTokenValue = undefined
    this.accessTokenClientId = undefined
    this.accessTokenExpiresAt = 0
  }

  private onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.status = 'error'
    this.connectionError = message.slice(0, 500)
    this.activity?.error(this.connectionError)
  }
}

function workspaceKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase('en-US')
}

function retryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}
