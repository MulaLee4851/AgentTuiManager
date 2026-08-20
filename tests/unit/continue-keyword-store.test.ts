import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { ContinueKeywordStore } from '../../electron/continue-keyword-store'

describe('ContinueKeywordStore', () => {
  it('defaults to disabled and persists normalized keywords', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continue-keyword-'))
    const path = join(root, 'settings.json')
    const store = await ContinueKeywordStore.load(path)
    expect(store.getSettings()).toEqual({ enabled: false, quietSeconds: 10, keywords: [] })

    await store.update({ enabled: true, quietSeconds: 7, keywords: ['  Model   Busy ', 'model busy', 'Connection Lost'] })
    expect(store.getSettings()).toEqual({ enabled: true, quietSeconds: 7, keywords: ['model busy', 'connection lost'] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, enabled: true, quietSeconds: 7 })
  })

  it('matches only when a keyword intersects the newly received output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continue-keyword-'))
    const store = await ContinueKeywordStore.load(join(root, 'settings.json'))
    await store.update({ enabled: true, quietSeconds: 10, keywords: ['model busy'] })

    expect(store.matchIncremental('old model busy message', 'unrelated redraw')).toBeUndefined()
    expect(store.matchIncremental('the model ', 'BUSY now')).toBe('model busy')
    expect(store.matchIncremental('', '\x1b[31mMODEL BUSY\x1b[0m')).toBe('model busy')
  })
  it('matches case-insensitively across ANSI output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continue-keyword-'))
    const store = await ContinueKeywordStore.load(join(root, 'settings.json'))
    await store.update({ enabled: true, quietSeconds: 10, keywords: ['model busy'] })
    expect(store.match('\x1b[31mMODEL BUSY\x1b[0m')).toBe('model busy')
  })
})
