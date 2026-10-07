import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TerminalSettingsStore } from '../../electron/terminal-settings-store'
import { parseTerminalSettings } from '../../src/shared/terminal-settings'

describe('terminal settings persistence', () => {
  it('defaults to fullscreen and preserves an explicitly saved compatibility choice', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'terminal-settings-')), 'settings.json')
    const store = await TerminalSettingsStore.load(path)
    expect(store.getSettings()).toEqual({ codexMode: 'native-fullscreen' })
    await store.update({ codexMode: 'scrollback', extra: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, codexMode: 'scrollback' })
    expect((await TerminalSettingsStore.load(path)).getSettings()).toEqual(store.getSettings())
    const copy = store.getSettings(); copy.codexMode = 'native-fullscreen'
    expect(store.getSettings().codexMode).toBe('scrollback')
  })
  it('recovers corrupt settings and serializes updates', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'terminal-settings-')), 'settings.json')
    await writeFile(path, '{broken')
    const store = await TerminalSettingsStore.load(path)
    expect(store.getSettings().codexMode).toBe('native-fullscreen')
    await Promise.all([store.update({ codexMode: 'native-fullscreen' }), store.update({ codexMode: 'scrollback' })])
    expect((await TerminalSettingsStore.load(path)).getSettings().codexMode).toBe('scrollback')
  })
  it('never applies an unsaved mode if disk writing fails', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'terminal-settings-')), 'settings.json')
    const store = await TerminalSettingsStore.load(path)
    await mkdir(path)
    await expect(store.update({ codexMode: 'scrollback' })).rejects.toThrow()
    expect(store.getSettings().codexMode).toBe('native-fullscreen')
  })
  it.each([null, [], {}, { codexMode: 'unknown' }, { codexMode: true }])('rejects malformed input %j', value => {
    expect(() => parseTerminalSettings(value)).toThrow()
  })
})
