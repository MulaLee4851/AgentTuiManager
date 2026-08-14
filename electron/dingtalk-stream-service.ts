import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotMessage } from 'dingtalk-stream'

import type { DingTalkSettingsSummary } from '../src/shared/manager-api'
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

  private onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.status = 'error'
    this.connectionError = message.slice(0, 500)
    this.activity?.error(this.connectionError)
  }
}
