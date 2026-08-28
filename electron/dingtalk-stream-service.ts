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

export function isDingTalkWorkspaceAllowed(settings: Pick<StoredDingTalkSettings, 'allowedWorkspaces' | 'knownWorkspaces'>, workspace: string): boolean {
  const allowed = new Set(settings.allowedWorkspaces.map(workspaceKey))
  const key = workspaceKey(workspace)
  if (allowed.has(key)) return true
  // Newly discovered workspaces are default-on in the settings UI. Until the
  // user saves an explicit opt-out, keep remote approval notifications aligned
  // with that visible checked state.
  const known = settings.knownWorkspaces
  return Array.isArray(known) && !known.some((item) => workspaceKey(item) === key)
}

type RuntimeDingTalkClient = DWClient & {
  connected: boolean
  config: { autoReconnect?: boolean }
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

  private reconnectTimer: NodeJS.Timeout | undefined
  private monitorTimer: NodeJS.Timeout | undefined
  private reconnectAttempt = 0
  private outageNotified = false
  constructor(
    private readonly router: DingTalkCommandRouter,
    private readonly activity?: DingTalkStreamActivityPort,
    private readonly networkAvailable?: () => boolean,
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
    const client = new DWClient({ clientId: settings.clientId, clientSecret: settings.clientSecret, keepAlive: false, debug: false })
    const runtimeClient = client as RuntimeDingTalkClient
    runtimeClient.config.autoReconnect = false
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      void this.onRobotMessage(client, message)
    })
    client.on('error', (error: unknown) => this.markDisconnected(client, error))
    client.on('close', () => {
      this.markDisconnected(client)
      this.scheduleReconnect(client)
    })
    this.client = client
    this.startMonitor(client)
    await this.connectClient(client)
  }

  stop(): void {
    const client = this.client
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.reconnectTimer = undefined
    this.monitorTimer = undefined
    this.client = undefined
    if (client) client.disconnect()
    this.status = 'disabled'
    this.connectionError = undefined
    this.reconnectAttempt = 0
    this.outageNotified = false
  }

  async notifyApproval(request: ApprovalRequest, settings: StoredDingTalkSettings): Promise<boolean> {
    if (!settings.enabled || !settings.clientId || !settings.clientSecret || !settings.boundStaffId) return false
    if (!isDingTalkWorkspaceAllowed(settings, request.workspace)) return false
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
    await this.reply(robot.sessionWebhook, reply).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.activity?.error(message.slice(0, 500))
    })
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

  private startMonitor(client: DWClient): void {
    this.monitorTimer = setInterval(() => {
      if (this.client !== client) return
      const connected = (client as RuntimeDingTalkClient).connected
      if (connected) {
        if (this.status !== 'connected') this.markConnected(client)
        return
      }
      if (this.status === 'connected') this.markDisconnected(client)
      this.scheduleReconnect(client)
    }, 2_000)
    this.monitorTimer.unref()
  }

  private async connectClient(client: DWClient): Promise<void> {
    if (this.client !== client) return
    if (this.networkAvailable && !this.networkAvailable()) {
      this.markDisconnected(client)
      this.scheduleReconnect(client, true)
      return
    }

    this.status = 'connecting'
    try {
      await client.connect()
    } catch (error) {
      if (this.client !== client) return
      this.markDisconnected(client, error)
      this.scheduleReconnect(client)
      return
    }
    if (this.client !== client) {
      client.disconnect()
      return
    }
    if ((client as RuntimeDingTalkClient).connected) {
      this.markConnected(client)
    } else {
      this.markDisconnected(client)
      this.scheduleReconnect(client)
    }
  }

  private markConnected(client: DWClient): void {
    if (this.client !== client) return
    const changed = this.status !== 'connected' || this.outageNotified
    this.status = 'connected'
    this.connectionError = undefined
    this.reconnectAttempt = 0
    this.outageNotified = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    if (changed) this.activity?.connected()
  }

  private markDisconnected(client: DWClient, error?: unknown): void {
    if (this.client !== client) return
    const firstNotice = !this.outageNotified
    this.status = 'error'
    this.connectionError = '钉钉 Stream 暂时离线，网络恢复后会自动重连'
    this.outageNotified = true
    if (!firstNotice) return
    this.activity?.disconnected()
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      this.activity?.error(message.slice(0, 500))
    }
  }

  private scheduleReconnect(client: DWClient, waitingForNetwork = false): void {
    if (this.client !== client || this.reconnectTimer) return
    const delays = [3_000, 5_000, 10_000, 30_000]
    const delay = waitingForNetwork ? 3_000 : delays[Math.min(this.reconnectAttempt, delays.length - 1)]!
    if (!waitingForNetwork) this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.client === client) void this.connectClient(client)
    }, delay)
    this.reconnectTimer.unref()
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
