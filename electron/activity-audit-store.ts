import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AuditEntry } from '../src/shared/manager-api'

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'timestamp'>

interface StoredAudit {
  version: 1
  entries: AuditEntry[]
}

const MAX_ENTRIES = 2_000
const MAX_FILE_BYTES = 2 * 1024 * 1024

function validEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<AuditEntry>
  return typeof entry.id === 'string' && typeof entry.timestamp === 'number'
    && ['info', 'warning', 'error'].includes(String(entry.level))
    && ['session', 'approval', 'recovery', 'rule', 'remote'].includes(String(entry.category))
    && typeof entry.action === 'string' && typeof entry.message === 'string'
}

export class ActivityAuditStore {
  private readonly entries: AuditEntry[]
  private writeQueue = Promise.resolve()

  private constructor(private readonly path: string, entries: AuditEntry[]) {
    this.entries = entries.slice(-MAX_ENTRIES)
  }

  static async load(path: string): Promise<ActivityAuditStore> {
    let entries: AuditEntry[] = []
    try {
      const content = await readFile(path, 'utf8')
      if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) {
        const parsed = JSON.parse(content) as Partial<StoredAudit>
        if (parsed.version === 1 && Array.isArray(parsed.entries)) entries = parsed.entries.filter(validEntry)
      }
    } catch {
      // Missing or damaged audit history must never stop Agent sessions.
    }
    return new ActivityAuditStore(path, entries)
  }

  list(): AuditEntry[] {
    return [...this.entries].reverse().map((entry) => ({ ...entry, ...(entry.details ? { details: { ...entry.details } } : {}) }))
  }

  append(input: NewAuditEntry): AuditEntry {
    const entry: AuditEntry = { id: randomUUID(), timestamp: Date.now(), ...input }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(() => undefined)
    return entry
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
