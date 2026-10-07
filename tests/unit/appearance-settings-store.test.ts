import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AppearanceSettingsStore } from '../../electron/appearance-settings-store'
import { DEFAULT_APPEARANCE_SETTINGS, parseAppearanceSettings } from '../../src/shared/appearance-settings'

describe('appearance preferences persistence', () => {
  it('uses defaults on first launch or corrupt files and persists ordered updates', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'appearance-test-')), 'appearance.json')
    const store = await AppearanceSettingsStore.load(path)
    expect(store.getSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
    await Promise.all([store.update({ uiSize: 'large', terminalFontSize: 16 }), store.update({ uiSize: 'comfortable', terminalFontSize: 14, extra: true })])
    expect((await AppearanceSettingsStore.load(path)).getSettings()).toEqual({ uiSize: 'comfortable', terminalFontSize: 14 })
    expect(JSON.parse(await readFile(path, 'utf8')).extra).toBeUndefined()
    await writeFile(path, '{broken')
    expect((await AppearanceSettingsStore.load(path)).getSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })
  it('does not report unsaved preferences as committed when disk writes fail', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'appearance-test-')), 'appearance.json')
    const store = await AppearanceSettingsStore.load(path)
    await mkdir(path)
    await expect(store.update({ uiSize: 'large', terminalFontSize: 16 })).rejects.toThrow()
    expect(store.getSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })
  it.each([null, [], {}, { uiSize: 'huge', terminalFontSize: 14 }, { uiSize: '__proto__', terminalFontSize: 'auto' }, { uiSize: 'standard', terminalFontSize: 999 }, { uiSize: 'standard', terminalFontSize: '16' }])('rejects invalid preferences %j', value => {
    expect(() => parseAppearanceSettings(value)).toThrow()
  })
})
