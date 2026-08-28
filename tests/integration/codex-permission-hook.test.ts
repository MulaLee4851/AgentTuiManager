import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { unlink } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('Codex PermissionRequest bridge', () => {
  it('forwards the official payload and writes only the official allow response to stdout', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-tui-codex-hook-test-${randomUUID()}`
      : join(tmpdir(), `agent-tui-codex-hook-test-${randomUUID()}.sock`)
    let received: Record<string, unknown> | undefined
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        socket.write(`${JSON.stringify({
          type: 'permission-response',
          requestId: received.requestId,
          action: 'allow',
        })}\n`)
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolveListen)
    })

    try {
      const payload = {
        hook_event_name: 'PermissionRequest',
        session_id: 'thread-1',
        turn_id: 'turn-1',
        cwd: 'B:\\work',
        model: 'gpt-5.6',
        permission_mode: 'on-request',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short', description: 'Inspect changes' },
        transcript_path: 'C:\\codex\\rollout.jsonl',
        agent_id: 'agent-1',
        agent_type: 'explorer',
      }
      const child = spawn(process.execPath, [resolve('dist-electron/codex-permission-hook.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENT_TUI_MANAGER_HOOK_ENDPOINT: endpoint,
          AGENT_TUI_MANAGER_HOOK_TOKEN: 'a'.repeat(48),
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.stdin.end(JSON.stringify(payload))
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', resolveExit)
      })

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      })
      expect(received).toMatchObject({
        type: 'permission-hook',
        hookSource: 'codex',
        toolName: 'Bash',
        nativeSessionId: 'thread-1',
        turnId: 'turn-1',
        cwd: 'B:\\work',
        model: 'gpt-5.6',
        permissionMode: 'on-request',
        toolInput: payload.tool_input,
        rawPayload: payload,
      })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined)
    }
  })
})
