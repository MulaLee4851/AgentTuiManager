import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'

import type { AgentKind, NativeSessionSummary } from '../src/shared/manager-api'

export interface NativeSessionDiscoveryReader {
  listFiles(root: string): Promise<string[]>
  readFirstLine(file: string): Promise<string>
  readLines(file: string): AsyncIterable<string>
  mtime(file: string): Promise<number>
  /** Optional reliable fingerprint enables caching without hiding appended data. */
  stat?(file: string): Promise<{ mtimeMs: number; size: number; ctimeMs?: number }>
}

export interface NativeSessionDiscoveryOptions {
  roots?: Partial<Record<'codex' | 'claude', string>>
  reader?: NativeSessionDiscoveryReader
}

export interface GlobalCodexSessionDiscoveryOptions extends NativeSessionDiscoveryOptions {
  /** Defaults to 50; applied after ordering and deduplication across every workspace. */
  limit?: number
  excludeSessionIds?: Iterable<string>
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
const MAX_RESULTS = 200
const READ_CHUNK_BYTES = 64 * 1024
const DISCOVERY_CONCURRENCY = 24
const MAX_CLAUDE_BINDING_LINES = 100

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const directories = [root]
  // A rollout's directory/name describes creation time, not last activity. Every
  // directory must be visited before choosing the newest sessions.
  while (directories.length > 0) {
    const directory = directories.pop()!
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(child)
      else if (entry.isFile()) files.push(child)
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
    // Bound each line and the working buffer, not total file size: stopping at a
    // byte cap silently drops the newest records from append-only indexes.
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) return
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
  stat: async (file) => {
    const { mtimeMs, ctimeMs, size } = await fs.stat(file)
    return { mtimeMs, ctimeMs, size }
  },
}

export function normalizeWorkspace(workspace: string, platform: NodeJS.Platform = process.platform): string {
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(workspace) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(workspace)
  const normalized = win32.normalize(workspace.replaceAll('/', '\\'))
  if (platform !== 'win32' && !isWindowsPath) {
    const normalized = posix.normalize(workspace.replaceAll('\\', '/'))
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  }
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
  for (const file of files) {
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

interface CodexMetadata {
  id: string
  workspace: string
  createdAt: number
}

interface GlobalCodexCache {
  metadata: Map<string, { fingerprint: string; value: CodexMetadata | undefined }>
  indexes: Map<string, { fingerprint: string; value: Map<string, CodexHistory> }>
  inFlight?: Promise<NativeSessionSummary[]>
}

// Reader-scoped caches keep fixture/custom roots isolated and store metadata
// only. Each refresh still enumerates files and checks their fingerprints.
const globalCodexCaches = new WeakMap<NativeSessionDiscoveryReader, Map<string, GlobalCodexCache>>()

function globalCodexCache(reader: NativeSessionDiscoveryReader, root: string): GlobalCodexCache {
  let roots = globalCodexCaches.get(reader)
  if (!roots) {
    roots = new Map()
    globalCodexCaches.set(reader, roots)
  }
  let cache = roots.get(root)
  if (!cache) {
    cache = { metadata: new Map(), indexes: new Map() }
    roots.set(root, cache)
  }
  return cache
}

async function fileState(reader: NativeSessionDiscoveryReader, file: string): Promise<{ updatedAt: number; fingerprint?: string }> {
  try {
    if (reader.stat) {
      const stat = await reader.stat(file)
      return {
        updatedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        fingerprint: `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs ?? ''}`,
      }
    }
    const updatedAt = await reader.mtime(file)
    return { updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 }
  } catch {
    return { updatedAt: 0 }
  }
}

async function readCodexIndex(
  reader: NativeSessionDiscoveryReader,
  file: string,
  isSessionIndex: boolean,
  cache: GlobalCodexCache,
): Promise<Map<string, CodexHistory>> {
  const { fingerprint } = await fileState(reader, file)
  const cached = cache.indexes.get(file)
  if (fingerprint !== undefined && cached?.fingerprint === fingerprint) return cached.value
  const histories = new Map<string, CodexHistory>()
  try {
    for await (const line of reader.readLines(file)) {
      const record = jsonRecord(line)
      const id = isSessionIndex ? record?.id : record?.session_id
      if (typeof id !== 'string' || !id.trim()) continue
      const existing = histories.get(id)
      const updatedAt = timestampFrom(isSessionIndex ? record?.updated_at : record?.ts, true)
      const title = titleFrom(isSessionIndex ? record?.thread_name : record?.text)
      const preferTitle = isSessionIndex && (updatedAt ?? 0) >= (existing?.updatedAt ?? 0)
      histories.set(id, {
        title: preferTitle ? title ?? existing?.title : existing?.title ?? title,
        updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt ?? 0),
      })
    }
  } catch {
    // Keep any complete records read before a transient error, but retry next
    // time rather than caching an incomplete scan under a valid fingerprint.
    cache.indexes.delete(file)
    return histories
  }
  if (fingerprint !== undefined) cache.indexes.set(file, { fingerprint, value: histories })
  return histories
}

function codexMetadata(firstLine: string): CodexMetadata | undefined {
  const record = jsonRecord(firstLine)
  const payload = record?.payload
  if (record?.type !== 'session_meta' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const meta = payload as Record<string, unknown>
  if (!isTopLevelCodexSession(meta) || typeof meta.id !== 'string' || !meta.id.trim()
    || typeof meta.cwd !== 'string' || !meta.cwd.trim()) return undefined
  return {
    id: meta.id,
    workspace: meta.cwd,
    createdAt: timestampFrom(meta.timestamp ?? record.timestamp, true) ?? 0,
  }
}

async function scanGlobalCodexSessions(
  root: string,
  reader: NativeSessionDiscoveryReader,
  cache: GlobalCodexCache,
): Promise<NativeSessionSummary[]> {
  const [listedFiles, history, index] = await Promise.all([
    reader.listFiles(join(root, 'sessions')).catch(() => [] as string[]),
    readCodexIndex(reader, join(root, 'history.jsonl'), false, cache),
    readCodexIndex(reader, join(root, 'session_index.jsonl'), true, cache),
  ])
  const files = [...new Set(listedFiles)].filter((file) => /^rollout.*\.jsonl$/i.test(basename(file)))
  const currentFiles = new Set(files)
  for (const file of cache.metadata.keys()) {
    if (!currentFiles.has(file)) cache.metadata.delete(file)
  }
  const sessions = new Map<string, NativeSessionSummary>()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++]!
      const state = await fileState(reader, file)
      const cached = cache.metadata.get(file)
      let meta: CodexMetadata | undefined
      if (state.fingerprint !== undefined && cached?.fingerprint === state.fingerprint) {
        meta = cached.value
      } else {
        try { meta = codexMetadata(await reader.readFirstLine(file)) } catch { continue }
        if (state.fingerprint !== undefined) cache.metadata.set(file, { fingerprint: state.fingerprint, value: meta })
      }
      if (!meta) continue
      const sessionHistory = history.get(meta.id)
      const sessionIndex = index.get(meta.id)
      const candidate: NativeSessionSummary = {
        id: meta.id,
        title: sessionIndex?.title ?? sessionHistory?.title ?? titleFrom(meta.id)!,
        updatedAt: Math.max(0, state.updatedAt, meta.createdAt, sessionHistory?.updatedAt ?? 0, sessionIndex?.updatedAt ?? 0),
        workspace: meta.workspace,
      }
      const previous = sessions.get(meta.id)
      if (!previous || candidate.updatedAt > previous.updatedAt
        || (candidate.updatedAt === previous.updatedAt && candidate.workspace.localeCompare(previous.workspace) < 0)) {
        sessions.set(meta.id, candidate)
      }
    }
  }))
  return [...sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

/**
 * Newest top-level Codex sessions across all workspaces. Only rollout metadata
 * and bounded titles from the two indexes are returned; transcripts stay private.
 * Missing original workspaces remain visible so callers can explain recovery.
 */
export async function discoverGlobalCodexSessions(
  options: GlobalCodexSessionDiscoveryOptions = {},
): Promise<NativeSessionSummary[]> {
  const limit = options.limit === undefined || !Number.isFinite(options.limit)
    ? 50
    : Math.max(0, Math.floor(options.limit))
  if (limit === 0) return []
  const reader = options.reader ?? defaultReader
  const root = options.roots?.codex ?? (process.env.CODEX_HOME || join(homedir(), '.codex'))
  const cache = globalCodexCache(reader, root)
  if (!cache.inFlight) {
    cache.inFlight = scanGlobalCodexSessions(root, reader, cache).finally(() => { cache.inFlight = undefined })
  }
  const excluded = new Set(options.excludeSessionIds)
  const sessions = await cache.inFlight
  return sessions.filter((session) => !excluded.has(session.id)).slice(0, limit).map((session) => ({ ...session }))
}

/** 切换绑定时只接受存在实际对话内容的会话，不把输入历史当成对话。 */
export async function discoverBindableSessions(agentKind: AgentKind, workspace: string, options: NativeSessionDiscoveryOptions = {}): Promise<NativeSessionSummary[]> {
  if (agentKind !== 'claude') return discoverNativeSessions(agentKind, workspace, options)
  const reader = options.reader ?? defaultReader
  const root = options.roots?.claude ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const history = new Map((await discoverClaude(workspace, root, reader)).map(item => [item.id, item]))
  const listedFiles = await reader.listFiles(join(root, 'projects')).catch(() => [])
  // Enumerate all directories before selecting results, with bounded parallel
  // prefix reads. Neither transcript contents nor paths leave this function.
  const files = [...new Set(listedFiles)].filter(file => /\.jsonl$/i.test(file) && !/[\\/]subagents[\\/]/i.test(file))
  const sessions = new Map<string, NativeSessionSummary>()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++]!
      const id = basename(file).replace(/\.jsonl$/i, '')
      if (!id.trim()) continue
      let count = 0
      for await (const line of linesOrEmpty(reader, file)) {
        count += 1
        const record = jsonRecord(line)
        if (record && record.sessionId === id && record.isSidechain !== true && !record.agentId
          && sameWorkspace(record.cwd, workspace) && (record.type === 'user' || record.type === 'assistant')) {
          const previous = history.get(id)
          const state = await fileState(reader, file)
          const candidate = { id, workspace, title: previous?.title ?? titleFrom(id)!, updatedAt: Math.max(state.updatedAt, previous?.updatedAt ?? 0) }
          if (!sessions.has(id) || candidate.updatedAt > sessions.get(id)!.updatedAt) sessions.set(id, candidate)
          break
        }
        if (count >= MAX_CLAUDE_BINDING_LINES) break
      }
    }
  }))
  return sortSessions(sessions.values())
}

export async function discoverRecentNativeSessions(
  agentKind: 'codex' | 'claude',
  since: number,
  options: NativeSessionDiscoveryOptions = {},
): Promise<NativeSessionSummary[]> {
  const reader = options.reader ?? defaultReader
  if (agentKind === 'codex') {
    return (await discoverGlobalCodexSessions({ ...options, limit: MAX_RESULTS }))
      .filter((session) => session.updatedAt > 0 && session.updatedAt >= since)
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
