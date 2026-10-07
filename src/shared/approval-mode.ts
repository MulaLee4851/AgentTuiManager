import type { ApprovalMode, SessionSummary } from './manager-api'

export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'agent-review', 'rules-auto', 'unattended']
export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  manual: '普通模式',
  'agent-review': 'Agent 审核',
  'rules-auto': '规则自动',
  unattended: '无监管',
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && APPROVAL_MODES.includes(value as ApprovalMode)
}

/** Compatibility is centralized; only the explicit mode is used for new sessions. */
export function approvalModeOf(session: Pick<SessionSummary, 'approvalMode' | 'fullAutoEnabled' | 'unattended'>, legacyReviewEnabled = false): ApprovalMode {
  if (isApprovalMode(session.approvalMode)) return session.approvalMode
  if (session.unattended?.enabled) return 'unattended'
  return session.fullAutoEnabled ? (legacyReviewEnabled ? 'agent-review' : 'rules-auto') : 'manual'
}
