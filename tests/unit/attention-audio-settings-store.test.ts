import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AttentionAudioSettingsStore } from '../../electron/attention-audio-settings-store'
import { parseAttentionAudioSettings } from '../../src/shared/attention-audio-settings'

describe('attention audio settings', () => {
  it('defaults to the original chime and persists a muted custom sound without unrelated properties', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attention-settings-'))
    const path = join(root, 'settings.json')
    const store = await AttentionAudioSettingsStore.load(path)
    expect(store.getSettings()).toEqual({ sound: 'classic', volume: 100 })
    await store.update({ sound: 'soft', volume: 0, ignored: 'unused' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, sound: 'soft', volume: 0 })
    expect((await AttentionAudioSettingsStore.load(path)).getSettings()).toEqual({ sound: 'soft', volume: 0 })
    const copy = store.getSettings(); copy.volume = 100
    expect(store.getSettings().volume).toBe(0)
  })
  it('uses defaults for damaged settings and serializes concurrent updates in arrival order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attention-settings-'))
    const path = join(root, 'settings.json')
    await writeFile(path, '{invalid')
    const store = await AttentionAudioSettingsStore.load(path)
    expect(store.getSettings()).toEqual({ sound: 'classic', volume: 100 })
    await Promise.all([store.update({ sound: 'soft', volume: 20 }), store.update({ sound: 'pulse', volume: 40 })])
    expect(store.getSettings()).toEqual({ sound: 'pulse', volume: 40 })
    expect((await AttentionAudioSettingsStore.load(path)).getSettings()).toEqual(store.getSettings())
  })
  it('does not apply unsaved changes when writing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attention-settings-'))
    const path = join(root, 'settings.json')
    const store = await AttentionAudioSettingsStore.load(path)
    await mkdir(path)
    await expect(store.update({ sound: 'bell', volume: 0 })).rejects.toThrow()
    expect(store.getSettings()).toEqual({ sound: 'classic', volume: 100 })
  })
  it.each([null, [], {}, { sound: 'unknown', volume: 50 }, ...[-1, 101, 0.5, NaN, Infinity, '20'].map(volume => ({ sound: 'classic', volume }))])('rejects invalid settings %j', value => {
    expect(() => parseAttentionAudioSettings(value)).toThrow()
  })
})
