import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { unlink } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { assessApprovalRequest } from '../../electron/approval-policy'
import { MAX_APPROVAL_COMMAND_LENGTH, normalizeApprovalInputIssue } from '../../src/shared/approval-input'

type Hook = 'codex' | 'claude'
type Response = 'deny-reason' | 'wrong-id' | 'disconnect' | 'oversized' | 'output-before-allow' | 'fragmented-allow'

async function exchange(hook: Hook, toolInput: unknown, response: Response = 'deny-reason') {
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\agent-tui-hook-integrity-' + randomUUID()
    : join(tmpdir(), 'agent-tui-hook-integrity-' + randomUUID() + '.sock')
  let peer: net.Socket | undefined
  let received: Record<string, unknown> | undefined
  const server = net.createServer((socket) => {
    peer = socket
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0 || received) return
      received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      if (response === 'disconnect') { socket.end(); return }
      if (response === 'oversized') { socket.write('x'.repeat(65_537)); return }
      const event = JSON.stringify({
        type: 'permission-response',
        requestId: response === 'wrong-id' ? 'different-request' : received.requestId,
        action: response === 'deny-reason' ? 'deny' : 'allow',
        reason: '命中递归删除规则，目标目录超出工作区',
      }) + '\n'
      if (response === 'output-before-allow') socket.write(JSON.stringify({ type: 'output', data: 'ordinary repaint' }) + '\n')
      if (response === 'fragmented-allow') {
        socket.write(event.slice(0, 17))
        setTimeout(() => { if (!socket.destroyed) socket.write(event.slice(17)) }, 10)
      } else socket.write(event)
    })
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(endpoint, done)
  })
  const child = spawn(process.execPath, [resolve('dist-electron/' + hook + '-permission-hook.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AGENT_TUI_MANAGER_HOOK_ENDPOINT: endpoint, AGENT_TUI_MANAGER_HOOK_TOKEN: 'test-token' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  try {
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'PowerShell', tool_input: toolInput }))
    expect(await closed).toBe(0)
    expect(received).toBeDefined()
    return { received: received!, stdout, stderr }
  } finally {
    if (child.exitCode === null) child.kill()
    peer?.destroy()
    await new Promise<void>(done => server.close(() => done()))
    if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined)
  }
}

describe.each(['codex', 'claude'] as const)('%s hook input and response integrity', (hook) => {
  it.each(['{invalid', 'null', '{"hook_event_name":"PermissionRequest"}'])('rejects malformed input without opening a human prompt: %s', async input => {
    const child = spawn(process.execPath, [resolve('dist-electron/' + hook + '-permission-hook.js')], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, AGENT_TUI_MANAGER_HOOK_ENDPOINT: '', AGENT_TUI_MANAGER_HOOK_TOKEN: '' },
    })
    let stdout = ''
    child.stdout.on('data', data => { stdout += data.toString() })
    child.stderr.resume()
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    try {
      child.stdin.end(input)
      expect(await closed).toBe(0)
      expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny')
    } finally { if (child.exitCode === null) child.kill() }
  })

  it('forwards raw multiline diagnostics beyond 2048 characters and returns the actual denial reason', async () => {
    const command = "python -c @'\nfrom pathlib import Path\n"
      + '# package diagnostics\n'.repeat(150) + "print(Path.cwd())\n'@\n"
    const result = await exchange(hook, { command })
    expect(result.received).toMatchObject({ command, toolInputSummary: command, toolInput: { command }, operation: 'unknown' })
    expect(result.received.inputTruncated).toBeUndefined()
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'deny', message: '命中递归删除规则，目标目录超出工作区',
    })
    expect(result.stderr).not.toContain('目标目录')
  })

  it.each([
    ['invalid argv', ['pwsh', '-Command', null, 'Get-Location']],
    ['oversized command', 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH + 1)],
    ['NUL command', 'echo \0bad'],
    ['oversized argv', ['python', '-c', 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH)]],
  ])('marks %s incomplete while preserving the original input', async (_name, command) => {
    const { received } = await exchange(hook, { command })
    expect(received.command).toBeUndefined()
    expect(received.inputTruncated).toBe(true)
    expect(received.toolInput).toEqual({ command })
    expect(assessApprovalRequest({
      command: received.command as string | undefined,
      risk: 'unknown', workspace: 'C:\\work', toolName: 'PowerShell',
      toolInput: received.toolInput, inputTruncated: received.inputTruncated as boolean,
      inputIssue: normalizeApprovalInputIssue(received.inputIssue),
    }).status).toBe('incomplete')
  })

  it.each([17077, MAX_APPROVAL_COMMAND_LENGTH])('preserves an intact %i-character JSON write while bounding only its display summary', async length => {
    const prefix = "Set-Content -LiteralPath '.\\research.json' -Value '{\"content\":\""
    const suffix = "\"}' -Encoding utf8"
    const command = prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix
    const { received, stderr } = await exchange(hook, { command })
    expect(received.command).toBe(command)
    expect(received.toolInput).toEqual({ command })
    expect(received.toolInputSummary).toBe(command.slice(0, 16384))
    expect(received.inputTruncated).toBeUndefined()
    expect(received.inputIssue).toBeUndefined()
    expect(stderr).not.toContain('research.json')
    expect(assessApprovalRequest({ command: received.command as string, risk: 'write', workspace: 'C:\\work', toolInput: received.toolInput }).status).toBe('ordinary')
  })

  it('distinguishes oversize complete input from upstream declared truncation without logging content', async () => {
    const command = 'fixture-private-value' + 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH)
    const oversized = await exchange(hook, { command })
    expect(oversized.received.inputIssue).toEqual({ code: 'command-too-long', field: 'command', actualLength: command.length, limit: MAX_APPROVAL_COMMAND_LENGTH })
    expect(oversized.stderr).not.toContain('fixture-private-value')
    const declared = await exchange(hook, { command: 'echo ok', command_truncated: true })
    expect(declared.received.inputIssue).toEqual({ code: 'declared-truncation', field: 'command' })
    expect(declared.received.inputTruncated).toBe(true)
  })

  it('preserves valid multiline argv for assessment without flattening quoted code', async () => {
    const command = ['pwsh', '-Command', "Get-Location\nri -Recurse -Force 'C:\\work\\build files'"]
    const { received } = await exchange(hook, { command })
    expect(received.command).toBeUndefined()
    expect(received.inputTruncated).toBeUndefined()
    expect(received.toolInput).toEqual({ command })
    expect(assessApprovalRequest({
      risk: 'unknown', workspace: 'C:\\work', toolName: 'PowerShell', toolInput: received.toolInput,
    }).status).toBe('high-risk')
  })

  it.each(['wrong-id', 'disconnect', 'oversized'] as const)('never approves after %s', async (response) => {
    const { stdout } = await exchange(hook, { command: 'Get-Location' }, response)
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny')
  })

  it.each(['output-before-allow', 'fragmented-allow'] as const)('accepts only the matching complete decision with %s', async (response) => {
    const { stdout } = await exchange(hook, { command: 'Get-Location' }, response)
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('allow')
  })
})
