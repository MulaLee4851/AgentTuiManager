import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SessionSafetySettings } from '../src/shared/manager-api'

const DEFAULT_SETTINGS: SessionSafetySettings = { preserveWorkspaceOnCrash: true }

export class SessionSafetyStore {
  private constructor(private readonly path: string, private settings: SessionSafetySettings) {}

  static async load(path: string): Promise<SessionSafetyStore> {
    let settings = { ...DEFAULT_SETTINGS }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      settings = { preserveWorkspaceOnCrash: parsed.preserveWorkspaceOnCrash !== false }
    } catch {
      // Missing or damaged settings use the safer default: keep resumable metadata.
    }
    return new SessionSafetyStore(path, settings)
  }

  getSettings(): SessionSafetySettings {
    return { ...this.settings }
  }

  async update(value: SessionSafetySettings): Promise<SessionSafetySettings> {
    this.settings = { preserveWorkspaceOnCrash: value.preserveWorkspaceOnCrash !== false }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, ...this.settings }, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return this.getSettings()
  }
}
