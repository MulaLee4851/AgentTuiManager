import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { SessionSafetyStore } from '../../electron/session-safety-store'

describe('SessionSafetyStore', () => {
  it('keeps crash workspace metadata by default and persists an opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-safety-'))
    const path = join(root, 'settings.json')
    const store = await SessionSafetyStore.load(path)
    expect(store.getSettings()).toEqual({ preserveWorkspaceOnCrash: true })
    await store.update({ preserveWorkspaceOnCrash: false })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      preserveWorkspaceOnCrash: false,
    })
  })
})
