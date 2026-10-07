import { describe, expect, it } from 'vitest'
import { approvalReviewLabel } from '../../src/shared/approval-review-label'
import type { ApprovalRequest } from '../../src/shared/manager-api'

describe('approval phase shown to the user', () => {
  const label = (value: Partial<ApprovalRequest>) => approvalReviewLabel(value as ApprovalRequest)
  it('shows legacy non-approval verdicts as denied, separate from a pending or unavailable review', () => {
    expect(approvalReviewLabel()).toBe('Agent 正在等待授权')
    expect(label({ llmReviewStatus: 'pending' })).toBe('LLM 正在审核')
    expect(label({ llmReviewStatus: 'failed' })).toBe('审核不可用，已决定拒绝本次请求')
    for (const verdict of ['manual', 'uncertain', 'allow'] as const) {
      const llmReview = { verdict, requiresHumanApproval: true, riskScore: 40 } as ApprovalRequest['llmReview']
      expect(label({ llmReviewStatus: 'completed', llmReview })).toBe('审核已拒绝，正在处理本次请求')
    }
  })
  it('does not claim the command has executed when a verdict is awaiting delivery', () => {
    const llmReview = { verdict: 'allow', requiresHumanApproval: false } as ApprovalRequest['llmReview']
    expect(label({ llmReviewStatus: 'completed', llmReview })).toBe('审核已批准，等待处理')
    expect(label({ llmReviewStatus: 'completed', llmReview, llmReviewError: 'delivery failed' })).toBe('审核已完成，处理失败')
    expect(label({ llmReviewStatus: 'completed', llmReview: { ...llmReview!, verdict: 'deny' } })).toBe('审核已拒绝，正在处理本次请求')
  })
})
