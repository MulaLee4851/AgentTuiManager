import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AgentKind, NativeSessionSummary, SessionSummary, StartSessionRequest } from '../src/shared/manager-api'

export interface StoredManagedSession {
  sessionId: string
  hostId: string
  summary: SessionSummary
  request?: StartSessionRequest
  nativeCapture?: {
    baselineIds: string[]
    startedAt: number
  }
  updatedAt: string
}

interface StoredCatalog {
  version: 1
  sessions: StoredManagedSession[]
  lastWorkspaceSessionIds?: string[]
  nativeNames?: Array<{ agentKind: AgentKind; nativeSessionId: string; displayName: string }>
}

function cloneEntry(entry: StoredManagedSession): StoredManagedSession {
  return JSON.parse(JSON.stringify(entry)) as StoredManagedSession
}

export class ManagedSessionCatalog {
  private readonly entries = new Map<string, StoredManagedSession>()
  private readonly nativeNames = new Map<string, { agentKind: AgentKind; nativeSessionId: string; displayName: string }>()
  private writeQueue = Promise.resolve()
  private trackingWorkspace = false
  private lastWorkspaceSessionIds: string[] = []
  private startupWorkspaceSessionIds: string[] = []

  private constructor(private readonly path: string, entries: StoredManagedSession[], names: NonNullable<StoredCatalog['nativeNames']>) {
    for (const entry of [...entries].sort((a, b) => (a?.updatedAt ?? '').localeCompare(b?.updatedAt ?? ''))) {
      if (entry?.sessionId && entry.hostId && entry.summary?.workspace) {
        this.entries.set(entry.sessionId, cloneEntry(entry))
        this.rememberName(entry.summary)
      }
    }
    // Saved aliases are authoritative; old live-window metadata must not replace them.
    for (const name of names) {
      if (name && typeof name.nativeSessionId === 'string' && typeof name.displayName === 'string'
        && ['codex', 'claude', 'pi', 'deepseek', 'generic'].includes(name.agentKind)) this.rememberName(name)
    }
  }

  static async load(path: string): Promise<ManagedSessionCatalog> {
    let entries: StoredManagedSession[] = []
    let names: NonNullable<StoredCatalog['nativeNames']> = []
    let saved: unknown
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredCatalog>
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) entries = parsed.sessions
      if (parsed.version === 1 && Array.isArray(parsed.nativeNames)) names = parsed.nativeNames
      if (parsed.version === 1) saved = parsed.lastWorkspaceSessionIds
    } catch {
      // The native Agent session remains authoritative if this Manager-only index is damaged.
    }
    const catalog = new ManagedSessionCatalog(path, entries, names)
    // Migrate old catalogs from process status; never add stopped records.
    catalog.lastWorkspaceSessionIds = Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && catalog.entries.has(id)))]
      : catalog.activeSessionIds()
    catalog.startupWorkspaceSessionIds = [...catalog.lastWorkspaceSessionIds]
    return catalog
  }

  private activeSessionIds(): string[] {
    return [...this.entries.values()].filter(entry =>
      !entry.summary.userStopRequested && !['stopped', 'failed', 'completed'].includes(entry.summary.status))
      .map(entry => entry.sessionId)
  }

  startupWorkspace(): StoredManagedSession[] {
    return this.startupWorkspaceSessionIds.flatMap(id => {
      const entry = this.entries.get(id)
      return entry ? [cloneEntry(entry)] : []
    })
  }

  startWorkspaceTracking(): void { this.trackingWorkspace = true }

  async captureWorkspaceBeforeExit(): Promise<void> {
    this.lastWorkspaceSessionIds = this.activeSessionIds()
    this.trackingWorkspace = false
    await this.persist()
  }

  private rememberName(value: { agentKind: AgentKind; nativeSessionId?: string; displayName: string }): void {
    if (!value.nativeSessionId || !value.displayName?.trim()) return
    this.nativeNames.set(JSON.stringify([value.agentKind, value.nativeSessionId]), {
      agentKind: value.agentKind, nativeSessionId: value.nativeSessionId, displayName: value.displayName.trim(),
    })
  }

  nameHistory(agentKind: AgentKind, sessions: NativeSessionSummary[]): NativeSessionSummary[] {
    return sessions.map(session => {
      const name = this.nativeNames.get(JSON.stringify([agentKind, session.id]))?.displayName
      return name ? { ...session, managerDisplayName: name, title: name } : { ...session }
    })
  }

  list(): StoredManagedSession[] {
    return [...this.entries.values()].map(cloneEntry)
  }

  upsert(entry: StoredManagedSession): Promise<void> {
    const previous = this.entries.get(entry.sessionId)?.summary
    if (!previous || previous.displayName !== entry.summary.displayName
      || previous.nativeSessionId !== entry.summary.nativeSessionId || previous.agentKind !== entry.summary.agentKind) {
      this.rememberName(entry.summary)
    }
    this.entries.set(entry.sessionId, cloneEntry(entry))
    if (this.trackingWorkspace) this.lastWorkspaceSessionIds = this.activeSessionIds()
    return this.persist()
  }

  remove(sessionId: string): Promise<void> {
    this.entries.delete(sessionId)
    this.lastWorkspaceSessionIds = this.lastWorkspaceSessionIds.filter(id => id !== sessionId)
    this.startupWorkspaceSessionIds = this.startupWorkspaceSessionIds.filter(id => id !== sessionId)
    return this.persist()
  }

  clear(): Promise<void> {
    this.entries.clear()
    this.lastWorkspaceSessionIds = []
    this.startupWorkspaceSessionIds = []
    return this.persist()
  }

  flush(): Promise<void> {
    return this.writeQueue
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      const payload: StoredCatalog = { version: 1, sessions: this.list(), nativeNames: [...this.nativeNames.values()], lastWorkspaceSessionIds: this.lastWorkspaceSessionIds }
      try {
        await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
        await rename(temporary, this.path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    })
    return this.writeQueue
  }
}
