import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SessionSummary } from '../src/shared/manager-api'
import { deepSeekWebUrl } from '../src/shared/deepseek-web-url'
import { routeExternalLinks } from './external-links'

export function managedDeepSeekUrl(session: SessionSummary | undefined): string | undefined {
  if (!session || session.agentKind !== 'deepseek' || ['stopped', 'completed', 'failed'].includes(session.status)) return
  return deepSeekWebUrl(session.webUrl)
}

// DSH's Strict cookie requires a top-level page, not a cross-site iframe.
export class DeepSeekWebWindows {
  private readonly entries = new Map<string, { window: BrowserWindow; url: string }>()
  private readonly profiles = new Map<string, { url: string; partition: string }>()

  sync(id: string, session: SessionSummary | undefined): void {
    const url = managedDeepSeekUrl(session)
    const entry = this.entries.get(id)
    if (entry && url !== entry.url) entry.window.destroy()
    if (this.profiles.get(id)?.url !== url) this.profiles.delete(id)
  }

  async open(session: SessionSummary | undefined, parent: BrowserWindow): Promise<void> {
    const url = managedDeepSeekUrl(session)
    if (!session || !url) throw new Error('DeepSeek Web 尚未就绪或已经停止，请重新启动后再打开。')
    this.sync(session.sessionId, session)
    const current = this.entries.get(session.sessionId)
    if (current && !current.window.isDestroyed()) {
      if (current.window.isMinimized()) current.window.restore()
      current.window.show()
      current.window.focus()
      return
    }
    // Reopening the UI must retain its cookie even if the launch token is single-use.
    const profile = this.profiles.get(session.sessionId) ?? { url, partition: 'dsh-' + randomUUID() }
    this.profiles.set(session.sessionId, profile)
    const window = new BrowserWindow({
      parent, width: 1200, height: 820, minWidth: 800, minHeight: 560,
      title: `${session.displayName} · DeepSeek Harness`, backgroundColor: '#111719',
      autoHideMenuBar: true, show: false,
      webPreferences: { partition: profile.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    })
    this.entries.set(session.sessionId, { window, url })
    window.once('closed', () => {
      if (this.entries.get(session.sessionId)?.window === window) this.entries.delete(session.sessionId)
    })
    routeExternalLinks(window.webContents, new URL(url).origin)
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.on('will-download', event => event.preventDefault())
    try {
      await window.loadURL(url)
      if (!window.isDestroyed()) window.show()
    } catch {
      if (!window.isDestroyed()) window.destroy()
      // Do not forward Electron errors containing the credential URL.
      throw new Error('DeepSeek Web 页面加载失败，请查看启动输出，确认本地服务仍在运行。')
    }
  }
}
