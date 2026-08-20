import { spawn } from 'node:child_process'

import type { AgentKind } from '../src/shared/manager-api'

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function appleScriptQuote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function openMacResumeTerminal(executable: string, args: string[], workspace: string): Promise<void> {
  const command = `cd ${posixQuote(workspace)} && ${[executable, ...args].map(posixQuote).join(' ')}`
  const script = `tell application "Terminal" to do script "${appleScriptQuote(command)}"`
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

export async function openNativeResumeTerminal(agentKind: AgentKind, nativeSessionId: string, workspace: string): Promise<void> {
  if (agentKind !== 'codex' && agentKind !== 'claude') throw new Error('当前 Agent 不支持原生终端恢复')
  const executable = agentKind === 'codex' ? 'codex' : 'claude'
  const args = agentKind === 'codex' ? ['resume', nativeSessionId] : ['--resume', nativeSessionId]
  if (process.platform === 'darwin') {
    try {
      await openMacResumeTerminal(executable, args, workspace)
      return
    } catch (error) {
      throw new Error('无法打开 macOS Terminal：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (process.platform !== 'win32') throw new Error('当前系统暂不支持打开原生恢复终端')

  const command = [executable, ...args].map((part) => /\s/.test(part) ? '"' + part.replaceAll('"', '""') + '"' : part).join(' ')
  try {
    const child = spawn('cmd.exe', ['/d', '/s', '/k', command], {
      cwd: workspace,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } catch (error) {
    throw new Error('无法打开原生终端：' + (error instanceof Error ? error.message : String(error)))
  }
}
