import type { SessionSummary } from '../src/shared/manager-api'

export interface StartupWorkspacePort {
  listSessions(): SessionSummary[]
  restartSession(id: string): Promise<void>
}

export function workspaceRestoreCandidates(ids: string[], sessions: SessionSummary[]): SessionSummary[] {
  const wanted = new Set(ids)
  return sessions.filter(session => wanted.has(session.sessionId)
    && ['stopped', 'failed', 'completed'].includes(session.status))
}

/** Sequential native resumes only. Never creates a replacement conversation. */
export async function restoreStartupWorkspace(ids: string[], port: StartupWorkspacePort) {
  const result: { restored: string[]; failed: Array<{ sessionId: string; name: string; reason: string }> } = { restored: [], failed: [] }
  const resumedNative = new Set<string>()
  for (const id of new Set(ids)) {
    const session = workspaceRestoreCandidates([id], port.listSessions())[0]
    if (!session) continue
    try {
      if (!session.nativeSessionId) throw new Error('尚无原生会话 ID，请手动选择历史会话')
      const nativeKey = JSON.stringify([session.agentKind, session.nativeSessionId])
      if (resumedNative.has(nativeKey) || port.listSessions().some(other => other.sessionId !== id
        && other.agentKind === session.agentKind && other.nativeSessionId === session.nativeSessionId
        && !['stopped', 'failed', 'completed'].includes(other.status))) {
        throw new Error('同一原生会话已有运行窗口，已跳过重复恢复')
      }
      // Restart inherits the persisted per-window full-auto setting.
      await port.restartSession(id)
      resumedNative.add(nativeKey)
      result.restored.push(id)
    } catch (error) {
      result.failed.push({ sessionId: id, name: session.displayName, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
