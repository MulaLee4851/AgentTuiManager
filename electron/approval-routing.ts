import type { ApprovalMode } from '../src/shared/manager-api'
import type { LocalApprovalAssessment } from './approval-policy'

export type ApprovalRoute = 'manual' | 'approve' | 'reject' | 'review'

export function routeApproval(mode: ApprovalMode, assessment: LocalApprovalAssessment): ApprovalRoute {
  if (mode === 'manual') return 'manual'
  if (mode === 'unattended') return 'approve'
  if (assessment.status === 'incomplete') return 'reject'
  if (assessment.status === 'ordinary') return 'approve'
  return mode === 'agent-review' ? 'review' : 'reject'
}
