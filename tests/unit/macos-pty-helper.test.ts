import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { ensureMacPtySpawnHelper, macPtySpawnHelperCandidates } from '../../electron/macos-pty-helper'

describe('macOS PTY spawn helper', () => {
  it('keeps Windows behavior untouched', () => {
    const exists = vi.fn()
    expect(ensureMacPtySpawnHelper({ platform: 'win32', exists })).toBeUndefined()
    expect(exists).not.toHaveBeenCalled()
  })

  it('maps packaged node-pty paths to app.asar.unpacked', () => {
    expect(macPtySpawnHelperCandidates(
      '/Applications/Agent TUI Manager.app/Contents/Resources/app.asar/node_modules/node-pty/lib/index.js',
      'x64',
    )).toContain('/Applications/Agent TUI Manager.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper')
  })

  it('restores the executable bit only when it is missing', () => {
    const helper = '/tmp/node-pty/spawn-helper'
    const access = vi.fn()
      .mockImplementationOnce(() => { throw new Error('EACCES') })
      .mockImplementationOnce(() => undefined)
    const chmod = vi.fn()
    expect(ensureMacPtySpawnHelper({
      platform: 'darwin', candidates: [helper], exists: () => true, access, chmod,
    })).toBe(helper)
    expect(chmod).toHaveBeenCalledWith(helper, 0o755)
    expect(access).toHaveBeenLastCalledWith(helper, constants.X_OK)
  })

  it('reports a missing helper before node-pty returns posix_spawnp failed', () => {
    expect(() => ensureMacPtySpawnHelper({
      platform: 'darwin', candidates: ['/missing/spawn-helper'], exists: () => false,
    })).toThrow('macOS PTY helper 缺失')
  })
})
