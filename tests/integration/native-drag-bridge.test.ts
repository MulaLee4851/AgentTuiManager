import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('native drag bridge', () => {
  it('builds and reports a versioned Windows protocol', async () => {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/build-native-bridge.ps1')])
    const { stdout } = await execFileAsync(resolve('build/native/AgentTui.NativeBridge.exe'), ['--self-test'])
    expect(JSON.parse(stdout.trim())).toEqual({ type: 'self-test', protocolVersion: 1, platform: 'windows' })
  })

  it('rejects unsupported commands and unverified window identities', async () => {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/build-native-bridge.ps1')])
    const child = spawn(resolve('build/native/AgentTui.NativeBridge.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const lines = createInterface({ input: child.stdout })
    const pending: Array<(value: Record<string, unknown>) => void> = []
    lines.on('line', (line) => {
      const resolveNext = pending.shift()
      if (resolveNext) resolveNext(JSON.parse(line) as Record<string, unknown>)
    })
    const nextResult = (): Promise<Record<string, unknown>> => new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('native bridge command timed out')), 2_000)
      pending.push((value) => { clearTimeout(timer); resolveResult(value) })
    })

    try {
      child.stdin.write(JSON.stringify({ type: 'send-keys', requestId: 'unsupported-1' }) + '\n')
      await expect(nextResult()).resolves.toMatchObject({
        type: 'command-result',
        requestId: 'unsupported-1',
        ok: false,
        reason: 'unsupported-command',
      })

      child.stdin.write(JSON.stringify({
        type: 'send-graceful-interrupt',
        requestId: 'invalid-window-1',
        hwnd: '0x1',
        expectedProcessId: 1234,
        expectedTitle: 'not-a-real-terminal',
      }) + '\n')
      await expect(nextResult()).resolves.toMatchObject({
        type: 'command-result',
        requestId: 'invalid-window-1',
        ok: false,
        reason: 'window-verification-failed',
      })
    } finally {
      lines.close()
      child.stdin.end()
      child.kill()
    }
  })
})
