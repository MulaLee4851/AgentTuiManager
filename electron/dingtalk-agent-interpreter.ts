import axios from 'axios'

import type { ApprovalRequest, SessionSummary } from '../src/shared/manager-api'
import type { StoredDingTalkSettings } from './dingtalk-settings-store'

export interface DingTalkAgentSnapshot { sessions: SessionSummary[]; approvals: ApprovalRequest[] }

const ACTIONS = new Set(['help', 'agents', 'pending', 'approve', 'approve_all', 'status', 'tail', 'workspace', 'send', 'stop', 'restart', 'audit'])
const BASE_RETRY_DELAY_MS = 500

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

export function isRetryableAgentError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  if (!error.response) return true
  const status = error.response.status
  return status === 408 || status === 429 || status >= 500
}

export async function withAgentRetries<T>(
  operation: () => Promise<T>,
  retryCount: number,
  delay: (milliseconds: number) => Promise<void> = wait,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= retryCount || !isRetryableAgentError(error)) throw error
      await delay(BASE_RETRY_DELAY_MS * (attempt + 1))
    }
  }
}

function endpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/+$/g, '')
  return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`
}

export function commandFromAgentResponse(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('模型没有返回有效操作')
  const object = value as Record<string, unknown>
  const action = typeof object.action === 'string' ? object.action : ''
  if (!ACTIONS.has(action)) throw new Error('模型返回了不受支持的操作')
  const target = typeof object.target === 'string' ? object.target.trim() : ''
  const content = typeof object.content === 'string' ? object.content.trim() : ''
  const requestId = typeof object.requestId === 'string' ? object.requestId.trim() : ''
  switch (action) {
    case 'help': return '/help'
    case 'agents': return '/agents'
    case 'pending': return '/pending'
    case 'approve': if (!requestId) throw new Error('模型未指定审批 ID'); return `/approve ${requestId}`
    case 'approve_all': return '/approve-all'
    case 'status': case 'tail': case 'workspace': case 'stop': case 'restart':
      if (!target) throw new Error('模型未指定目标'); return `/${action} ${target}`
    case 'send':
      if (!target || !content) throw new Error('模型未指定 Agent 或消息内容')
      if (content.includes('\r') || content.includes('\n') || content.includes('\0') || content.length > 4_000) throw new Error('模型生成的消息不符合发送限制')
      return `/send ${target} ${content}`
    case 'audit': return '/audit'
    default: throw new Error('不受支持的操作')
  }
}

export class DingTalkAgentInterpreter {
  async translate(input: string, settings: StoredDingTalkSettings, snapshot: DingTalkAgentSnapshot): Promise<string> {
    if (!settings.agentBaseUrl || !settings.agentApiKey || !settings.agentModel) throw new Error('Agent 模式配置不完整')
    const request = () => axios.post(endpoint(settings.agentBaseUrl!), {
      model: settings.agentModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是 Agent TUI Manager 的远程操作转换器。只返回一个 JSON 对象，不要解释。字段：action（help|agents|pending|approve|approve_all|status|tail|workspace|send|stop|restart|audit），可选 target、content、requestId。只能选择一个动作，禁止生成 shell 命令、路径写入或未列出的动作。用户意图不明确时返回 {"action":"help"}。' },
        { role: 'user', content: JSON.stringify({ request: input, agents: snapshot.sessions.map((item) => ({ id: item.sessionId.slice(0, 8), name: item.displayName, status: item.status, workspace: item.workspace })), pending: snapshot.approvals.map((item) => ({ requestId: item.requestId, agent: item.displayName, tool: item.toolName, risk: item.risk })) }) },
      ],
    }, {
      timeout: 30_000,
      headers: { Authorization: `Bearer ${settings.agentApiKey}`, 'content-type': 'application/json' },
      proxy: settings.agentProxyEnabled ? {
        protocol: 'http', host: settings.agentProxyHost, port: settings.agentProxyPort,
        ...(settings.agentProxyUsername ? { auth: { username: settings.agentProxyUsername, password: settings.agentProxyPassword ?? '' } } : {}),
      } : false,
      maxContentLength: 256 * 1024,
    })
    const response = await withAgentRetries(request, settings.agentRetryCount)
    const content = response.data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length > 20_000) throw new Error('模型响应格式无效')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { throw new Error('模型没有返回合法 JSON') }
    return commandFromAgentResponse(parsed)
  }
}
