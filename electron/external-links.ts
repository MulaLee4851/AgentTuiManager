import { shell, type WebContents } from 'electron'
import { externalWebUrl } from '../src/shared/external-url'

export async function openExternalWeb(value: unknown): Promise<void> {
  const url = externalWebUrl(value)
  if (!url) throw new Error('仅支持在浏览器中打开 HTTP/HTTPS 网页。')
  try { await shell.openExternal(url) } catch { throw new Error('无法打开系统浏览器。') }
}

export function routeExternalLinks(contents: WebContents, internalOrigin?: string): void {
  const internal = (url: string): boolean => {
    try { return Boolean(internalOrigin && new URL(url).origin === internalOrigin) } catch { return false }
  }
  contents.setWindowOpenHandler(({ url }) => {
    // Local app popup links remain inside the existing top-level web app.
    if (internal(url)) void contents.loadURL(url).catch(() => undefined)
    else if (externalWebUrl(url)) void openExternalWeb(url).catch(() => undefined)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (internal(url)) return
    event.preventDefault()
    if (externalWebUrl(url)) void openExternalWeb(url).catch(() => undefined)
  })
  contents.on('will-redirect', (event, url) => {
    if (!internal(url)) event.preventDefault()
  })
}
