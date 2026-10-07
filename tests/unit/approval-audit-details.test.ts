import { describe, expect, it } from 'vitest'
import { approvalAuditDetails } from '../../electron/approval-audit-details'
import type { ApprovalRequest } from '../../src/shared/manager-api'

describe('bounded approval audit metadata', () => {
  it('keeps routine commands and explicitly omits long payloads without mutating the request', () => {
    expect(approvalAuditDetails({ command: 'npm test' })).toEqual({ command: 'npm test', commandLength: 8 })
    const request = { command: 'x'.repeat(20_000) }
    expect(approvalAuditDetails(request)).toMatchObject({ commandLength: 20_000, commandOmitted: true })
    expect(approvalAuditDetails(request).command).not.toContain('x'.repeat(100))
    expect(request.command).toHaveLength(20_000)
  })
  it('records only safe input diagnostics and never copies extra payload properties', () => {
    const inputIssue = { code: 'command-too-long', field: 'command', actualLength: 131073, limit: 131072,
      message: 'fictional-secret', command: 'private-body' } as ApprovalRequest['inputIssue']
    expect(approvalAuditDetails({ inputIssue })).toEqual({ inputIssueCode: 'command-too-long', inputIssueField: 'command', inputActualLength: 131073, inputLimit: 131072 })
    expect(approvalAuditDetails({ inputIssue: { code: 'fictional-secret' } as unknown as ApprovalRequest['inputIssue'] })).toEqual({})
  })
})
