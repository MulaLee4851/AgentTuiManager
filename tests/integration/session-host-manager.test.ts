import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionHostManager, type HostHandle } from '../../electron/session-host-manager'
import type { HostEvent } from '../../src/shared/protocol'

const HOST_ENTRY = resolve('dist-electron/session-host.js')
const FAKE_AGENT = resolve('tests/fixtures/fake-agent.cjs')

async function nextMatching(handle: HostHandle, predicate: (event: HostEvent) => boolean): Promise<HostEvent> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const event = await handle.nextEvent(deadline - Date.now())
    if (predicate(event)) return event
  }
  throw new Error('Timed out waiting for host event')
}

describe('SessionHostManager integration', () => {
  const handles: HostHandle[] = []
  const tempRoots: string[] = []

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-'))
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(runtimeDir)
    await mkdir(workspace)
    tempRoots.push(root)
    return { manager: new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY }), runtimeDir, workspace }
  }

  async function start(manager: SessionHostManager, workspace: string, mode: 'running' | 'normal-exit' | 'crash') {
    const handle = await manager.start({
      executable: process.execPath,
      args: [FAKE_AGENT, '--mode', mode],
      cwd: workspace,
      cols: 80,
      rows: 24,
    })
    handles.push(handle)
    return handle
  }

  afterEach(async () => {
    await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('runs one independent PTY, streams output, and leaves the workspace empty', async () => {
    const { manager, workspace } = await fixture()
    const handle = await start(manager, workspace, 'running')
    await expect(nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))).resolves.toMatchObject({ type: 'output' })
    handle.write('hello\r')
    await expect(nextMatching(handle, (event) => event.type === 'output' && event.data.includes('hello'))).resolves.toMatchObject({ type: 'output' })
    expect(await readdir(workspace)).toEqual([])
  })

  it.each([['normal-exit', 0], ['crash', 1]] as const)('reports %s as factual exit code %i', async (mode, exitCode) => {
    const { manager, workspace } = await fixture()
    const handle = await start(manager, workspace, mode)
    await expect(nextMatching(handle, (event) => event.type === 'exit')).resolves.toMatchObject({ type: 'exit', exitCode })
  })

  it('persists the final exit fact after the client disconnects', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const handle = await start(manager, workspace, 'running')
    await nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    handle.write('exit 1\r')
    handle.disconnect()

    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    await expect.poll(() => replacement.readLastExit(handle.hostId), { timeout: 5_000 }).toMatchObject({
      hostId: handle.hostId,
      exitCode: 1,
    })
  })

  it('reconnects live hosts and deletes only stale registry data', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const original = await start(manager, workspace, 'running')
    await nextMatching(original, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    original.disconnect()

    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    const reconnected = await replacement.reconnect(original.hostId)
    handles.push(reconnected)
    reconnected.write('reconnected\r')
    await expect(nextMatching(reconnected, (event) => event.type === 'output' && event.data.includes('reconnected'))).resolves.toMatchObject({ type: 'output' })

    const sentinel = join(workspace, 'agent-history.jsonl')
    await writeFile(sentinel, 'do-not-delete')
    await writeFile(join(runtimeDir, 'settings.json'), JSON.stringify({ theme: 'system' }))
    const now = new Date().toISOString()
    await writeFile(join(runtimeDir, 'host-live-missing.json'), JSON.stringify({ hostId: 'live-missing', agentKind: 'generic', cwd: workspace, pid: process.pid, endpoint: '\\\\.\\pipe\\agent-tui-missing-live', lifecycle: 'running', createdAt: now, updatedAt: now }))
    await writeFile(join(runtimeDir, 'host-pending.json'), JSON.stringify({ hostId: 'pending', agentKind: 'generic', cwd: workspace, pid: 0, endpoint: '\\\\.\\pipe\\agent-tui-pending', lifecycle: 'starting', createdAt: now, updatedAt: now }))
    await writeFile(join(runtimeDir, 'host-invalid.json'), '{not-json')
    await writeFile(join(runtimeDir, 'host-stale-host.json'), JSON.stringify({ hostId: 'stale-host', agentKind: 'generic', cwd: workspace, pid: 999999, endpoint: '\\\\.\\pipe\\agent-tui-missing-host' }))
    const live = await replacement.listLiveHosts()

    expect(live.map((record) => record.hostId)).toContain(original.hostId)
    expect(await readdir(runtimeDir)).not.toContain('host-stale-host.json')
    expect(await readdir(runtimeDir)).toEqual(expect.arrayContaining(['host-live-missing.json', 'host-pending.json', 'host-invalid.json']))
    expect(await readFile(join(runtimeDir, 'settings.json'), 'utf8')).toBe('{"theme":"system"}')
    expect(await readFile(sentinel, 'utf8')).toBe('do-not-delete')
  })

  it('rejects stop when the host connection is already gone', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const handle = await start(manager, workspace, 'running')
    await nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    handle.disconnect()
    await expect(handle.stop()).rejects.toThrow(/closed/i)
    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    const cleanup = await replacement.reconnect(handle.hostId)
    handles.push(cleanup)
    await cleanup.stop()
  })

  it('rejects spawn failures and removes its pending registry record', async () => {
    const { runtimeDir, workspace } = await fixture()
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, nodeExecutable: join(runtimeDir, 'missing-node.exe'), timeoutMs: 250 })
    await expect(manager.start({ executable: process.execPath, args: [FAKE_AGENT, '--mode', 'running'], cwd: workspace, cols: 80, rows: 24 })).rejects.toThrow()
    expect((await readdir(runtimeDir)).filter((file) => file.startsWith('host-'))).toEqual([])
  })
})
