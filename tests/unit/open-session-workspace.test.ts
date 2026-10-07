import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSessionWorkspace } from '../../electron/open-session-workspace'

const openPath = vi.hoisted(() => vi.fn(async (_path: string) => ''))
vi.mock('electron', () => ({ shell: { openPath } }))

describe('open managed session workspace', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'workspace-open-')); openPath.mockReset().mockResolvedValue('') })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('passes a directory with spaces, Unicode and shell metacharacters literally to the OS', async () => {
    const workspace = join(root, '项目 workspace & echo $(test);')
    await mkdir(workspace)
    await openSessionWorkspace({ workspace })
    expect(openPath).toHaveBeenCalledOnce()
    expect(openPath).toHaveBeenCalledWith(workspace)
  })

  it('rejects stale sessions, relative paths, URLs and nonexistent directories', async () => {
    await expect(openSessionWorkspace(undefined)).rejects.toThrow('Agent 已不存在')
    for (const workspace of ['relative-folder', 'https://example.com', 'file:///C:/temp', join(root, 'missing'), root + '\u0000']) {
      await expect(openSessionWorkspace({ workspace })).rejects.toThrow()
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it('never opens a file or executable through its file association', async () => {
    const workspace = join(root, 'fixture.exe')
    await writeFile(workspace, 'fixture only')
    await expect(openSessionWorkspace({ workspace })).rejects.toThrow('不是文件夹')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports OS failure whether openPath returns an error or rejects', async () => {
    openPath.mockResolvedValueOnce('platform-specific failure')
    await expect(openSessionWorkspace({ workspace: root })).rejects.toThrow('无法打开工作区文件夹')
    openPath.mockRejectedValueOnce(new Error('platform-specific failure'))
    await expect(openSessionWorkspace({ workspace: root })).rejects.toThrow('无法打开工作区文件夹')
  })
})
