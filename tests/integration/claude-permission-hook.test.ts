import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { unlink } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('Claude PermissionRequest bridge', () => {
  it('keeps main-agent permission requests managed by the bridge', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-tui-claude-main-hook-test-${randomUUID()}`
      : join(tmpdir(), `agent-tui-claude-main-hook-test-${randomUUID()}.sock`)
    let received: Record<string, unknown> | undefined
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        socket.write(`${JSON.stringify({ type: 'permission-response', requestId: received.requestId, action: 'allow' })}\n`)
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolveListen)
    })

    try {
      const child = spawn(process.execPath, [resolve('dist-electron/claude-permission-hook.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENT_TUI_MANAGER_HOOK_ENDPOINT: endpoint,
          AGENT_TUI_MANAGER_HOOK_TOKEN: 'a'.repeat(48),
        },
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'PowerShell',
        tool_input: { command: 'Set-Content package.json updated' },
        tool_use_id: 'tool-main-1',
      }))
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', resolveExit)
      })

      expect(exitCode).toBe(0)
      expect(received).toMatchObject({ hookSource: 'claude', toolName: 'PowerShell', toolUseId: 'tool-main-1' })
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined)
    }
  })

  it('keeps direct subagent PermissionRequest hooks managed by the bridge', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-tui-claude-hook-test-${randomUUID()}`
      : join(tmpdir(), `agent-tui-claude-hook-test-${randomUUID()}.sock`)
    let received: Record<string, unknown> | undefined
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        socket.write(JSON.stringify({ type: 'permission-response', requestId: received.requestId, action: 'allow' }) + '\n')
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolveListen)
    })

    try {
      const child = spawn(process.execPath, [resolve('dist-electron/claude-permission-hook.js')], {
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
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'PowerShell',
        tool_input: { command: 'git status --short' },
        tool_use_id: 'tool-child-1',
        agent_id: 'subagent-1',
        agent_type: 'Explore',
      }))
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', resolveExit)
      })

      expect(exitCode).toBe(0)
      expect(received).toMatchObject({
        hookSource: 'claude', toolName: 'PowerShell', toolUseId: 'tool-child-1',
        agentId: 'subagent-1', agentType: 'Explore',
      })
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      })
      expect(stderr).toBe('')
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined)
    }
  })
})
