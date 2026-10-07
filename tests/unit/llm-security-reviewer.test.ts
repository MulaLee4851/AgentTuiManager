import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LlmSecurityReviewer, parseReviewConclusion, shouldReviewApproval } from '../../electron/llm-security-reviewer'
import { CliSecurityReviewer } from '../../electron/cli-security-reviewer'
import type { ApprovalRequest } from '../../src/shared/manager-api'
import type { StoredLlmReviewSettings } from '../../electron/llm-review-settings-store'

vi.mock('axios', () => ({ default: { post: vi.fn(), isAxiosError: (value: unknown) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError) } }))

const settings: StoredLlmReviewSettings = {
  enabled: true, level: 'high', baseUrl: 'https://model.example/v1', apiKey: 'secret', model: 'security-model',
  retryCount: 0, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
  proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
}
const request: ApprovalRequest = {
  requestId: 'r1', sessionId: 's1', displayName: 'test', agentKind: 'codex', workspace: '/workspace',
  source: 'codex-hook', risk: 'delete', reason: 'recursive deletion', createdAt: 1, canBulkApprove: false,
  hookCwd: '/workspace/build', command: 'Remove-Item -LiteralPath ./cache -Recurse',
  toolInput: { command: 'Remove-Item -LiteralPath ./cache -Recurse', cwd: '/workspace/build', env: { API_KEY: 'do-not-send' } },
}
const allowed = { verdict: 'allow', riskScore: 8, summary: '允许清理明确的缓存目录', reasons: ['目标已核对'], hazards: [], assumptions: [] }

describe('LLM security reviewer policy', () => {
  beforeEach(() => vi.clearAllMocks())
  it('uses the same root endpoint convention as model discovery and blocks redirects', async () => {
    vi.mocked(axios.post).mockResolvedValue({data:{choices:[{message:{content:JSON.stringify(allowed)}}]}})
    await new LlmSecurityReviewer().reviewApproval(request,{...settings,baseUrl:'https://model.example'})
    expect(axios.post).toHaveBeenCalledWith('https://model.example/v1/chat/completions',expect.anything(),expect.objectContaining({maxRedirects:0}))
  })
  it('only reports missing field names and never exposes an upstream error containing credentials', async () => {
    await expect(new LlmSecurityReviewer().reviewApproval(request,{...settings,model:''})).rejects.toThrow('缺少 Model')
    vi.mocked(axios.post).mockRejectedValue({isAxiosError:true,message:'secret in upstream body',response:{status:401,data:'secret'},config:{headers:{Authorization:'Bearer secret'}}})
    try {await new LlmSecurityReviewer().reviewApproval(request,settings);throw Error('Expected failure')}
    catch(error){expect(String(error)).toContain('身份验证');expect(String(error)).not.toContain('secret');expect(error).not.toHaveProperty('config')}
  })
  it('does not publish a model response that echoes the API key', async () => {
    vi.mocked(axios.post).mockResolvedValue({data:{choices:[{message:{content:JSON.stringify({...allowed,summary:'secret'})}}]}})
    await expect(new LlmSecurityReviewer().reviewApproval(request,settings)).rejects.not.toThrow('secret')
  })

  it('applies low, medium and high review levels conservatively', () => {
    expect(shouldReviewApproval('low', { risk: 'write' })).toBe(false)
    expect(shouldReviewApproval('low', { risk: 'unknown', dangerRuleId: 'custom-danger' })).toBe(true)
    expect(shouldReviewApproval('medium', { risk: 'write' })).toBe(true)
    expect(shouldReviewApproval('medium', { risk: 'unknown' })).toBe(false)
    expect(shouldReviewApproval('high', { risk: 'unknown' })).toBe(true)
  })

  it('allows the independent reviewer to approve a locally flagged high-risk request', () => {
    const conclusion = parseReviewConclusion({
      verdict: 'allow', riskScore: 8, summary: '模型认为安全',
      reasons: ['目标明确'], hazards: [], assumptions: ['cwd 正确'],
    }, 'review-model', '命中递归删除硬规则', 123)

    expect(conclusion).toMatchObject({ verdict: 'allow', requiresHumanApproval: false, model: 'review-model', reviewedAt: 123 })
  })

  it.each(['manual', 'uncertain'])('normalizes a legacy %s verdict into a final denial', verdict => {
    expect(parseReviewConclusion({ ...allowed, verdict }, 'model')).toMatchObject({ verdict: 'deny', requiresHumanApproval: false })
  })

  it('keeps a denial as a machine decision without requesting human approval', () => {
    expect(parseReviewConclusion({ ...allowed, verdict: 'deny' }, 'model')).toMatchObject({ verdict: 'deny', requiresHumanApproval: false })
  })

  it('blocks JSON-escaped credential echoes in both command reviews and rule audits', async () => {
    const escaped = '\\u0073ecret'
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { choices: [{ message: { content: JSON.stringify({ ...allowed, summary: 'PLACEHOLDER' }).replace('PLACEHOLDER', escaped) } }] } })
    await expect(new LlmSecurityReviewer().reviewApproval(request, settings)).rejects.toThrow('受保护凭据')
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { choices: [{ message: { content: '{"summary":"' + escaped + '","findings":[]}' } }] } })
    await expect(new LlmSecurityReviewer().reviewRuleSet([], [], [], settings)).rejects.toThrow('受保护凭据')
  })

  it('sends the real hook cwd, selected tool arguments and local risk evidence to the API', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(allowed) } }] } })
    const signal = new AbortController().signal
    const result = await new LlmSecurityReviewer().reviewApproval(request, settings, '本地递归删除提示', signal)
    const [, body, config] = vi.mocked(axios.post).mock.calls[0]!
    const payload = JSON.parse((body as { messages: Array<{ content: string }> }).messages[1]!.content)
    expect(payload).toMatchObject({ cwd: '/workspace/build', localRiskReason: '本地递归删除提示', toolInput: { cwd: '/workspace/build' } })
    expect(payload.toolInput).not.toHaveProperty('env')
    expect(payload).not.toHaveProperty('hardBlockedReason')
    expect(config?.signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(result.requiresHumanApproval).toBe(false)
  })

  it('routes a CLI approval and rule audit without requiring API credentials', async () => {
    const cli = new CliSecurityReviewer()
    const complete = vi.spyOn(cli, 'complete').mockResolvedValueOnce(JSON.stringify(allowed)).mockResolvedValueOnce(JSON.stringify({ summary: 'ok', findings: [] }))
    const reviewer = new LlmSecurityReviewer(cli)
    const cliSettings = { ...settings, backend: 'codex-cli' as const, cliModel: 'test-model', baseUrl: undefined, apiKey: undefined, model: undefined }
    const result = await reviewer.reviewApproval(request, cliSettings, 'high risk')
    expect(result).toMatchObject({ model: 'codex-cli:test-model', verdict: 'allow', requiresHumanApproval: false })
    expect(complete.mock.calls[0]?.[4]).toBe('/workspace')
    await reviewer.reviewRuleSet([], [], [], cliSettings)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('does not send an already cancelled API request and discards an in-flight result', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new LlmSecurityReviewer().reviewApproval(request, settings, undefined, controller.signal)).rejects.toThrow('取消')
    expect(axios.post).not.toHaveBeenCalled()
    const second = new AbortController()
    vi.mocked(axios.post).mockImplementation(async () => {
      second.abort()
      return { data: { choices: [{ message: { content: JSON.stringify(allowed) } }] } }
    })
    await expect(new LlmSecurityReviewer().reviewApproval(request, settings, undefined, second.signal)).rejects.toThrow('取消')
  })

  it('rejects oversized tool context rather than silently dropping dangerous suffixes', async () => {
    await expect(new LlmSecurityReviewer().reviewApproval({ ...request, toolInput: { command: 'x'.repeat(140_000) } }, settings)).rejects.toThrow('大小限制')
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('rejects malformed or overconfident model output', () => {
    expect(() => parseReviewConclusion({ verdict: 'allow', riskScore: 101, summary: 'ok', reasons: [], hazards: [], assumptions: [] }, 'model')).toThrow('riskScore')
    expect(() => parseReviewConclusion({ verdict: 'safe', riskScore: 1, summary: 'ok', reasons: [], hazards: [], assumptions: [] }, 'model')).toThrow('verdict')
  })

  it('uses the user-configured timeout for rule audits', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { choices: [{ message: { content: JSON.stringify({ summary: '未发现问题', findings: [] }) } }] },
    })
    const reviewer = new LlmSecurityReviewer()
    await reviewer.reviewRuleSet([], [], [], {
      enabled: true, level: 'high', baseUrl: 'https://model.example/v1', apiKey: 'secret', model: 'security-model',
      retryCount: 0, timeoutSeconds: 90,
      scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
      proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
    })

    expect(axios.post).toHaveBeenCalledWith(
      'https://model.example/v1/chat/completions',
      expect.any(Object),
      expect.objectContaining({ timeout: 90_000 }),
    )
  })
})
