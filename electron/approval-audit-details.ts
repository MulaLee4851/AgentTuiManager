import type { ApprovalRequest } from '../src/shared/manager-api'
import { normalizeApprovalInputIssue } from '../src/shared/approval-input'

/** Audit previews are bounded independently of the intact request used for approval. */
export function approvalAuditDetails(request: Pick<ApprovalRequest, 'command' | 'inputIssue'>): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = {}
  if (request.command) {
    details.commandLength = request.command.length
    if (request.command.length <= 16_384) details.command = request.command
    else {
      details.command = '[完整命令较长，审计省略正文；审批使用原始请求]'
      details.commandOmitted = true
    }
  }
  const issue = normalizeApprovalInputIssue(request.inputIssue)
  if (issue) {
    details.inputIssueCode = issue.code; details.inputIssueField = issue.field
    if (issue.actualLength !== undefined) details.inputActualLength = issue.actualLength
    if (issue.limit !== undefined) details.inputLimit = issue.limit
  }
  return details
}
