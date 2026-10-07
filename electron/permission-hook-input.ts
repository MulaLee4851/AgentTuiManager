import type { ApprovalInputIssue } from '../src/shared/manager-api'
import { approvalCommandArgumentsLength, MAX_APPROVAL_COMMAND_LENGTH, MAX_APPROVAL_PATH_LENGTH, MAX_APPROVAL_TARGET_PATHS } from '../src/shared/approval-input'

/** Extraction for the hook transport. The original toolInput is always retained. */
export function boundedHookText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
    ? value
    : undefined
}

function firstField(details: Record<string, unknown> | undefined, names: ApprovalInputIssue['field'][]): { field: ApprovalInputIssue['field']; value: unknown } | undefined {
  if (!details) return undefined
  const field = names.find((name) => Object.prototype.hasOwnProperty.call(details, name))
  return field ? { field, value: details[field] } : undefined
}

export function permissionHookFields(details: Record<string, unknown> | undefined): {
  command?: string
  filePath?: string
  targetPaths?: string[]
  inputTruncated?: true
  inputIssue?: ApprovalInputIssue
} {
  let inputIssue: ApprovalInputIssue | undefined
  const issue = (code: ApprovalInputIssue['code'], field: ApprovalInputIssue['field'], actualLength?: number, limit?: number): void => {
    inputIssue ??= { code, field, ...(actualLength !== undefined ? { actualLength } : {}), ...(limit !== undefined ? { limit } : {}) }
  }
  if (details?.truncated === true || details?.input_truncated === true || details?.command_truncated === true) {
    issue('declared-truncation', details?.command_truncated === true ? 'command' : 'toolInput')
  }
  let command: string | undefined
  const commandInput = firstField(details, ['command', 'cmd', 'script'])
  if (commandInput) {
    const { field, value } = commandInput
    if (Array.isArray(value)) {
      if (!value.length || value.some((part) => typeof part !== 'string' || part.includes('\0')) || !value[0]?.trim()) {
        issue('invalid-command-arguments', field)
      } else {
        // Do not join argv into a shell string: argument boundaries matter.
        const length = approvalCommandArgumentsLength(value)
        if (length > MAX_APPROVAL_COMMAND_LENGTH) issue('command-too-long', field, length, MAX_APPROVAL_COMMAND_LENGTH)
      }
    } else if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      issue('invalid-command', field)
    } else if (value.length > MAX_APPROVAL_COMMAND_LENGTH) {
      issue('command-too-long', field, value.length, MAX_APPROVAL_COMMAND_LENGTH)
    } else {
      command = value
    }
  }
  const pathInput = firstField(details, ['file_path', 'notebook_path', 'path', 'filePath'])
  let filePath: string | undefined
  if (pathInput) {
    const { field, value } = pathInput
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) issue('invalid-path', field)
    else if (value.length > MAX_APPROVAL_PATH_LENGTH) issue('path-too-long', field, value.length, MAX_APPROVAL_PATH_LENGTH)
    else filePath = value
  }
  const pathsInput = firstField(details, ['file_paths', 'paths', 'targetPaths'])
  let targetPaths: string[] | undefined
  if (pathsInput) {
    const { field, value } = pathsInput
    if (!Array.isArray(value)) issue('invalid-path', field)
    else if (value.length > MAX_APPROVAL_TARGET_PATHS) issue('too-many-paths', field, value.length, MAX_APPROVAL_TARGET_PATHS)
    else if (value.some((path) => typeof path !== 'string' || !path.trim() || path.includes('\0'))) issue('invalid-path', field)
    else {
      const tooLong = value.find((path: string) => path.length > MAX_APPROVAL_PATH_LENGTH)
      if (tooLong !== undefined) issue('path-too-long', field, tooLong.length, MAX_APPROVAL_PATH_LENGTH)
      else targetPaths = [...value] as string[]
    }
  }
  return {
    ...(command !== undefined ? { command } : {}),
    ...(filePath ? { filePath } : {}),
    ...(targetPaths?.length ? { targetPaths } : {}),
    // Old clients still fail closed; current clients use the precise safe issue.
    ...(inputIssue ? { inputTruncated: true as const, inputIssue } : {}),
  }
}
