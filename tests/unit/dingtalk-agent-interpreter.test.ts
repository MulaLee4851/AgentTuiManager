import { describe, expect, it, vi } from 'vitest'

import { commandFromAgentResponse, commandsFromAgentResponse, withAgentRetries } from '../../electron/dingtalk-agent-interpreter'

describe('DingTalkAgentInterpreter output policy', () => {
  it('maps structured actions to the existing fixed command router', () => {
    expect(commandFromAgentResponse({ action: 'agents' })).toBe('/agents')
    expect(commandFromAgentResponse({ action: 'approve', requestId: 'approval-1' })).toBe('/approve approval-1')
    expect(commandFromAgentResponse({ action: 'approve_all_force' })).toBe('/approve-all-force')
    expect(commandFromAgentResponse({ action: 'auto_on', target: 'Code Agent' })).toBe('/auto Code Agent on')
    expect(commandFromAgentResponse({ action: 'auto_off', target: 'session-1' })).toBe('/auto session-1 off')
    expect(commandFromAgentResponse({ action: 'send', target: 'Agent A', content: '继续检查登录问题' })).toBe('/send Agent A 继续检查登录问题')
  })

  it('maps multiple model actions from one natural-language request in order', () => {
    expect(commandsFromAgentResponse({
      actions: [
        { action: 'auto_on', target: '40f5c044' },
        { action: 'auto_off', target: 'Review Agent' },
      ],
    })).toEqual({
      commands: ['/auto 40f5c044 on', '/auto Review Agent off'],
    })
  })

  it('keeps an explicit reason when the model cannot choose an operation', () => {
    expect(commandsFromAgentResponse({
      actions: [{ action: 'help' }],
      reason: '没有找到用户提到的 Agent',
    })).toEqual({
      commands: ['/help'],
      reason: '没有找到用户提到的 Agent',
    })
  })

  it('rejects arbitrary actions and multiline terminal content', () => {
    expect(() => commandFromAgentResponse({ action: 'approve_all' })).toThrow('不受支持')
    expect(() => commandFromAgentResponse({ action: 'shell', content: 'rm -rf /' })).toThrow('不受支持')
    expect(() => commandFromAgentResponse({ action: 'send', target: 'Agent A', content: 'first\nsecond' })).toThrow('不符合发送限制')
  })

  it('retries transient server errors up to the configured count', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 500 } })
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } })
      .mockResolvedValue('ok')
    const delay = vi.fn(async () => undefined)

    await expect(withAgentRetries(operation, 3, delay)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(delay).toHaveBeenNthCalledWith(1, 500)
    expect(delay).toHaveBeenNthCalledWith(2, 1_000)
  })

  it('does not retry non-transient client errors', async () => {
    const error = { isAxiosError: true, response: { status: 400 } }
    const operation = vi.fn(async () => Promise.reject(error))
    const delay = vi.fn(async () => undefined)

    await expect(withAgentRetries(operation, 3, delay)).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })
})
