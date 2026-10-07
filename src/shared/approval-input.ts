import type { ApprovalInputIssue } from './manager-api'

// Complete command transport and local assessment share a character limit.
// Display summaries and learned allow rules deliberately keep smaller limits.
export const MAX_APPROVAL_COMMAND_LENGTH = 128 * 1024
export const MAX_APPROVAL_PATH_LENGTH = 4096
export const MAX_APPROVAL_TARGET_PATHS = 100

const ISSUE_CODES: ApprovalInputIssue['code'][] = ['declared-truncation', 'command-too-long', 'invalid-command', 'invalid-command-arguments', 'invalid-path', 'path-too-long', 'too-many-paths', 'invalid-input']
const ISSUE_FIELDS: ApprovalInputIssue['field'][] = ['command', 'cmd', 'script', 'file_path', 'notebook_path', 'path', 'file_paths', 'paths', 'toolInput', 'filePath', 'targetPaths']

/** Pick only known scalar fields at transport boundaries. */
export function normalizeApprovalInputIssue(value: unknown): ApprovalInputIssue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const issue = value as Record<string, unknown>
  if (!ISSUE_CODES.includes(issue.code as ApprovalInputIssue['code']) || !ISSUE_FIELDS.includes(issue.field as ApprovalInputIssue['field'])) return undefined
  return {
    code: issue.code as ApprovalInputIssue['code'], field: issue.field as ApprovalInputIssue['field'],
    ...(Number.isSafeInteger(issue.actualLength) && (issue.actualLength as number) >= 0 ? { actualLength: issue.actualLength as number } : {}),
    ...(Number.isSafeInteger(issue.limit) && (issue.limit as number) > 0 ? { limit: issue.limit as number } : {}),
  }
}

export function approvalInputIssueFields(value: unknown): { inputIssue?: ApprovalInputIssue } {
  return value === undefined ? {} : { inputIssue: normalizeApprovalInputIssue(value) ?? { code: 'invalid-input', field: 'toolInput' } }
}

/** Size of the static single-quoted argv representation, without allocating it. */
export function approvalCommandArgumentsLength(args: string[]): number {
  let length = Math.max(0, args.length - 1)
  for (const arg of args) {
    length += arg.length + 2
    for (let index = 0; index < arg.length; index++) if (arg[index] === "'") length++
  }
  return length
}
