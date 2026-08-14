import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, win32 } from 'node:path'

import type { AgentKind, NativeSessionSummary } from '../src/shared/manager-api'

export interface NativeSessionDiscoveryReader {
  listFiles(root: string): Promise<string[]>
  readFirstLine(file: string): Promise<string>
  readLines(file: string): AsyncIterable<string>
  mtime(file: string): Promise<number>
}

export interface NativeSessionDiscoveryOptions {
  roots?: Partial<Record<'codex' | 'claude', string>>
  reader?: NativeSessionDiscoveryReader
}

interface CodexHistory {
  title?: string
  updatedAt?: number
}

interface ClaudeSession {
  title?: string
  updatedAt: number
}

const TITLE_LIMIT = 80
const MAX_FIRST_LINE_BYTES = 2 * 1024 * 1024
const MAX_HISTORY_LINE_BYTES = 2 * 1024 * 1024
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const MAX_DISCOVERY_FILES = 10_000
const MAX_WALK_ENTRIES = 20_000
const MAX_RESULTS = 200
const READ_CHUNK_BYTES = 64 * 1024

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const directories = [root]
  let visitedEntries = 0
  while (directories.length > 0 && files.length < MAX_DISCOVERY_FILES && visitedEntries < MAX_WALK_ENTRIES) {
    const directory = directories.pop()!
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries > MAX_WALK_ENTRIES) break
      const child = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(child)
      else if (entry.isFile()) files.push(child)
      if (files.length >= MAX_DISCOVERY_FILES) break
    }
  }
  return files
}

async function readFirstLine(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  const chunks: Buffer[] = []
  const buffer = Buffer.allocUnsafe(4_096)
  let position = 0
  try {
    while (position < MAX_FIRST_LINE_BYTES) {
      const length = Math.min(buffer.length, MAX_FIRST_LINE_BYTES - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      const end = newline === -1 ? bytesRead : newline
      chunks.push(Buffer.from(buffer.subarray(0, end)))
      if (newline !== -1) break
      position += bytesRead
    }
    if (position >= MAX_FIRST_LINE_BYTES) throw new Error('Session metadata first line is too large')
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
  } finally {
    await handle.close()
  }
}

async function* readLines(file: string): AsyncIterable<string> {
  const handle = await fs.open(file, 'r')
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let totalBytes = 0
  let lineBytes = 0
  let chunks: Buffer[] = []
  let discarding = false
  const append = (segment: Buffer): void => {
    if (discarding || segment.length === 0) return
    if (lineBytes + segment.length > MAX_HISTORY_LINE_BYTES) {
      discarding = true
      chunks = []
      lineBytes = 0
      return
    }
    chunks.push(Buffer.from(segment))
    lineBytes += segment.length
  }
  try {
    while (totalBytes < MAX_HISTORY_BYTES) {
      const length = Math.min(buffer.length, MAX_HISTORY_BYTES - totalBytes)
      const { bytesRead } = await handle.read(buffer, 0, length, null)
      if (bytesRead === 0) return
      totalBytes += bytesRead
      let start = 0
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue
        append(buffer.subarray(start, index))
        if (!discarding) yield Buffer.concat(chunks, lineBytes).toString('utf8').replace(/\r$/, '')
        chunks = []
        lineBytes = 0
        discarding = false
        start = index + 1
      }
      append(buffer.subarray(start, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

const defaultReader: NativeSessionDiscoveryReader = {
  listFiles: walk,
  readFirstLine,
  readLines,
  mtime: async (file) => (await fs.stat(file)).mtimeMs,
}

function normalizeWorkspace(workspace: string): string {
  const normalized = win32.normalize(workspace.replaceAll('/', '\\'))
  const root = win32.parse(normalized).root
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized
  return withoutTrailingSeparators.toLocaleLowerCase('en-US')
}

function sameWorkspace(left: unknown, right: string): left is string {
  return typeof left === 'string' && normalizeWorkspace(left) === normalizeWorkspace(right)
}

function titleFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flattened = value.replace(/\s+/g, ' ').trim()
  if (!flattened) return undefined
  const characters = [...flattened]
  return characters.length <= TITLE_LIMIT
    ? flattened
    : `${characters.slice(0, TITLE_LIMIT - 1).join('')}…`
}

function timestampFrom(value: unknown, secondsAreExpected = false): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return secondsAreExpected && Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return secondsAreExpected && Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line.replace(/^\uFEFF/, ''))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function isTopLevelCodexSession(meta: Record<string, unknown>): boolean {
  if (typeof meta.parent_thread_id === 'string' && meta.parent_thread_id.trim()) return false

  const source = meta.source
  if (source === 'subagent') return false
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    if (Object.prototype.hasOwnProperty.call(source, 'subagent')) return false
  }
  return true
}

async function* linesOrEmpty(reader: NativeSessionDiscoveryReader, file: string): AsyncIterable<string> {
  try {
    for await (const line of reader.readLines(file)) yield line
  } catch {
    return
  }
}

async function codexHistory(reader: NativeSessionDiscoveryReader, root: string): Promise<Map<string, CodexHistory>> {
  const histories = new Map<string, CodexHistory>()
  for await (const line of linesOrEmpty(reader, join(root, 'history.jsonl'))) {
    const record = jsonRecord(line)
    const id = record?.session_id
    if (typeof id !== 'string' || !id) continue
    const existing = histories.get(id) ?? {}
    const title = titleFrom(record.text)
    const updatedAt = timestampFrom(record.ts, true)
    histories.set(id, {
      ...(existing.title ? { title: existing.title } : title ? { title } : {}),
      ...(updatedAt === undefined
        ? existing.updatedAt === undefined ? {} : { updatedAt: existing.updatedAt }
        : { updatedAt: Math.max(existing.updatedAt ?? Number.NEGATIVE_INFINITY, updatedAt) }),
    })
  }
  return histories
}

async function discoverCodex(
  workspace: string,
  root: string,
  reader: NativeSessionDiscoveryReader,
): Promise<NativeSessionSummary[]> {
  const history = await codexHistory(reader, root)
  let files: string[]
  try {
    files = await reader.listFiles(join(root, 'sessions'))
  } catch {
    return []
  }
  const sessions = new Map<string, NativeSessionSummary>()
  for (const file of files.slice(0, MAX_DISCOVERY_FILES)) {
    if (!/^rollout.*\.jsonl$/i.test(basename(file))) continue
    let firstLine: string
    try {
      firstLine = await reader.readFirstLine(file)
    } catch {
      continue
    }
    const record = jsonRecord(firstLine)
    const payload = record?.payload
    if (record?.type !== 'session_meta' || payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue
    const meta = payload as Record<string, unknown>
    const id = meta.id
    if (!isTopLevelCodexSession(meta) || typeof id !== 'string' || !id || !sameWorkspace(meta.cwd, workspace)) continue
    let baseUpdatedAt = timestampFrom(meta.timestamp, true)
    if (baseUpdatedAt === undefined) {
      try {
        baseUpdatedAt = await reader.mtime(file)
      } catch {
        baseUpdatedAt = 0
      }
    }
    const sessionHistory = history.get(id)
    const candidate: NativeSessionSummary = {
      id,
      title: sessionHistory?.title ?? id,
      updatedAt: sessionHistory?.updatedAt ?? baseUpdatedAt,
      workspace,
    }
    const previous = sessions.get(id)
    if (!previous || candidate.updatedAt > previous.updatedAt) sessions.set(id, candidate)
  }
  return sortSessions(sessions.values())
}

async function discoverClaude(
  workspace: string,
  root: string,
  reader: NativeSessionDiscoveryReader,
): Promise<NativeSessionSummary[]> {
  const grouped = new Map<string, ClaudeSession>()
  for await (const line of linesOrEmpty(reader, join(root, 'history.jsonl'))) {
    const record = jsonRecord(line)
    const id = record?.sessionId
    if (typeof id !== 'string' || !id || !sameWorkspace(record?.project, workspace)) {
      continue
    }
    const updatedAt = timestampFrom(record.timestamp) ?? 0
    const display = titleFrom(record.display)
    const existing = grouped.get(id) ?? { updatedAt: 0 }
    grouped.set(id, {
      ...(existing.title ? { title: existing.title } : display ? { title: display } : {}),
      updatedAt: Math.max(existing.updatedAt, updatedAt),
    })
  }
  return sortSessions([...grouped].map(([id, session]) => ({
    id,
    title: session.title ?? id,
    updatedAt: session.updatedAt,
    workspace,
  })))
}

function sortSessions(sessions: Iterable<NativeSessionSummary>): NativeSessionSummary[] {
  return [...sessions]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, MAX_RESULTS)
}

export async function discoverNativeSessions(
  agentKind: AgentKind,
  workspace: string,
  options: NativeSessionDiscoveryOptions = {},
): Promise<NativeSessionSummary[]> {
  const reader = options.reader ?? defaultReader
  if (agentKind === 'codex') {
    return discoverCodex(workspace, options.roots?.codex ?? join(homedir(), '.codex'), reader)
  }
  if (agentKind === 'claude') {
    return discoverClaude(workspace, options.roots?.claude ?? join(homedir(), '.claude'), reader)
  }
  return []
}

export async function discoverRecentNativeSessions(
  agentKind: 'codex' | 'claude',
  since: number,
  options: NativeSessionDiscoveryOptions = {},
): Promise<NativeSessionSummary[]> {
  const reader = options.reader ?? defaultReader
  if (agentKind === 'codex') {
    const root = options.roots?.codex ?? join(homedir(), '.codex')
    const history = await codexHistory(reader, root)
    let files: string[]
    try { files = await reader.listFiles(join(root, 'sessions')) } catch { return [] }
    const sessions = new Map<string, NativeSessionSummary>()
    for (const file of files.slice(0, MAX_DISCOVERY_FILES)) {
      if (!/^rollout.*\.jsonl$/i.test(basename(file))) continue
      let record: Record<string, unknown> | undefined
      try { record = jsonRecord(await reader.readFirstLine(file)) } catch { continue }
      const payload = record?.payload
      if (record?.type !== 'session_meta' || !payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const meta = payload as Record<string, unknown>
      if (!isTopLevelCodexSession(meta) || typeof meta.id !== 'string' || typeof meta.cwd !== 'string') continue
      let updatedAt = history.get(meta.id)?.updatedAt
      try { updatedAt = Math.max(updatedAt ?? 0, await reader.mtime(file)) } catch { /* history timestamp remains usable */ }
      if (!updatedAt || updatedAt < since) continue
      const candidate: NativeSessionSummary = { id: meta.id, title: history.get(meta.id)?.title ?? meta.id, updatedAt, workspace: meta.cwd }
      const previous = sessions.get(meta.id)
      if (!previous || candidate.updatedAt > previous.updatedAt) sessions.set(meta.id, candidate)
    }
    return sortSessions(sessions.values())
  }

  const root = options.roots?.claude ?? join(homedir(), '.claude')
  const sessions = new Map<string, NativeSessionSummary>()
  for await (const line of linesOrEmpty(reader, join(root, 'history.jsonl'))) {
    const record = jsonRecord(line)
    const id = record?.sessionId
    const workspace = record?.project
    const updatedAt = timestampFrom(record?.timestamp) ?? 0
    if (typeof id !== 'string' || typeof workspace !== 'string' || updatedAt < since) continue
    const previous = sessions.get(id)
    const candidate: NativeSessionSummary = { id, title: previous?.title ?? titleFrom(record?.display) ?? id, updatedAt: Math.max(previous?.updatedAt ?? 0, updatedAt), workspace }
    sessions.set(id, candidate)
  }
  return sortSessions(sessions.values())
}
