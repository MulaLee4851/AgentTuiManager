import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LlmSecurityReviewer, parseReviewConclusion, shouldReviewApproval } from '../../electron/llm-security-reviewer'

vi.mock('axios', () => ({ default: { post: vi.fn() } }))

describe('LLM security reviewer policy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies low, medium and high review levels conservatively', () => {
    expect(shouldReviewApproval('low', { risk: 'write' })).toBe(false)
    expect(shouldReviewApproval('low', { risk: 'unknown', dangerRuleId: 'custom-danger' })).toBe(true)
    expect(shouldReviewApproval('medium', { risk: 'write' })).toBe(true)
    expect(shouldReviewApproval('medium', { risk: 'unknown' })).toBe(false)
    expect(shouldReviewApproval('high', { risk: 'unknown' })).toBe(true)
  })

  it('forces human approval when a local hard rule blocked the request', () => {
    const conclusion = parseReviewConclusion({
      verdict: 'allow', riskScore: 8, summary: '模型认为安全',
      reasons: ['目标明确'], hazards: [], assumptions: ['cwd 正确'],
    }, 'review-model', '命中递归删除硬规则', 123)

    expect(conclusion).toMatchObject({ verdict: 'allow', requiresHumanApproval: true, model: 'review-model', reviewedAt: 123 })
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
