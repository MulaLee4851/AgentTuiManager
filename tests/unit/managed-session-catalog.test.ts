import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { ManagedSessionCatalog } from '../../electron/managed-session-catalog'

describe('ManagedSessionCatalog', () => {
  it('freezes the last active workspace before shutdown without removing stopped entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-catalog-'))
    const path = join(root, 'sessions.json')
    const catalog = await ManagedSessionCatalog.load(path)
    const entry = (sessionId: string, status: 'running' | 'stopped') => ({
      sessionId, hostId: sessionId, updatedAt: new Date().toISOString(),
      summary: { sessionId, displayName: sessionId, nativeSessionId: 'native-' + sessionId,
        agentKind: 'codex' as const, workspace: 'demo', status, recoveryAttempts: 0, userStopRequested: status === 'stopped' },
    })
    catalog.startWorkspaceTracking()
    await catalog.upsert(entry('active', 'running'))
    await catalog.upsert(entry('old', 'stopped'))
    expect((await ManagedSessionCatalog.load(path)).startupWorkspace().map(item => item.sessionId)).toEqual(['active'])
    await catalog.captureWorkspaceBeforeExit()
    await catalog.upsert(entry('active', 'stopped'))
    const reopened = await ManagedSessionCatalog.load(path)
    expect(reopened.list()).toHaveLength(2)
    expect(reopened.startupWorkspace().map(item => item.sessionId)).toEqual(['active'])
    // Startup hydration updates status but cannot erase the stored restore set.
    await reopened.upsert(entry('active', 'stopped'))
    expect((await ManagedSessionCatalog.load(path)).startupWorkspace().map(item => item.sessionId)).toEqual(['active'])
    reopened.startWorkspaceTracking()
    await reopened.upsert(entry('active', 'running'))
    await reopened.upsert(entry('active', 'stopped'))
    expect((await ManagedSessionCatalog.load(path)).startupWorkspace()).toEqual([])
    expect((await ManagedSessionCatalog.load(path)).list()).toHaveLength(2)
  })

  it('persists and removes Manager metadata without terminal output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-catalog-'))
    const path = join(root, 'sessions.json')
    const catalog = await ManagedSessionCatalog.load(path)
    await catalog.upsert({
      sessionId: 'session-1',
      hostId: 'host-1',
      summary: {
        sessionId: 'session-1', displayName: 'Codex', agentKind: 'codex', workspace: 'B:\\workspace',
        nativeSessionId: 'native-1', status: 'stopped', recoveryAttempts: 0, userStopRequested: true,
      },
      request: {
        displayName: 'Codex', agentKind: 'codex', workspace: 'B:\\workspace', executable: 'codex',
        args: [], cols: 80, rows: 24, nativeSessionId: 'native-1',
      },
      updatedAt: new Date().toISOString(),
    })
    expect((await ManagedSessionCatalog.load(path)).list()).toHaveLength(1)
    expect(await readFile(path, 'utf8')).not.toContain('terminal output')
    await catalog.remove('session-1')
    const restored = await ManagedSessionCatalog.load(path)
    expect(restored.list()).toEqual([])
    const history = [{ id: 'native-1', title: 'Official title', workspace: 'B:\\workspace', updatedAt: 1 }]
    expect(restored.nameHistory('codex', history)[0]).toMatchObject({ title: 'Codex', managerDisplayName: 'Codex' })
    expect(restored.nameHistory('claude', history)[0]!.title).toBe('Official title')
    expect(history[0]!.title).toBe('Official title')
  })

  it('retains only the latest alias and never replaces it with an old window status update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-alias-'))
    const path = join(root, 'catalog.json')
    const catalog = await ManagedSessionCatalog.load(path)
    const makeEntry = (sessionId: string, displayName: string) => ({
      sessionId, hostId: 'host-' + sessionId, updatedAt: new Date().toISOString(),
      summary: { sessionId, displayName, agentKind: 'codex' as const, workspace: 'demo',
        nativeSessionId: 'native', status: 'running' as const, recoveryAttempts: 0, userStopRequested: false },
    })
    await catalog.upsert(makeEntry('one', 'Old name'))
    await catalog.upsert(makeEntry('two', 'AgentTuiManager开发'))
    await catalog.upsert(makeEntry('one', 'Old name'))
    await catalog.remove('two')
    const restored = await ManagedSessionCatalog.load(path)
    const history = [{ id: 'native', title: 'CLI title', workspace: 'demo', updatedAt: 1 }]
    expect(restored.nameHistory('codex', history)[0]!.title).toBe('AgentTuiManager开发')
    await restored.clear()
    const empty = await ManagedSessionCatalog.load(path)
    expect(empty.nameHistory('codex', history)[0]!.title).toBe('AgentTuiManager开发')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.nativeNames).toHaveLength(1)
    expect(saved.nativeNames[0].displayName).toBe('AgentTuiManager开发')
  })
})
