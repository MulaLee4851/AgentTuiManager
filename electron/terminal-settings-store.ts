import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_TERMINAL_SETTINGS, parseTerminalSettings, type TerminalSettings } from '../src/shared/terminal-settings'

export class TerminalSettingsStore {
  private writes: Promise<unknown> = Promise.resolve()
  private constructor(private readonly path: string, private settings: TerminalSettings) {}

  static async load(path: string): Promise<TerminalSettingsStore> {
    let settings = { ...DEFAULT_TERMINAL_SETTINGS }
    try { settings = parseTerminalSettings(JSON.parse(await readFile(path, 'utf8'))) }
    catch { /* Missing or damaged settings use the default; valid saved choices are retained. */ }
    return new TerminalSettingsStore(path, settings)
  }

  getSettings(): TerminalSettings { return { ...this.settings } }

  update(value: unknown): Promise<TerminalSettings> {
    const next = parseTerminalSettings(value)
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
