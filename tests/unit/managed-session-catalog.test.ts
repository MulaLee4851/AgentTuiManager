import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { ManagedSessionCatalog } from '../../electron/managed-session-catalog'

describe('ManagedSessionCatalog', () => {
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
    expect((await ManagedSessionCatalog.load(path)).list()).toEqual([])
  })
})
