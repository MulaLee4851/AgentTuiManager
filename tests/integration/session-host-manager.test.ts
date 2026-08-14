import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  const managerRuntimeDirs = new WeakMap<SessionHostManager, string>()
  const startedHosts: Array<{ manager: SessionHostManager; hostId: string; runtimeDir: string }> = []

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-'))
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(runtimeDir)
    await mkdir(workspace)
    tempRoots.push(root)
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    managerRuntimeDirs.set(manager, runtimeDir)
    return { manager, runtimeDir, workspace }
  }

  async function start(manager: SessionHostManager, workspace: string, mode: 'running' | 'normal-exit' | 'crash') {
    const handle = await manager.start({
      agentKind: 'generic',
      executable: process.execPath,
      args: [FAKE_AGENT, '--mode', mode],
      cwd: workspace,
      cols: 80,
      rows: 24,
    })
    handles.push(handle)
    const runtimeDir = managerRuntimeDirs.get(manager)
    if (!runtimeDir) throw new Error('Test manager is missing its runtime directory')
    startedHosts.push({ manager, hostId: handle.hostId, runtimeDir })
    return handle
  }

  function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (isProcessAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return !isProcessAlive(pid)
  }

  async function readRegisteredPid(entry: { hostId: string; runtimeDir: string }): Promise<number> {
    try {
      const record = JSON.parse(await readFile(join(entry.runtimeDir, `host-${entry.hostId}.json`), 'utf8')) as { pid?: unknown }
      return typeof record.pid === 'number' ? record.pid : 0
    } catch {
      return 0
    }
  }

  async function cleanupStartedHost(entry: { manager: SessionHostManager; hostId: string; runtimeDir: string }): Promise<void> {
    const pid = await readRegisteredPid(entry)
    if (!isProcessAlive(pid) || await waitForProcessExit(pid, 100)) return

    let cleanupHandle: HostHandle | undefined
    try {
      cleanupHandle = await entry.manager.reconnect(entry.hostId)
      await cleanupHandle.stop()
    } catch {
      // The Host may already be exiting or its endpoint may be gone.
    } finally {
      cleanupHandle?.disconnect()
    }

    if (!isProcessAlive(pid) || await waitForProcessExit(pid, 250)) return
    process.kill(pid)
    await waitForProcessExit(pid, 2_000)
  }

  afterEach(async () => {
    await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
    await Promise.allSettled(startedHosts.splice(0).map((entry) => cleanupStartedHost(entry)))
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

  it('persists manager-only recovery metadata without changing the host protocol', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const handle = await manager.start({
      displayName: 'Original Agent',
      agentKind: 'claude',
      executable: process.execPath,
      args: [FAKE_AGENT, '--mode', 'running'],
      cwd: workspace,
      cols: 91,
      rows: 27,
      nativeSessionId: 'claude-native',
      recovery: { executable: 'claude', args: ['--resume', 'claude-native'] },
    })
    handles.push(handle)
    startedHosts.push({ manager, hostId: handle.hostId, runtimeDir })

    const record = JSON.parse(await readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8'))
    expect(record).toMatchObject({
      displayName: 'Original Agent',
      agentKind: 'claude',
      cols: 91,
      rows: 27,
      nativeSessionId: 'claude-native',
      recovery: { executable: 'claude', args: ['--resume', 'claude-native'] },
    })

    await manager.updateMetadata(handle.hostId, {
      displayName: 'Renamed Agent',
      agentConfig: {
        enabled: true,
        source: 'custom',
        profileId: 'profile-1',
        model: 'model-x',
        extraArgs: [],
        hasApiKey: true,
      },
    })
    const updated = JSON.parse(await readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8'))
    expect(updated).toMatchObject({
      displayName: 'Renamed Agent',
      nativeSessionId: 'claude-native',
      recovery: { executable: 'claude', args: ['--resume', 'claude-native'] },
      agentConfig: { profileId: 'profile-1', hasApiKey: true },
    })
  })

  it('force releases only the registered Host tree and allows a replacement', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const handle = await start(manager, workspace, 'running')
    await nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    const entry = { manager, hostId: handle.hostId, runtimeDir }
    const pid = await readRegisteredPid(entry)
    handle.disconnect()

    await manager.forceRelease(handle.hostId)

    expect(await waitForProcessExit(pid, 2_000)).toBe(true)
    await expect(readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(workspace)).toEqual([])
    const replacement = await start(manager, workspace, 'running')
    await expect(nextMatching(replacement, (event) => event.type === 'output' && event.data.includes('fake-agent>'))).resolves.toMatchObject({ type: 'output' })
  })

  it('keeps the PTY alive by default after the Manager lease expires and allows takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-lease-'))
    tempRoots.push(root)
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, leaseMs: 5_000 })
    managerRuntimeDirs.set(manager, runtimeDir)
    const handle = await start(manager, workspace, 'running')
    await nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    handle.disconnect()
    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, leaseMs: 5_000 })
    await expect.poll(async () => (await replacement.listLiveHosts())[0]?.managerOwnership, { timeout: 9_000 }).toBe('preserved')
    const reconnected = await replacement.reconnect(handle.hostId)
    handles.push(reconnected)
    reconnected.write('lease-takeover\r')
    await expect(nextMatching(reconnected, (event) => event.type === 'output' && event.data.includes('lease-takeover'))).resolves.toMatchObject({ type: 'output' })
  }, 12_000)

  it('releases the PTY after the Manager lease expires when crash retention is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-release-'))
    tempRoots.push(root)
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, leaseMs: 5_000, preserveOnLeaseExpiry: false })
    managerRuntimeDirs.set(manager, runtimeDir)
    const handle = await start(manager, workspace, 'running')
    await nextMatching(handle, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    handle.disconnect()
    await expect.poll(() => manager.readLastExit(handle.hostId), { timeout: 9_000 }).toMatchObject({ hostId: handle.hostId, reason: 'manager-lease-expired' })
  }, 12_000)

  it('keeps a Host alive after an explicit normal-exit preserve and allows reconnect', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const original = await start(manager, workspace, 'running')
    await nextMatching(original, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    await original.preserveOnDisconnect?.()
    original.disconnect()
    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    await expect.poll(async () => (await replacement.listLiveHosts())[0]?.managerOwnership).toBe('preserved')
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    expect((await replacement.listLiveHosts())[0]?.managerOwnership).toBe('preserved')
    const reconnected = await replacement.reconnect(original.hostId)
    handles.push(reconnected)
    reconnected.write('preserved-reconnect\r')
    await expect(nextMatching(reconnected, (event) => event.type === 'output' && event.data.includes('preserved-reconnect'))).resolves.toMatchObject({ type: 'output' })
  }, 12_000)

  it('resolves one encrypted profile into only the target Host start command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-config-'))
    tempRoots.push(root)
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const resolveAgentConfig = vi.fn(async (_profileId: string, _agentKind: 'generic' | 'codex' | 'claude' | 'pi' | 'deepseek', args: string[]) => ({
      environment: { MANAGER_PRIVATE_TOKEN: 'target-only-secret' },
      args: [...args, '--print-env', 'MANAGER_PRIVATE_TOKEN'],
    }))
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, resolveAgentConfig })
    const handle = await manager.start({
      agentKind: 'generic',
      executable: process.execPath,
      args: [FAKE_AGENT, '--mode', 'running'],
      cwd: workspace,
      cols: 80,
      rows: 24,
      agentConfig: { enabled: true, source: 'custom', profileId: 'profile-1', extraArgs: [], hasApiKey: true },
    })
    handles.push(handle)
    startedHosts.push({ manager, hostId: handle.hostId, runtimeDir })
    await expect.poll(() => handle.replay(), { timeout: 5_000 }).toContain('env:target-only-secret')
    expect(resolveAgentConfig).toHaveBeenCalledWith('profile-1', 'generic', [FAKE_AGENT, '--mode', 'running'])
    const storedRecord = await readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8')
    expect(storedRecord).not.toContain('target-only-secret')
    expect(storedRecord).toContain('profile-1')
  })

  it('injects an HTTP proxy only into the target Host and never persists credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-host-proxy-'))
    tempRoots.push(root)
    const runtimeDir = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const resolveAgentProxy = vi.fn(async () => ({ HTTP_PROXY: 'http://user:private-password@127.0.0.1:7897' }))
    const manager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY, resolveAgentProxy })
    const handle = await manager.start({
      agentKind: 'generic', executable: process.execPath,
      args: [FAKE_AGENT, '--mode', 'running', '--print-env', 'HTTP_PROXY'],
      cwd: workspace, cols: 80, rows: 24,
      agentProxy: { enabled: true, proxyId: 'proxy-1', protocol: 'http', host: '127.0.0.1', port: 7897, hasPassword: true },
    })
    handles.push(handle)
    startedHosts.push({ manager, hostId: handle.hostId, runtimeDir })
    await expect.poll(() => handle.replay(), { timeout: 5_000 }).toContain('env:http://user:private-password@127.0.0.1:7897')
    expect(resolveAgentProxy).toHaveBeenCalledWith('proxy-1')
    const storedRecord = await readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8')
    expect(storedRecord).not.toContain('private-password')
    expect(storedRecord).toContain('proxy-1')
  })

  it('reconnects live hosts and deletes only stale registry data', async () => {
    const { manager, runtimeDir, workspace } = await fixture()
    const original = await start(manager, workspace, 'running')
    await nextMatching(original, (event) => event.type === 'output' && event.data.includes('fake-agent>'))
    original.write('replay-marker\r')
    await nextMatching(original, (event) => event.type === 'output' && event.data.includes('replay-marker'))
    original.disconnect()

    const replacement = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    const reconnected = await replacement.reconnect(original.hostId)
    handles.push(reconnected)
    await expect(reconnected.replay()).resolves.toContain('replay-marker')
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
    await expect(manager.start({ agentKind: 'generic', executable: process.execPath, args: [FAKE_AGENT, '--mode', 'running'], cwd: workspace, cols: 80, rows: 24 })).rejects.toThrow()
    expect((await readdir(runtimeDir)).filter((file) => file.startsWith('host-'))).toEqual([])
  })
})
