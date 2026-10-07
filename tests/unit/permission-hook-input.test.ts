import { describe, expect, it } from 'vitest'

import { permissionHookFields } from '../../electron/permission-hook-input'
import { approvalCommandArgumentsLength, approvalInputIssueFields, MAX_APPROVAL_COMMAND_LENGTH, normalizeApprovalInputIssue } from '../../src/shared/approval-input'

describe('permission hook input extraction', () => {
  it('retains full raw multiline commands through the common 128Ki-character limit', () => {
    const command = 'python -c "\n' + '# package diagnostics\n'.repeat(150) + 'print(1)\n"'
    expect(command.length).toBeGreaterThan(2048)
    expect(permissionHookFields({ command })).toEqual({ command })
    const maximum = 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH)
    expect(permissionHookFields({ command: maximum })).toEqual({ command: maximum })
    expect(permissionHookFields({ command: maximum + 'x' })).toEqual({ inputTruncated: true,
      inputIssue: { code: 'command-too-long', field: 'command', actualLength: MAX_APPROVAL_COMMAND_LENGTH + 1, limit: MAX_APPROVAL_COMMAND_LENGTH } })
  })

  it.each([null, 42, '', ' ', 'echo \0bad', [], ['pwsh', null, '-Command', 'Get-Location'], ['pwd', 42], ['', 'argument']])(
    'marks invalid command input incomplete without keeping a filtered subset: %j', (command) => {
      expect(permissionHookFields({ command })).toEqual({ inputTruncated: true,
        inputIssue: { code: Array.isArray(command) ? 'invalid-command-arguments' : 'invalid-command', field: 'command' } })
    },
  )

  it('keeps valid argv boundaries in toolInput instead of inventing a shell command', () => {
    expect(permissionHookFields({ command: ['pwsh', '-Command', "Get-Location\nWrite-Output 'two words'"] })).toEqual({})
    expect(permissionHookFields({ command: ['python', '-c', '# diagnostic\n'.repeat(400) + '\nprint(1)', ''] })).toEqual({})
    const args = ['python', '-c', 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH)]
    expect(permissionHookFields({ command: args })).toEqual({ inputTruncated: true,
      inputIssue: { code: 'command-too-long', field: 'command', actualLength: approvalCommandArgumentsLength(args), limit: MAX_APPROVAL_COMMAND_LENGTH } })
  })

  it('never filters invalid target paths into an apparently complete operation', () => {
    expect(permissionHookFields({ paths: ['C:\\safe', null, 'D:\\other'] })).toEqual({ inputTruncated: true, inputIssue: { code: 'invalid-path', field: 'paths' } })
    expect(permissionHookFields({ paths: ['C:\\safe', 'D:\\other'] })).toEqual({ targetPaths: ['C:\\safe', 'D:\\other'] })
    expect(permissionHookFields({ path: 'x'.repeat(4097) })).toEqual({ inputTruncated: true,
      inputIssue: { code: 'path-too-long', field: 'path', actualLength: 4097, limit: 4096 } })
    expect(permissionHookFields({ paths: Array.from({ length: 101 }, (_, index) => 'path-' + index) })).toEqual({ inputTruncated: true,
      inputIssue: { code: 'too-many-paths', field: 'paths', actualLength: 101, limit: 100 } })
  })

  it('uses the escaped argv representation for the exact shared boundary', () => {
    const args = ['echo', "'".repeat(2000), '']
    args[2] = 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH - approvalCommandArgumentsLength(args))
    expect(permissionHookFields({ cmd: args })).toEqual({})
    args[2] += 'x'
    expect(permissionHookFields({ cmd: args }).inputIssue).toEqual({ code: 'command-too-long', field: 'cmd', actualLength: MAX_APPROVAL_COMMAND_LENGTH + 1, limit: MAX_APPROVAL_COMMAND_LENGTH })
  })

  it('distinguishes declared truncation from invalid input and complete oversize input', () => {
    expect(permissionHookFields({ command: 'echo ok', command_truncated: true })).toEqual({ command: 'echo ok', inputTruncated: true, inputIssue: { code: 'declared-truncation', field: 'command' } })
    expect(permissionHookFields({ script: 'echo ok', truncated: true }).inputIssue).toEqual({ code: 'declared-truncation', field: 'toolInput' })
    expect(permissionHookFields({ script: null }).inputIssue).toEqual({ code: 'invalid-command', field: 'script' })
  })

  it('allows only known diagnostic labels and safe scalar lengths across transport', () => {
    const secret = 'fixture-private-value'
    expect(normalizeApprovalInputIssue({ code: 'command-too-long', field: 'command', actualLength: 140000, limit: 131072, message: secret, payload: { key: secret } })).toEqual({ code: 'command-too-long', field: 'command', actualLength: 140000, limit: 131072 })
    expect(approvalInputIssueFields({ code: secret, field: secret })).toEqual({ inputIssue: { code: 'invalid-input', field: 'toolInput' } })
    expect(normalizeApprovalInputIssue({ code: 'invalid-command', field: 'command', actualLength: secret, limit: Infinity })).toEqual({ code: 'invalid-command', field: 'command' })
    expect(approvalInputIssueFields(undefined)).toEqual({})
  })
})
