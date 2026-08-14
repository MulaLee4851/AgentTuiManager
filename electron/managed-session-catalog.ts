import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SessionSummary, StartSessionRequest } from '../src/shared/manager-api'

export interface StoredManagedSession {
  sessionId: string
  hostId: string
  summary: SessionSummary
  request?: StartSessionRequest
  updatedAt: string
}

interface StoredCatalog {
  version: 1
  sessions: StoredManagedSession[]
}

function cloneEntry(entry: StoredManagedSession): StoredManagedSession {
  return JSON.parse(JSON.stringify(entry)) as StoredManagedSession
}

export class ManagedSessionCatalog {
  private readonly entries = new Map<string, StoredManagedSession>()
  private writeQueue = Promise.resolve()

  private constructor(private readonly path: string, entries: StoredManagedSession[]) {
    for (const entry of entries) {
      if (entry?.sessionId && entry.hostId && entry.summary?.workspace) this.entries.set(entry.sessionId, cloneEntry(entry))
    }
  }

  static async load(path: string): Promise<ManagedSessionCatalog> {
    let entries: StoredManagedSession[] = []
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredCatalog>
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) entries = parsed.sessions
    } catch {
      // The native Agent session remains authoritative if this Manager-only index is damaged.
    }
    return new ManagedSessionCatalog(path, entries)
  }

  list(): StoredManagedSession[] {
    return [...this.entries.values()].map(cloneEntry)
  }

  upsert(entry: StoredManagedSession): Promise<void> {
    this.entries.set(entry.sessionId, cloneEntry(entry))
    return this.persist()
  }

  remove(sessionId: string): Promise<void> {
    this.entries.delete(sessionId)
    return this.persist()
  }

  clear(): Promise<void> {
    this.entries.clear()
    return this.persist()
  }

  flush(): Promise<void> {
    return this.writeQueue
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      const payload: StoredCatalog = { version: 1, sessions: this.list() }
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
