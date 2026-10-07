import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_APPEARANCE_SETTINGS, parseAppearanceSettings, type AppearanceSettings } from '../src/shared/appearance-settings'

export class AppearanceSettingsStore {
  private writes: Promise<unknown> = Promise.resolve()
  private constructor(private readonly path: string, private settings: AppearanceSettings) {}

  static async load(path: string): Promise<AppearanceSettingsStore> {
    let settings = { ...DEFAULT_APPEARANCE_SETTINGS }
    try { settings = parseAppearanceSettings(JSON.parse(await readFile(path, 'utf8'))) }
    catch { /* Missing or damaged preferences use readable defaults. */ }
    return new AppearanceSettingsStore(path, settings)
  }

  getSettings(): AppearanceSettings { return { ...this.settings } }

  update(value: unknown): Promise<AppearanceSettings> {
    const next = parseAppearanceSettings(value)
    const pending = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, ...next }, null, 2), 'utf8')
        await rename(temporary, this.path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      this.settings = next
      return this.getSettings()
    })
    this.writes = pending.catch(() => undefined)
    return pending
  }
}
