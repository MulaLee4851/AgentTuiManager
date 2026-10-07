import { readPreference } from './ui-preferences'

export interface FavoriteWorkspace { id: string; name: string; path: string }
export interface RecentWorkspace { path: string; lastUsedAt: number }
export const FAVORITE_WORKSPACES_KEY = 'agent-tui-manager:favorite-workspaces:v1'
export const RECENT_WORKSPACES_KEY = 'agent-tui-manager:recent-workspaces:v1'
export const WORKSPACE_SHORTCUTS_CHANGED = 'agent-tui-manager:workspace-shortcuts-changed'

export function isAbsoluteWorkspace(path: string, platform: string): boolean {
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) return false
  return platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(path) : path.startsWith('/')
}

export function workspaceIdentity(path: string, platform: string): string {
  const normalized = platform === 'win32' ? path.trim().replace(/\\/g, '/').toLowerCase() : path.trim()
  return normalized.replace(/\/+$/, '') || (normalized ? '/' : '')
}

export function workspaceLabel(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }

export function readFavoriteWorkspaces(): FavoriteWorkspace[] {
  return readPreference<FavoriteWorkspace[]>(FAVORITE_WORKSPACES_KEY, [], (value): value is FavoriteWorkspace[] =>
    Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item.id === 'string'
      && typeof item.name === 'string' && typeof item.path === 'string'))
}

export function readRecentWorkspaces(platform: string): RecentWorkspace[] {
  const entries = readPreference<RecentWorkspace[]>(RECENT_WORKSPACES_KEY, [], (value): value is RecentWorkspace[] =>
    Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item.path === 'string'
      && typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt)))
  const seen = new Set<string>()
  return entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt).filter(entry => {
    const identity = workspaceIdentity(entry.path, platform)
    if (!isAbsoluteWorkspace(entry.path, platform) || seen.has(identity)) return false
    seen.add(identity); return true
  }).slice(0, 5)
}

/** Call only after a successful launch/resume; storage failure must not undo a running Agent. */
export function rememberRecentWorkspace(path: string, platform: string): void {
  path = path.trim()
  if (!isAbsoluteWorkspace(path, platform)) return
  const current = readRecentWorkspaces(platform)
  const identity = workspaceIdentity(path, platform)
  const lastUsedAt = Math.max(Date.now(), (current[0]?.lastUsedAt ?? 0) + 1)
  const next = [{ path, lastUsedAt }, ...current.filter(entry => workspaceIdentity(entry.path, platform) !== identity)].slice(0, 5)
  try {
    window.localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(WORKSPACE_SHORTCUTS_CHANGED))
  } catch { /* The session has already started successfully. */ }
}
