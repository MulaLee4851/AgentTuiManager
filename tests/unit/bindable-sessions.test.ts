import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { discoverBindableSessions, type NativeSessionDiscoveryReader } from '../../electron/native-session-discovery'

it('lists actual Claude transcripts, excluding missing, foreign and subagent history', async () => {
  const root = 'fixture'
  const workspace = 'B:\\work'
  const files = {
    [join(root, 'history.jsonl')]: JSON.stringify({ sessionId: 'missing', project: workspace, display: 'deleted history' }),
    [join(root, 'projects', 'work', 'real.jsonl')]: JSON.stringify({ sessionId: 'real', cwd: workspace, type: 'user', message: { content: 'hello' } }),
    [join(root, 'projects', 'other', 'foreign.jsonl')]: JSON.stringify({ sessionId: 'foreign', cwd: 'B:\\elsewhere', type: 'user' }),
    [join(root, 'projects', 'work', 'subagents', 'child.jsonl')]: JSON.stringify({ sessionId: 'child', cwd: workspace, type: 'user' }),
    [join(root, 'projects', 'work', 'sidechain.jsonl')]: JSON.stringify({ sessionId: 'sidechain', cwd: workspace, type: 'assistant', isSidechain: true }),
    [join(root, 'projects', 'work', 'agent.jsonl')]: JSON.stringify({ sessionId: 'agent', cwd: workspace, type: 'assistant', agentId: 'child' }),
    [join(root, 'projects', 'work', 'mismatched.jsonl')]: JSON.stringify({ sessionId: 'other', cwd: workspace, type: 'user' }),
    [join(root, 'projects', 'work', 'empty.jsonl')]: JSON.stringify({ type: 'file-history-snapshot' }),
  }
  const reader: NativeSessionDiscoveryReader = {
    listFiles: async () => Object.keys(files).filter(file => file.includes('projects')),
    readLines: file => (async function* () { if (files[file]) yield files[file] })(),
    readFirstLine: async file => files[file] ?? '', mtime: async () => 10,
  }
  expect(await discoverBindableSessions('claude', workspace, { roots: { claude: root }, reader })).toEqual([{ id: 'real', workspace, title: 'real', updatedAt: 10 }])
})

it('deduplicates actual transcripts, orders by latest activity, and returns only bounded history titles', async () => {
  const root = 'fixture'
  const workspace = 'B:\\work'
  const first = join(root, 'projects', 'one', 'real.jsonl')
  const duplicate = join(root, 'projects', 'two', 'real.jsonl')
  const second = join(root, 'projects', 'one', 'second.jsonl')
  const history = join(root, 'history.jsonl')
  const files: Record<string, string[]> = {
    [history]: [JSON.stringify({ sessionId: 'real', project: workspace, display: 'A'.repeat(200), timestamp: 20 })],
    [first]: [JSON.stringify({ sessionId: 'real', cwd: 'b:/WORK/', type: 'user', message: { content: 'private synthetic transcript text' } })],
    [duplicate]: [JSON.stringify({ sessionId: 'real', cwd: workspace, type: 'assistant' })],
    [second]: [JSON.stringify({ sessionId: 'second', cwd: workspace, type: 'user' })],
  }
  const reader: NativeSessionDiscoveryReader = {
    listFiles: async () => [first, duplicate, first, second],
    readLines: vi.fn(file => (async function* () { yield* files[file] ?? [] })()),
    readFirstLine: async () => '',
    mtime: async file => file === duplicate ? 30 : file === second ? 25 : 10,
  }
  const sessions = await discoverBindableSessions('claude', workspace, { roots: { claude: root }, reader })
  expect(sessions).toEqual([
    { id: 'real', workspace, title: 'A'.repeat(79) + '…', updatedAt: 30 },
    { id: 'second', workspace, title: 'second', updatedAt: 25 },
  ])
  expect(JSON.stringify(sessions)).not.toContain('private synthetic transcript text')
  expect(reader.readLines).toHaveBeenCalledTimes(4)
})

it('keeps late directory entries discoverable and closes each bounded transcript prefix', async () => {
  const root = 'fixture'
  const workspace = 'B:\\work'
  const path = join(root, 'projects', 'work', 'real.jsonl')
  const empty = join(root, 'projects', 'work', 'empty.jsonl')
  let lines = 0
  let closed = false
  const reader: NativeSessionDiscoveryReader = {
    listFiles: async () => [
      ...Array.from({ length: 20_001 }, (_, index) => join(root, 'projects', 'work', index + '.txt')),
      empty, path,
    ],
    readLines: file => (async function* () {
      if (file === path) yield JSON.stringify({ sessionId: 'real', cwd: workspace, type: 'user' })
      if (file === empty) {
        try {
          for (let index = 0; index < 1_000; index += 1) { lines += 1; yield JSON.stringify({ type: 'file-history-snapshot' }) }
        } finally { closed = true }
      }
    })(),
    readFirstLine: async () => '',
    mtime: async () => 10,
  }
  expect(await discoverBindableSessions('claude', workspace, { roots: { claude: root }, reader }))
    .toEqual([{ id: 'real', workspace, title: 'real', updatedAt: 10 }])
  expect(lines).toBe(100)
  expect(closed).toBe(true)
})
