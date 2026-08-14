import { win32 } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  discoverNativeSessions,
  discoverRecentNativeSessions,
  type NativeSessionDiscoveryReader,
} from '../../electron/native-session-discovery'

function memoryReader(
  files: Record<string, string>,
  mtimes: Record<string, number> = {},
): NativeSessionDiscoveryReader {
  return {
    listFiles: vi.fn(async (root) => Object.keys(files).filter((file) => file.toLowerCase().startsWith(root.toLowerCase()))),
    readFirstLine: vi.fn(async (file) => {
      if (!(file in files)) throw new Error(`Missing fixture: ${file}`)
      return files[file]!.split(/\r?\n/, 1)[0] ?? ''
    }),
    readLines: vi.fn((file) => (async function* () {
      if (!(file in files)) throw new Error(`Missing fixture: ${file}`)
      const content = files[file]!
      const lines = content.split(/\r?\n/)
      const completeLineCount = /\r?\n$/.test(content) ? lines.length - 1 : lines.length - 1
      for (let index = 0; index < completeLineCount; index += 1) yield lines[index]!
    })()),
    mtime: vi.fn(async (file) => mtimes[file] ?? 0),
  }
}

describe('discoverNativeSessions', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('discovers only Codex rollouts for the requested Windows workspace', async () => {
    const root = 'C:\\fixture\\.codex'
    const history = win32.join(root, 'history.jsonl')
    const alpha = win32.join(root, 'sessions', '2026', '08', 'rollout-alpha.jsonl')
    const alphaDuplicate = win32.join(root, 'sessions', '2026', '08', 'rollout-alpha-copy.jsonl')
    const beta = win32.join(root, 'sessions', '2026', '08', 'rollout-beta.jsonl')
    const foreign = win32.join(root, 'sessions', '2026', '08', 'rollout-foreign.jsonl')
    const invalidFirstLine = win32.join(root, 'sessions', '2026', '08', 'rollout-invalid.jsonl')
    const longTitle = `  First line\n  ${'x'.repeat(90)}  `
    const files = {
      [alpha]: `${JSON.stringify({ type: 'session_meta', payload: { id: 'alpha', cwd: 'b:/WORK/demo/', timestamp: '2026-08-01T00:00:00.000Z' } })}\n{"ignored":true}`,
      [alphaDuplicate]: JSON.stringify({ type: 'session_meta', payload: { id: 'alpha', cwd: 'B:\\work\\demo', timestamp: '2026-07-01T00:00:00.000Z' } }),
      [beta]: JSON.stringify({ type: 'session_meta', payload: { id: 'beta', cwd: 'B:\\work\\demo\\' } }),
      [foreign]: JSON.stringify({ type: 'session_meta', payload: { id: 'secret', cwd: 'B:\\work\\demo-other', timestamp: '2026-09-01T00:00:00.000Z' } }),
      [invalidFirstLine]: `{"type":"event"}\n${JSON.stringify({ type: 'session_meta', payload: { id: 'must-not-leak', cwd: 'B:\\work\\demo' } })}`,
      [history]: [
        JSON.stringify({ session_id: 'alpha', ts: 1_786_000_001, text: longTitle }),
        JSON.stringify({ session_id: 'alpha', ts: 1_786_000_003, text: 'later title' }),
        JSON.stringify({ session_id: 'alpha', ts: 1_786_000_002, text: '   ' }),
        JSON.stringify({ session_id: 'secret', ts: 1_999_000_000, text: 'foreign workspace text' }),
        '{not-json}',
      ].join('\n'),
    }
    const reader = memoryReader(files, { [beta]: 1_785_000_000_000 })

    const sessions = await discoverNativeSessions('codex', 'B:\\work\\demo\\', {
      roots: { codex: root },
      reader,
    })

    expect(sessions).toEqual([
      {
        id: 'alpha',
        title: `First line ${'x'.repeat(68)}…`,
        updatedAt: 1_786_000_003_000,
        workspace: 'B:\\work\\demo\\',
      },
      {
        id: 'beta',
        title: 'beta',
        updatedAt: 1_785_000_000_000,
        workspace: 'B:\\work\\demo\\',
      },
    ])
    expect(reader.readFirstLine).toHaveBeenCalledTimes(5)
    expect(reader.readLines).toHaveBeenCalledTimes(1)
    expect(reader.readLines).toHaveBeenCalledWith(history)
  })

  it('filters Codex subagent rollouts from history and recent handoff candidates', async () => {
    const root = 'C:\\fixture\\.codex'
    const main = win32.join(root, 'sessions', 'rollout-main.jsonl')
    const sourceChild = win32.join(root, 'sessions', 'rollout-source-child.jsonl')
    const parentChild = win32.join(root, 'sessions', 'rollout-parent-child.jsonl')
    const history = win32.join(root, 'history.jsonl')
    const files = {
      [main]: JSON.stringify({ type: 'session_meta', payload: { id: 'main', cwd: 'B:\\repo', source: 'cli' } }),
      [sourceChild]: JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'source-child',
          cwd: 'B:\\repo',
          source: { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1 } } },
        },
      }),
      [parentChild]: JSON.stringify({
        type: 'session_meta',
        payload: { id: 'parent-child', cwd: 'B:\\repo', source: 'cli', parent_thread_id: 'main' },
      }),
      [history]: '',
    }
    const reader = memoryReader(files, {
      [main]: 10_000,
      [sourceChild]: 11_000,
      [parentChild]: 12_000,
    })

    await expect(discoverNativeSessions('codex', 'B:\\repo', {
      roots: { codex: root },
      reader,
    })).resolves.toEqual([
      { id: 'main', title: 'main', updatedAt: 10_000, workspace: 'B:\\repo' },
    ])

    await expect(discoverRecentNativeSessions('codex', 5_000, {
      roots: { codex: root },
      reader,
    })).resolves.toEqual([
      { id: 'main', title: 'main', updatedAt: 10_000, workspace: 'B:\\repo' },
    ])
  })

  it('deduplicates Claude history using the first file-order title and latest timestamp', async () => {
    const root = 'C:\\fixture\\.claude'
    const history = win32.join(root, 'history.jsonl')
    const reader = memoryReader({
      [history]: [
        JSON.stringify({ sessionId: 'claude-a', project: 'B:\\Repo\\', timestamp: 300, display: 'first in file title' }),
        JSON.stringify({ sessionId: 'claude-a', project: 'b:/repo', timestamp: 100, display: '   ' }),
        JSON.stringify({ sessionId: 'claude-a', project: 'B:\\repo', timestamp: 200, display: 'earlier timestamp but later in file' }),
        JSON.stringify({ sessionId: 'claude-b', project: 'B:\\repo\\', timestamp: 400, display: 'Newest session' }),
        JSON.stringify({ sessionId: 'claude-empty', project: 'B:\\repo', timestamp: 250, display: '' }),
        JSON.stringify({ sessionId: 'foreign', project: 'B:\\repo2', timestamp: 999, display: 'must not leak' }),
        '{bad-json}',
      ].join('\n'),
    })

    const sessions = await discoverNativeSessions('claude', 'B:\\repo', {
      roots: { claude: root },
      reader,
    })

    expect(sessions).toEqual([
      { id: 'claude-b', title: 'Newest session', updatedAt: 400, workspace: 'B:\\repo' },
      { id: 'claude-a', title: 'first in file title', updatedAt: 300, workspace: 'B:\\repo' },
      { id: 'claude-empty', title: 'claude-empty', updatedAt: 250, workspace: 'B:\\repo' },
    ])
  })

  it.each(['pi', 'generic'] as const)('returns no discoverable sessions for %s', async (agentKind) => {
    const reader: NativeSessionDiscoveryReader = {
      listFiles: vi.fn(),
      readFirstLine: vi.fn(),
      readLines: vi.fn(() => (async function* () {})()),
      mtime: vi.fn(),
    }

    await expect(discoverNativeSessions(agentKind, 'B:\\repo', { reader })).resolves.toEqual([])
    expect(reader.listFiles).not.toHaveBeenCalled()
    expect(reader.readFirstLine).not.toHaveBeenCalled()
    expect(reader.readLines).not.toHaveBeenCalled()
    expect(reader.mtime).not.toHaveBeenCalled()
  })

  it('bounds rollout metadata to the first 2 MiB and never scans a later line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-codex-'))
    tempRoots.push(root)
    const sessionsRoot = join(root, 'sessions')
    await mkdir(sessionsRoot)
    await writeFile(join(sessionsRoot, 'rollout-large.jsonl'), `${'x'.repeat(2 * 1024 * 1024 + 1)}\n${JSON.stringify({
      type: 'session_meta', payload: { id: 'must-not-appear', cwd: 'B:\\repo' },
    })}\n`)

    await expect(discoverNativeSessions('codex', 'B:\\repo', {
      roots: { codex: root },
    })).resolves.toEqual([])
  })

  it('streams history, skips overlong lines, and ignores an incomplete tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-claude-'))
    tempRoots.push(root)
    const history = join(root, 'history.jsonl')
    const valid = JSON.stringify({ sessionId: 'valid', project: 'B:\\repo', timestamp: 2, display: 'valid' })
    const incomplete = JSON.stringify({ sessionId: 'incomplete', project: 'B:\\repo', timestamp: 3, display: 'no newline' })
    await writeFile(history, `${'x'.repeat(2 * 1024 * 1024 + 1)}\n${valid}\n${incomplete}`)

    await expect(discoverNativeSessions('claude', 'B:\\repo', {
      roots: { claude: root },
    })).resolves.toEqual([
      { id: 'valid', title: 'valid', updatedAt: 2, workspace: 'B:\\repo' },
    ])
  })

  it('returns at most 200 newest sessions', async () => {
    const root = 'C:\\fixture\\.claude'
    const history = win32.join(root, 'history.jsonl')
    const lines = Array.from({ length: 205 }, (_, index) => JSON.stringify({
      sessionId: `session-${index.toString().padStart(3, '0')}`,
      project: 'B:\\repo',
      timestamp: index,
      display: `Session ${index}`,
    })).join('\n') + '\n'

    const sessions = await discoverNativeSessions('claude', 'B:\\repo', {
      roots: { claude: root },
      reader: memoryReader({ [history]: lines }),
    })

    expect(sessions).toHaveLength(200)
    expect(sessions[0]?.id).toBe('session-204')
    expect(sessions.at(-1)?.id).toBe('session-005')
  })

  it('finds only recent Codex candidates across workspaces for native drag handoff', async () => {
    const root = 'C:\\fixture\\.codex'
    const recent = win32.join(root, 'sessions', 'rollout-recent.jsonl')
    const old = win32.join(root, 'sessions', 'rollout-old.jsonl')
    const reader = memoryReader({
      [recent]: JSON.stringify({ type: 'session_meta', payload: { id: 'recent', cwd: 'B:\\Recent' } }),
      [old]: JSON.stringify({ type: 'session_meta', payload: { id: 'old', cwd: 'B:\\Old' } }),
      [win32.join(root, 'history.jsonl')]: '',
    }, { [recent]: 10_000, [old]: 1_000 })

    await expect(discoverRecentNativeSessions('codex', 5_000, { roots: { codex: root }, reader })).resolves.toEqual([
      { id: 'recent', title: 'recent', updatedAt: 10_000, workspace: 'B:\\Recent' },
    ])
  })
})
