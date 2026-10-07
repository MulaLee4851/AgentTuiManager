import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { shell } from 'electron'
import type { SessionSummary } from '../src/shared/manager-api'

/** Resolve the folder from a managed session, never a renderer-supplied command or URL. */
export async function openSessionWorkspace(session: Pick<SessionSummary, 'workspace'> | undefined): Promise<void> {
  if (!session) throw new Error('Agent 已不存在，请刷新后重试。')
  const workspace = session.workspace
  if (!workspace || !isAbsolute(workspace) || /[\x00-\x1f]/.test(workspace)) {
    throw new Error('工作区路径无效。')
  }
  let directory: boolean
  try { directory = (await stat(workspace)).isDirectory() }
  catch { throw new Error('工作区文件夹不存在或无法访问。') }
  if (!directory) throw new Error('工作区路径不是文件夹。')
  try {
    const error = await shell.openPath(workspace)
    if (!error) return
  } catch { /* Show one useful, platform-independent error. */ }
  throw new Error('无法打开工作区文件夹，请检查系统文件管理器。')
}
