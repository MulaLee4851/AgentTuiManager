import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  discoverGlobalCodexSessions,
  discoverRecentNativeSessions,
  type NativeSessionDiscoveryReader,
} from '../../electron/native-session-discovery'

const EPOCH = 1_800_000_000_000

function meta(id: string, cwd = 'B:\\fixture-workspace', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'session_meta', payload: { id, cwd, ...extra } })
}

function fixtureReader(files: Record<string, string>, mtimes: Record<string, number> = {}, cacheable = false): NativeSessionDiscoveryReader {
  return {
    listFiles: vi.fn(async (root: string) => Object.keys(files).filter((file) => file.startsWith(root))),
    readFirstLine: vi.fn(async (file: string) => {
      if (!(file in files)) throw new Error('Missing fixture')
      return files[file]!.split('\n')[0]!
    }),
    readLines: vi.fn((file: string) => (async function* () {
      if (!(file in files)) throw new Error('Missing fixture')
      const lines = files[file]!.split('\n')
      for (const line of lines.slice(0, -1)) yield line
    })()),
    mtime: vi.fn(async (file: string) => mtimes[file] ?? 0),
    ...(cacheable ? {
      stat: vi.fn(async (file: string) => {
        if (!(file in files)) throw new Error('Missing fixture')
        return { mtimeMs: mtimes[file] ?? 0, size: Buffer.byteLength(files[file]!), ctimeMs: 0 }
      }),
    } : {}),
  }
}

describe('global Codex history', () => {
  const tempRoots: string[] = []
  afterEach(async () => {
    vi.unstubAllEnvs()
    // Every cleanup target originates from mkdtemp with this fixture prefix.
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('sorts every workspace before taking 50, including entries beyond the former traversal and result caps', async () => {
    const root = join(tmpdir(), 'global-codex-memory-fixture')
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let i = 0; i < 10_255; i += 1) {
      const id = `session-${String(i).padStart(5, '0')}`
      const file = join(root, 'sessions', `rollout-${id}.jsonl`)
      files[file] = meta(id, `B:\\workspace-${i % 3}`)
      mtimes[file] = EPOCH + i
    }
    const reader = fixtureReader(files, mtimes, true)
    const options = { roots: { codex: root }, reader }
    const sessions = await discoverGlobalCodexSessions(options)
    expect(sessions).toHaveLength(50)
    expect(sessions.map((session) => session.id)).toEqual(Array.from({ length: 50 }, (_, i) => `session-${10_254 - i}`))
    expect(new Set(sessions.map((session) => session.workspace)).size).toBe(3)
    expect(reader.readFirstLine).toHaveBeenCalledTimes(10_255)

    const extended = await discoverGlobalCodexSessions({ ...options, limit: 250 })
    expect(extended).toHaveLength(250)
    expect(extended.at(-1)?.id).toBe('session-10005')
    // Returning fresh objects also prevents renderer/caller annotation from mutating caches.
    sessions[0]!.title = 'caller annotation'
    expect(extended[0]!.title).toBe('session-10254')
    expect(reader.readFirstLine).toHaveBeenCalledTimes(10_255)

    const excluded = await discoverGlobalCodexSessions({ ...options, excludeSessionIds: sessions.map((session) => session.id) })
    expect(excluded).toHaveLength(50)
    expect(excluded[0]?.id).toBe('session-10204')
    expect(excluded.at(-1)?.id).toBe('session-10155')
  })

  it('combines rollout activity, creation, history, and session index updates and uses the latest renamed title', async () => {
    const root = join(tmpdir(), 'global-codex-order-fixture')
    const byMtime = join(root, 'sessions', '2020', 'rollout-active-old-session.jsonl')
    const files = {
      [byMtime]: meta('mtime', 'B:\\original-cwd', { timestamp: '2020-01-01T00:00:00Z' }),
      [join(root, 'sessions', 'rollout-created.jsonl')]: meta('created', 'B:\\created', { timestamp: EPOCH + 4_000 }),
      [join(root, 'sessions', 'rollout-history.jsonl')]: meta('history'),
      [join(root, 'sessions', 'rollout-renamed.jsonl')]: meta('renamed'),
      [join(root, 'history.jsonl')]: [
        JSON.stringify({ session_id: 'history', text: ' First\n prompt ', ts: (EPOCH + 6_000) / 1_000 }),
        JSON.stringify({ session_id: 'history', text: 'Later prompt', ts: (EPOCH + 5_000) / 1_000 }),
        JSON.stringify({ session_id: 'renamed', text: 'Original prompt', ts: EPOCH / 1_000 }),
        '',
      ].join('\n'),
      [join(root, 'session_index.jsonl')]: [
        JSON.stringify({ id: 'renamed', thread_name: ` Updated\n ${'名'.repeat(100)} `, updated_at: new Date(EPOCH + 8_000).toISOString() }),
        JSON.stringify({ id: 'renamed', thread_name: 'Older title after newer record', updated_at: new Date(EPOCH + 7_000).toISOString() }),
        '{"id":"incomplete"',
      ].join('\n'),
    }
    const sessions = await discoverGlobalCodexSessions({ roots: { codex: root }, reader: fixtureReader(files, { [byMtime]: EPOCH + 10_000 }) })
    expect(sessions.map(({ id, updatedAt }) => ({ id, updatedAt }))).toEqual([
      { id: 'mtime', updatedAt: EPOCH + 10_000 },
      { id: 'renamed', updatedAt: EPOCH + 8_000 },
      { id: 'history', updatedAt: EPOCH + 6_000 },
      { id: 'created', updatedAt: EPOCH + 4_000 },
    ])
    expect(sessions[0]?.workspace).toBe('B:\\original-cwd')
    expect(sessions[1]?.title).toBe(`Updated ${'名'.repeat(71)}…`)
    expect(sessions[2]?.title).toBe('First prompt')
  })

  it('deduplicates before limiting, excludes all subagent markers, and rejects malformed or truncated metadata', async () => {
    const root = join(tmpdir(), 'global-codex-filter-fixture')
    const records = {
      'main-old': meta('main', 'B:\\old'),
      'main-new': meta('main', 'B:\\new', { secret: 'fixture-only-value' }),
      'child-string': meta('child-string', 'B:\\repo', { source: 'subagent' }),
      'child-object': meta('child-object', 'B:\\repo', { source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } } }),
      'child-parent': meta('child-parent', 'B:\\repo', { parent_thread_id: 'main' }),
      'empty-id': meta('   '),
      'empty-cwd': meta('empty-cwd', ' '),
      'bad-payload': JSON.stringify({ type: 'session_meta', payload: [] }),
      'bad-json': '{"type":"session_meta","payload":',
      'later-meta': `{}\n${meta('later-meta')}`,
      valid: '\uFEFF' + meta('valid'),
    }
    const files = Object.fromEntries(Object.entries(records).map(([name, value]) => [join(root, 'sessions', `rollout-${name}.jsonl`), value]))
    files[join(root, 'sessions', 'auth.json')] = 'must never read'
    const reader = fixtureReader(files, { [join(root, 'sessions', 'rollout-main-new.jsonl')]: EPOCH })
    const sessions = await discoverGlobalCodexSessions({ roots: { codex: root }, reader, limit: 2 })
    expect(sessions).toEqual([
      { id: 'main', title: 'main', workspace: 'B:\\new', updatedAt: EPOCH },
      { id: 'valid', title: 'valid', workspace: 'B:\\fixture-workspace', updatedAt: 0 },
    ])
    expect(reader.readFirstLine).toHaveBeenCalledTimes(Object.keys(records).length)
    expect(reader.readLines).toHaveBeenCalledTimes(2)
    expect(reader.readLines).toHaveBeenCalledWith(join(root, 'history.jsonl'))
    expect(reader.readLines).toHaveBeenCalledWith(join(root, 'session_index.jsonl'))
  })

  it('sorts ties deterministically regardless of traversal order', async () => {
    const root = join(tmpdir(), 'global-codex-ties-fixture')
    const files = {
      [join(root, 'sessions', 'rollout-z.jsonl')]: meta('z'),
      [join(root, 'sessions', 'rollout-a.jsonl')]: meta('a', 'B:\\z-workspace'),
      [join(root, 'sessions', 'rollout-a-copy.jsonl')]: meta('a', 'B:\\a-workspace'),
    }
    const sessions = await discoverGlobalCodexSessions({ roots: { codex: root }, reader: fixtureReader(files) })
    expect(sessions.map(({ id }) => id)).toEqual(['a', 'z'])
    expect(sessions[0]?.workspace).toBe('B:\\a-workspace')
  })

  it('coalesces concurrent scans but refreshes changed, added, removed, and formerly truncated metadata', async () => {
    const root = join(tmpdir(), 'global-codex-cache-fixture')
    const first = join(root, 'sessions', 'rollout-first.jsonl')
    const broken = join(root, 'sessions', 'rollout-broken.jsonl')
    const history = join(root, 'history.jsonl')
    const files = { [first]: meta('first'), [broken]: '{"type":', [history]: '' }
    const mtimes = { [first]: EPOCH }
    const reader = fixtureReader(files, mtimes, true)
    const options = { roots: { codex: root }, reader }
    const results = await Promise.all([discoverGlobalCodexSessions(options), discoverGlobalCodexSessions({ ...options, limit: 1 })])
    expect(results[0]).toEqual(results[1])
    expect(reader.listFiles).toHaveBeenCalledTimes(1)
    expect(reader.readFirstLine).toHaveBeenCalledTimes(2)
    await discoverGlobalCodexSessions(options)
    expect(reader.readFirstLine).toHaveBeenCalledTimes(2)

    // Size changes must invalidate fingerprints even on coarse timestamp filesystems.
    files[broken] = meta('fixed', 'B:\\fixed')
    files[history] = JSON.stringify({ session_id: 'fixed', ts: (EPOCH + 1_000) / 1_000, text: 'Recovered metadata' }) + '\n'
    const added = join(root, 'sessions', 'rollout-added.jsonl')
    files[added] = meta('added')
    const changed = await discoverGlobalCodexSessions(options)
    expect(changed.map(({ id }) => id)).toEqual(['fixed', 'first', 'added'])
    expect(changed[0]?.title).toBe('Recovered metadata')
    expect(reader.readFirstLine).toHaveBeenCalledTimes(4)
    delete files[first]
    expect((await discoverGlobalCodexSessions(options)).map(({ id }) => id)).toEqual(['fixed', 'added'])
  })

  it('does not cache transient rollout or index read errors', async () => {
    const root = join(tmpdir(), 'global-codex-retry-fixture')
    const rollout = join(root, 'sessions', 'rollout-retry.jsonl')
    const history = join(root, 'history.jsonl')
    const files = { [rollout]: meta('retry'), [history]: JSON.stringify({ session_id: 'retry', ts: EPOCH / 1_000, text: 'Recovered index' }) + '\n' }
    const reader = fixtureReader(files, {}, true)
    vi.mocked(reader.readFirstLine).mockRejectedValueOnce(new Error('Transient fixture read error'))
    const readLines = reader.readLines
    let failed = false
    reader.readLines = vi.fn((file: string) => {
      if (file === history && !failed) {
        failed = true
        return (async function* () { throw new Error('Transient fixture index error') })()
      }
      return readLines(file)
    })
    const options = { roots: { codex: root }, reader }
    expect(await discoverGlobalCodexSessions(options)).toEqual([])
    expect(await discoverGlobalCodexSessions(options)).toEqual([
      { id: 'retry', title: 'Recovered index', workspace: 'B:\\fixture-workspace', updatedAt: EPOCH },
    ])
  })

  it('invalidates same-size metadata replacements when only ctime changes', async () => {
    const root = join(tmpdir(), 'global-codex-replacement-fixture')
    const rollout = join(root, 'sessions', 'rollout-replaced.jsonl')
    const files = { [rollout]: meta('before') }
    const reader = fixtureReader(files, {}, true)
    let ctimeMs = 1
    const originalStat = reader.stat!
    reader.stat = vi.fn(async (file: string) => ({ ...await originalStat(file), ctimeMs }))
    const options = { roots: { codex: root }, reader }
    expect((await discoverGlobalCodexSessions(options))[0]?.id).toBe('before')
    files[rollout] = meta('after!')
    ctimeMs += 1
    expect((await discoverGlobalCodexSessions(options))[0]?.id).toBe('after!')
    expect(reader.readFirstLine).toHaveBeenCalledTimes(2)
  })

  it('returns an empty list for missing session directories or unreadable rollouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'global-codex-missing-fixture-'))
    tempRoots.push(root)
    expect(await discoverGlobalCodexSessions({ roots: { codex: root } })).toEqual([])
    const reader = fixtureReader({ [join(root, 'sessions', 'rollout-unreadable.jsonl')]: meta('unreadable') })
    vi.mocked(reader.readFirstLine).mockRejectedValue(new Error('Unreadable fixture'))
    expect(await discoverGlobalCodexSessions({ roots: { codex: root }, reader })).toEqual([])
    vi.mocked(reader.listFiles).mockRejectedValue(new Error('Unreadable directory fixture'))
    expect(await discoverGlobalCodexSessions({ roots: { codex: root }, reader })).toEqual([])
  })

  it('streams beyond the former 64 MiB history cap, skips oversized lines, and ignores incomplete tails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'global-codex-large-history-fixture-'))
    tempRoots.push(root)
    await mkdir(join(root, 'sessions'))
    await writeFile(join(root, 'sessions', 'rollout-newest.jsonl'), meta('newest'))
    const history = join(root, 'history.jsonl')
    await writeFile(history, '')
    await truncate(history, 64 * 1024 * 1024 + 1)
    await appendFile(history, '\n' + JSON.stringify({ session_id: 'newest', ts: 9_000_000_000, text: 'After the old cap' }) + '\n'
      + JSON.stringify({ session_id: 'newest', ts: 9_100_000_000, text: 'Incomplete tail must be ignored' }))
    const sessions = await discoverGlobalCodexSessions({ roots: { codex: root } })
    expect(sessions[0]?.title).toBe('After the old cap')
    expect(sessions[0]?.updatedAt).toBe(9_000_000_000_000)
  }, 15_000)

  it('uses the explicit CODEX_HOME fixture, bounds first-line parsing, and retains missing original cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'global-codex-home-fixture-'))
    tempRoots.push(root)
    await mkdir(join(root, 'sessions', 'nested'), { recursive: true })
    const cwd = join(root, 'workspace-that-does-not-exist')
    await writeFile(join(root, 'sessions', 'nested', 'rollout-valid.jsonl'), meta('valid', cwd))
    await writeFile(join(root, 'sessions', 'rollout-too-large.jsonl'), 'x'.repeat(2 * 1024 * 1024 + 1) + '\n' + meta('hidden'))
    vi.stubEnv('CODEX_HOME', root)
    const sessions = await discoverGlobalCodexSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.workspace).toBe(cwd)
    expect(sessions[0]?.id).toBe('valid')
  })

  it('keeps recent handoff discovery compatible and does not scan for a zero limit', async () => {
    const root = join(tmpdir(), 'global-codex-limit-fixture')
    const reader = fixtureReader({
      [join(root, 'sessions', 'rollout-old.jsonl')]: meta('old'),
      [join(root, 'sessions', 'rollout-recent.jsonl')]: meta('recent'),
    }, { [join(root, 'sessions', 'rollout-old.jsonl')]: EPOCH, [join(root, 'sessions', 'rollout-recent.jsonl')]: EPOCH + 10 })
    const options = { roots: { codex: root }, reader }
    expect(await discoverGlobalCodexSessions({ ...options, limit: 0 })).toEqual([])
    expect(reader.listFiles).not.toHaveBeenCalled()
    expect((await discoverRecentNativeSessions('codex', EPOCH + 5, options)).map(({ id }) => id)).toEqual(['recent'])
  })
})
