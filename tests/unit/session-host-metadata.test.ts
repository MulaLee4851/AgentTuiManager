import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionHostManager, type HostRecord } from '../../electron/session-host-manager'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'atm-metadata-fixture-'))
  roots.push(runtimeDir)
  const record: HostRecord = {
    hostId: 'synthetic-host', sessionId: 'synthetic-window', cwd: runtimeDir,
    nativeSessionId: 'old-history', approvalMode: 'manual', fullAutoEnabled: false,
    pid: 0, endpoint: 'unused-fixture-endpoint', lifecycle: 'running',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  const path = join(runtimeDir, 'host-synthetic-host.json')
  await writeFile(path, JSON.stringify(record))
  const manager = new SessionHostManager({ runtimeDir, hostEntry: 'unused-fixture-host' })
  return { manager, path, read: async () => JSON.parse(await readFile(path, 'utf8')) as HostRecord }
}

it('serializes native resume, approval mode and config updates without losing independent fields', async () => {
  const { manager, read } = await fixture()
  const recovery = { executable: 'codex', args: ['resume', 'new-history'] }
  await Promise.all([
    manager.updateMetadata('synthetic-host', { nativeSessionId: 'new-history', recovery }),
    manager.updateMetadata('synthetic-host', { approvalMode: 'agent-review', fullAutoEnabled: true }),
    manager.updateMetadata('synthetic-host', { displayName: 'Updated title', agentConfig: { enabled: false, source: 'local', extraArgs: [], hasApiKey: false } }),
  ])
  expect(await read()).toMatchObject({ nativeSessionId: 'new-history', recovery, approvalMode: 'agent-review', fullAutoEnabled: true,
    displayName: 'Updated title', agentConfig: { enabled: false, hasApiKey: false } })
})

it('retains the latest native identity when multiple parent hooks synchronize in sequence', async () => {
  const { manager, read } = await fixture()
  await Promise.all(['first-history', 'second-history', 'latest-history'].map(nativeSessionId =>
    manager.updateMetadata('synthetic-host', { nativeSessionId, recovery: { executable: 'codex', args: ['resume', nativeSessionId] } })))
  expect(await read()).toMatchObject({ nativeSessionId: 'latest-history', recovery: { args: ['resume', 'latest-history'] } })
})

it('drains pending metadata writes before removing an obsolete Host record', async () => {
  const { manager, path } = await fixture()
  const update = manager.updateMetadata('synthetic-host', { nativeSessionId: 'obsolete-history' })
  await manager.removeArtifacts('synthetic-host')
  await update
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
