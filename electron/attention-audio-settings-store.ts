import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_ATTENTION_AUDIO_SETTINGS, parseAttentionAudioSettings, type AttentionAudioSettings } from '../src/shared/attention-audio-settings'

export class AttentionAudioSettingsStore {
  private writes: Promise<unknown> = Promise.resolve()
  private constructor(private readonly path: string, private settings: AttentionAudioSettings) {}

  static async load(path: string): Promise<AttentionAudioSettingsStore> {
    let settings = { ...DEFAULT_ATTENTION_AUDIO_SETTINGS }
    try { settings = parseAttentionAudioSettings(JSON.parse(await readFile(path, 'utf8'))) }
    catch { /* Missing or damaged settings preserve the original chime and volume. */ }
    return new AttentionAudioSettingsStore(path, settings)
  }

  getSettings(): AttentionAudioSettings { return { ...this.settings } }

  update(value: unknown): Promise<AttentionAudioSettings> {
    const next = parseAttentionAudioSettings(value)
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
