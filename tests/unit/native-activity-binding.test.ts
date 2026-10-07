import { promises as fs } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttentionSound } from '../../electron/attention-sound'
import { ApprovalPolicyEngine } from '../../electron/approval-policy'
import { SessionController, type SessionHostManagerPort } from '../../electron/session-controller'
import { NativeSessionActivityMonitor, validateNativeActivityBinding, type NativeActivityBindingPort } from '../../electron/native-session-activity'
import type { HostHandle } from '../../electron/session-host-manager'
import type { HostEvent } from '../../src/shared/protocol'

const oldId = 'old-native-session'
const liveId = 'live-native-session'
const releases: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const release of releases.splice(0).reverse()) await release()
})
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('')
const metadata = (kind: 'codex' | 'claude', id: string, child = false) => kind === 'codex'
  ? { type: 'session_meta', payload: { id, source: child ? { subagent: { thread_spawn: {} } } : 'cli' } }
  : { type: 'system', subtype: 'session_start', sessionId: id, ...(child ? { isSidechain: true } : {}) }
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'atm-activity-binding-'))
  releases.push(() => rm(root, { recursive: true, force: true }))
  const roots = { codex: join(root, 'codex', 'sessions'), claude: join(root, 'claude', 'projects') }
  await mkdir(roots.codex, { recursive: true }); await mkdir(roots.claude, { recursive: true })
  return { root, roots }
}

class FixtureHost implements HostHandle {
  readonly hostId = 'binding-fixture-host'
  private readonly events: HostEvent[] = []
  private readonly waiters: Array<(event: HostEvent) => void> = []
  constructor(readonly permissionHook: 'codex' | 'claude') {}
  nextEvent(): Promise<HostEvent> { const event = this.events.shift(); return event ? Promise.resolve(event) : new Promise(resolve => this.waiters.push(resolve)) }
  emit(event: HostEvent): void { const waiter = this.waiters.shift(); if (waiter) waiter(event); else this.events.push(event) }
  write(): void {}
  resize(): void {}
  async replay(): Promise<string> { return '' }
  async stop(): Promise<void> { this.emit({ type: 'exit', exitCode: 0 }) }
  async preserveOnDisconnect(): Promise<void> {}
  resumeManagement(): void {}
  async ping(): Promise<'managed'> { return 'managed' }
  disconnect(): void {}
  respondToPermission(): void {}
}

async function controllerFixture(kind: 'codex' | 'claude', override?: NativeActivityBindingPort) {
  const f = await files()
  const host = new FixtureHost(kind)
  const metadataUpdates: unknown[] = []
  const starts: unknown[] = []
  const manager: SessionHostManagerPort = {
    start: async options => { starts.push(options); return host }, reconnect: async () => host,
    listLiveHosts: async () => [], readLastExit: async () => undefined,
    updateMetadata: async (_id, update) => { metadataUpdates.push(update) }, removeArtifacts: async () => undefined,
  }
  const validate = vi.fn((agent: 'codex' | 'claude', binding: { nativeSessionId: string; transcriptPath: string }) =>
    validateNativeActivityBinding(agent, binding, f.roots))
  const controller = new SessionController(manager, undefined, undefined, new ApprovalPolicyEngine(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, override ?? { validate })
  const recovery = { executable: kind, args: ['resume', oldId] }
  const session = await controller.startSession({ displayName: 'fixture', agentKind: kind, workspace: f.root,
    executable: kind, args: ['resume', oldId], nativeSessionId: oldId, recovery, cols: 80, rows: 24 })
  await controller.setApprovalMode(session.sessionId, 'rules-auto')
  releases.push(() => controller.stopAllSessions())
  const hook = (nativeSessionId: string, transcriptPath: string, extra: Partial<Extract<HostEvent, { type: 'permission-request' }>> = {}) => {
    host.emit({ type: 'permission-request', requestId: 'fixture-' + Math.random(), hookSource: kind,
      toolName: 'PowerShell', command: 'git status --short', operation: 'read', nativeSessionId, transcriptPath, ...extra })
  }
  return { ...f, controller, host, session, recovery, starts, metadataUpdates, validate, hook }
}

describe('validated activity identity independent of resume identity', () => {
  it.each((['codex', 'claude'] as const).flatMap(kind => (['question', 'completion'] as const).map(event => ({ kind, event }))))(
    'observes the live $kind transcript and sounds for $event while preserving recovery identity', async ({ kind, event }) => {
      const f = await controllerFixture(kind)
      const beforeBinding = f.controller.listNativeActivitySessions()[0]!
      const path = join(f.roots[kind], kind === 'codex' ? `rollout-fixture-${liveId}_another-instance.jsonl` : liveId + '.jsonl')
      await writeFile(path, jsonl(metadata(kind, liveId)))
      f.hook(liveId, path)
      await expect.poll(() => f.controller.listNativeActivitySessions()[0]?.activityNativeSessionId).toBe(liveId)
      const target = f.controller.listNativeActivitySessions()[0]!
      expect(target.nativeSessionId).toBe(oldId)
      expect(f.controller.listSessions()[0]!.nativeSessionId).toBe(oldId)
      expect(f.controller.isNativeActivitySnapshotCurrent(beforeBinding)).toBe(false)
      f.controller.observeNativeActivity(beforeBinding, { activity: 'error', timestamp: Date.now() + 1000, error: 'stale old transcript' })
      expect(f.controller.listSessions()[0]?.activity).not.toBe('error')
      expect(f.metadataUpdates.every(update => !('nativeSessionId' in (update as object)) && !('recovery' in (update as object)))).toBe(true)
      expect(f.starts[0]).toMatchObject({ nativeSessionId: oldId,
        recovery: { executable: kind, args: expect.arrayContaining(['resume', oldId]) } })
      const play = vi.fn()
      const sound = new AttentionSound({ session: id => f.controller.listSessions().find(item => item.sessionId === id),
        approvals: () => [], isActive: () => false, play })
      sound.seed(f.controller.listSessions())
      releases.push(async () => sound.dispose())
      const timestamp = Date.now() + 1
      const record = kind === 'codex'
        ? event === 'question' ? { timestamp, type: 'response_item', payload: { type: 'function_call', call_id: 'question-1',
          name: 'functions.request_user_input', arguments: JSON.stringify({ questions: [{ question: 'Synthetic target?' }] }) } }
          : { timestamp, type: 'event_msg', payload: { type: 'task_complete' } }
        : { timestamp, type: 'assistant', sessionId: liveId, message: event === 'question'
          ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Synthetic target?' }] } }] }
          : { stop_reason: 'end_turn' } }
      await fs.appendFile(path, jsonl(record))
      const monitor = new NativeSessionActivityMonitor(() => f.controller.listNativeActivitySessions(), (snapshot, activity) => {
        f.controller.observeNativeActivity(snapshot, activity)
        if (!f.controller.isNativeActivitySnapshotCurrent(snapshot)) return
        sound.sessionChanged(snapshot.sessionId)
        sound.observeQuestions(snapshot.sessionId, activity.pendingUserQuestions ?? [])
      }, f.roots)
      releases.push(async () => monitor.stop())
      await monitor.poll()
      await expect.poll(() => play.mock.calls.length, { timeout: 2000, interval: 20 }).toBe(1)
      if (event === 'completion') expect(f.controller.listSessions()[0]?.activity).toBe('completed')
      await monitor.poll(); expect(play).toHaveBeenCalledOnce()
    },
  )

  it('finds a suffixed Codex rollout by its metadata ID without a hook path and ignores a misleading filename', async () => {
    const f = await files()
    await writeFile(join(f.roots.codex, `rollout-a-${liveId}_wrong.jsonl`), jsonl(metadata('codex', 'unrelated-session')))
    await writeFile(join(f.roots.codex, `rollout-b-${liveId}_resumed.jsonl`), jsonl(metadata('codex', liveId),
      { timestamp: 300, type: 'event_msg', payload: { type: 'task_complete' } }))
    const activity = vi.fn()
    const monitor = new NativeSessionActivityMonitor(() => [{ sessionId: 'manager', nativeSessionId: liveId,
      agentKind: 'codex', status: 'running', activitySince: 200 } as never], activity, f.roots)
    releases.push(async () => monitor.stop())
    await monitor.poll()
    expect(activity).toHaveBeenCalledOnce()
    expect(activity.mock.calls[0]?.[1]).toMatchObject({ activity: 'completed', timestamp: 300 })
  })

  it.each(['codex', 'claude'] as const)('rejects out-of-root paths, escaping links, wrong IDs and child %s metadata', async kind => {
    const f = await files()
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    const outsideFile = join(outside, 'fixture.jsonl')
    await writeFile(outsideFile, jsonl(metadata(kind, liveId)))
    const alias = join(f.roots[kind], 'alias')
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const open = vi.spyOn(fs, 'open')
    for (const path of [outsideFile, join(alias, 'fixture.jsonl')]) {
      expect(await validateNativeActivityBinding(kind, { nativeSessionId: liveId, transcriptPath: path }, f.roots)).toBeUndefined()
    }
    expect(open).not.toHaveBeenCalled()
    const candidate = join(f.roots[kind], liveId + '.jsonl')
    for (const row of [metadata(kind, 'wrong-native-id'), metadata(kind, liveId, true)]) {
      await writeFile(candidate, jsonl(row))
      expect(await validateNativeActivityBinding(kind, { nativeSessionId: liveId, transcriptPath: candidate }, f.roots)).toBeUndefined()
    }
  })

  it('ignores child hooks and rejects binding validation that finishes after the session stops', async () => {
    let finish!: (binding: { nativeSessionId: string; transcriptPath: string }) => void
    const validate = vi.fn(() => new Promise<{ nativeSessionId: string; transcriptPath: string }>(resolve => { finish = resolve }))
    const f = await controllerFixture('codex', { validate })
    const path = join(f.roots.codex, `rollout-fixture-${liveId}.jsonl`)
    f.hook(liveId, path, { agentId: 'child-agent', agentType: 'Explore' })
    await expect.poll(() => f.controller.listPendingApprovals().length).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(validate).not.toHaveBeenCalled()
    f.hook(liveId, path)
    await expect.poll(() => validate.mock.calls.length).toBe(1)
    await f.controller.stopSession(f.session.sessionId)
    finish({ nativeSessionId: liveId, transcriptPath: path })
    await Promise.resolve(); await Promise.resolve()
    expect(f.controller.listNativeActivitySessions()[0]?.activityNativeSessionId).toBeUndefined()
    expect(f.controller.listSessions()[0]?.nativeSessionId).toBe(oldId)
  })

  it('rejects an older binding validation and stale snapshots after a newer main hook wins', async () => {
    const pending = new Map<string, (binding: { nativeSessionId: string; transcriptPath: string }) => void>()
    const validate = vi.fn((_kind: 'codex' | 'claude', binding: { nativeSessionId: string; transcriptPath: string }) =>
      new Promise<typeof binding>(resolve => { pending.set(binding.nativeSessionId, resolve) }))
    const f = await controllerFixture('codex', { validate })
    const first = { nativeSessionId: 'first-native-session', transcriptPath: join(f.roots.codex, 'first.jsonl') }
    const second = { nativeSessionId: 'second-native-session', transcriptPath: join(f.roots.codex, 'second.jsonl') }
    f.hook(first.nativeSessionId, first.transcriptPath)
    f.hook(second.nativeSessionId, second.transcriptPath, { agentId: second.nativeSessionId, agentType: 'main' })
    await expect.poll(() => validate.mock.calls.length).toBe(2)
    pending.get(second.nativeSessionId)!(second)
    await expect.poll(() => f.controller.listNativeActivitySessions()[0]?.activityNativeSessionId).toBe(second.nativeSessionId)
    const current = f.controller.listNativeActivitySessions()[0]!
    pending.get(first.nativeSessionId)!(first)
    await Promise.resolve(); await Promise.resolve()
    expect(f.controller.listNativeActivitySessions()[0]?.activityNativeSessionId).toBe(second.nativeSessionId)
    expect(f.controller.isNativeActivitySnapshotCurrent({ ...current, activityBindingVersion: 0 })).toBe(false)
    expect(f.controller.isNativeActivitySnapshotCurrent({ ...current, activityGeneration: current.activityGeneration! - 1 })).toBe(false)
    expect(f.controller.isNativeActivitySnapshotCurrent(current)).toBe(true)
  })
})
