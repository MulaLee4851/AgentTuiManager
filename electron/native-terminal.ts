import { spawn } from 'node:child_process'

import type { AgentKind } from '../src/shared/manager-api'

export async function openNativeResumeTerminal(agentKind: AgentKind, nativeSessionId: string, workspace: string): Promise<void> {
  if (agentKind !== 'codex' && agentKind !== 'claude') throw new Error('当前 Agent 不支持原生终端恢复')
  const executable = agentKind === 'codex' ? 'codex' : 'claude'
  const args = agentKind === 'codex' ? ['resume', nativeSessionId] : ['--resume', nativeSessionId]
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
