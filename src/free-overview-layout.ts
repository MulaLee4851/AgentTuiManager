/** Geometry only: no session contents are ever stored with an overview layout. */
export interface FreeWindowRect {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

export type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
export type FreeLayoutAction = 'move' | ResizeEdge
export type FreeWindows = Record<string, FreeWindowRect>
export interface FreeLayoutExtent { width: number; height: number }

export const FREE_LAYOUT_STORAGE_KEY = 'agent-tui-manager:free-overview-layout:v1'
export const MIN_FREE_WINDOW_WIDTH = 320
export const MIN_FREE_WINDOW_HEIGHT = 240
export const MAX_FREE_WINDOW_SIZE = 4096
export const MAX_FREE_CANVAS_SIZE = 32768
export const FREE_WINDOW_GAP = 16
const MAX_Z_INDEX = 1_000_000
const MAX_SAVED_WINDOWS = 5000

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function sanitizeFreeWindowRect(value: unknown): FreeWindowRect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FreeWindowRect>
  const fields = [candidate.x, candidate.y, candidate.width, candidate.height, candidate.zIndex]
  if (!fields.every(field => typeof field === 'number' && Number.isFinite(field))) return undefined
  const width = clamp(Math.round(candidate.width!), MIN_FREE_WINDOW_WIDTH, MAX_FREE_WINDOW_SIZE)
  const height = clamp(Math.round(candidate.height!), MIN_FREE_WINDOW_HEIGHT, MAX_FREE_WINDOW_SIZE)
  return {
    x: clamp(Math.round(candidate.x!), 0, MAX_FREE_CANVAS_SIZE - width),
    y: clamp(Math.round(candidate.y!), 0, MAX_FREE_CANVAS_SIZE - height),
    width,
    height,
    zIndex: clamp(Math.round(candidate.zIndex!), 1, MAX_Z_INDEX),
  }
}

export function parseFreeLayout(raw: string | null): FreeWindows {
  const result: FreeWindows = Object.create(null) as FreeWindows
  if (!raw || raw.length > 2_000_000) return result
  try {
    const data = JSON.parse(raw) as { version?: unknown; windows?: unknown } | null
    if (data?.version !== 1 || !data.windows || typeof data.windows !== 'object' || Array.isArray(data.windows)) return result
    for (const [id, value] of Object.entries(data.windows).slice(0, MAX_SAVED_WINDOWS)) {
      const rect = sanitizeFreeWindowRect(value)
      if (id.length > 0 && id.length <= 512 && rect) result[id] = rect
    }
  } catch {
    // A damaged preference is disposable; the live terminal is not.
  }
  return result
}

export function serializeFreeLayout(windows: FreeWindows): string {
  // Whitelist fields even if a caller accidentally supplies a session object.
  const clean: FreeWindows = Object.create(null) as FreeWindows
  for (const [id, value] of Object.entries(windows).slice(0, MAX_SAVED_WINDOWS)) {
    const rect = sanitizeFreeWindowRect(value)
    if (rect) clean[id] = rect
  }
  return JSON.stringify({ version: 1, windows: clean })
}

/** Opposite edges remain anchored during resizing; width and height are independent. */
export function adjustFreeWindow(rect: FreeWindowRect, action: FreeLayoutAction, dx: number, dy: number): FreeWindowRect {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ...rect }
  dx = Math.round(dx)
  dy = Math.round(dy)
  if (action === 'move') return {
    ...rect,
    x: clamp(rect.x + dx, 0, MAX_FREE_CANVAS_SIZE - rect.width),
    y: clamp(rect.y + dy, 0, MAX_FREE_CANVAS_SIZE - rect.height),
  }
  let { x, y, width, height } = rect
  if (action.includes('e')) width = clamp(width + dx, MIN_FREE_WINDOW_WIDTH, Math.min(MAX_FREE_WINDOW_SIZE, MAX_FREE_CANVAS_SIZE - x))
  if (action.includes('s')) height = clamp(height + dy, MIN_FREE_WINDOW_HEIGHT, Math.min(MAX_FREE_WINDOW_SIZE, MAX_FREE_CANVAS_SIZE - y))
  if (action.includes('w')) {
    const right = x + width
    x = clamp(x + dx, Math.max(0, right - MAX_FREE_WINDOW_SIZE), right - MIN_FREE_WINDOW_WIDTH)
    width = right - x
  }
  if (action.includes('n')) {
    const bottom = y + height
    y = clamp(y + dy, Math.max(0, bottom - MAX_FREE_WINDOW_SIZE), bottom - MIN_FREE_WINDOW_HEIGHT)
    height = bottom - y
  }
  return { ...rect, x, y, width, height }
}

export function freeWindowExtent(windows: FreeWindows, visibleIds: readonly string[], viewportWidth = 0, viewportHeight = 0): FreeLayoutExtent {
  let width = viewportWidth
  let height = viewportHeight
  for (const id of visibleIds) {
    const rect = windows[id]
    if (!rect) continue
    width = Math.max(width, rect.x + rect.width + FREE_WINDOW_GAP)
    height = Math.max(height, rect.y + rect.height + FREE_WINDOW_GAP)
  }
  return { width: Math.min(MAX_FREE_CANVAS_SIZE, width), height: Math.min(MAX_FREE_CANVAS_SIZE, height) }
}

function intersects(a: FreeWindowRect, b: FreeWindowRect): boolean {
  return a.x < b.x + b.width + FREE_WINDOW_GAP && a.x + a.width + FREE_WINDOW_GAP > b.x
    && a.y < b.y + b.height + FREE_WINDOW_GAP && a.y + a.height + FREE_WINDOW_GAP > b.y
}

/** Search vacant rows inside the current viewport without disturbing saved positions. */
export function placeFreeWindow(windows: FreeWindows, viewportWidth: number): FreeWindowRect {
  const availableWidth = Math.max(MIN_FREE_WINDOW_WIDTH + FREE_WINDOW_GAP * 2, viewportWidth || 1000)
  const columns = Math.max(1, Math.floor((availableWidth - FREE_WINDOW_GAP) / (480 + FREE_WINDOW_GAP)))
  const width = clamp(Math.floor((availableWidth - FREE_WINDOW_GAP * (columns + 1)) / columns), MIN_FREE_WINDOW_WIDTH, 560)
  const occupied = Object.values(windows)
  const ys = [...new Set([FREE_WINDOW_GAP, ...occupied.map(rect => rect.y + rect.height + FREE_WINDOW_GAP)])].sort((a, b) => a - b)
  const candidate: FreeWindowRect = { x: FREE_WINDOW_GAP, y: FREE_WINDOW_GAP, width, height: 360, zIndex: 1 }
  for (const y of ys) {
    if (y + candidate.height + FREE_WINDOW_GAP > MAX_FREE_CANVAS_SIZE) continue
    for (let x = FREE_WINDOW_GAP; x + width + FREE_WINDOW_GAP <= availableWidth; x += width + FREE_WINDOW_GAP) {
      candidate.x = x
      candidate.y = y
      if (!occupied.some(rect => intersects(candidate, rect))) return { ...candidate }
    }
  }
  // Only reached for a canvas already filled to its safety limit.
  return { ...candidate, x: FREE_WINDOW_GAP, y: Math.min(MAX_FREE_CANVAS_SIZE - candidate.height, ys.at(-1) ?? FREE_WINDOW_GAP) }
}

export function raiseFreeWindow(windows: FreeWindows, id: string): FreeWindows {
  if (!windows[id]) return windows
  let maxZ = Math.max(0, ...Object.values(windows).map(rect => rect.zIndex))
  if (windows[id].zIndex === maxZ && Object.values(windows).filter(rect => rect.zIndex === maxZ).length === 1) return windows
  const next = { ...windows }
  if (maxZ >= MAX_Z_INDEX) {
    Object.entries(next).sort((a, b) => a[1].zIndex - b[1].zIndex).forEach(([key, rect], index) => {
      next[key] = { ...rect, zIndex: index + 1 }
    })
    maxZ = Object.keys(next).length
  }
  next[id] = { ...next[id]!, zIndex: maxZ + 1 }
  return next
}

export function reconcileFreeWindows(windows: FreeWindows, allIds: readonly string[], viewportWidth: number, prune: boolean): FreeWindows {
  const next: FreeWindows = Object.create(null) as FreeWindows
  const keep = new Set(allIds)
  let changed = false
  for (const [id, rect] of Object.entries(windows)) {
    if (!prune || keep.has(id)) next[id] = rect
    else changed = true
  }
  for (const id of keep) {
    if (next[id]) continue
    next[id] = placeFreeWindow(next, viewportWidth)
    next[id] = { ...next[id]!, zIndex: Math.max(0, ...Object.values(next).map(rect => rect.zIndex)) + 1 }
    changed = true
  }
  return changed ? next : windows
}

/** Restore visible windows to default sizes and reachable positions; leave hidden windows untouched. */
export function arrangeFreeWindows(windows: FreeWindows, visibleIds: readonly string[], viewportWidth: number): FreeWindows {
  const next = { ...windows }
  const right = Math.max(MIN_FREE_WINDOW_WIDTH + FREE_WINDOW_GAP * 2, viewportWidth || 1000)
  const { width, height } = placeFreeWindow({}, viewportWidth)
  let x = FREE_WINDOW_GAP
  let y = FREE_WINDOW_GAP
  let rowHeight = 0
  for (const id of visibleIds) {
    const rect = next[id]
    if (!rect) continue
    if (x > FREE_WINDOW_GAP && x + width + FREE_WINDOW_GAP > right) {
      x = FREE_WINDOW_GAP
      y += rowHeight + FREE_WINDOW_GAP
      rowHeight = 0
    }
    next[id] = { ...rect, x, y: Math.min(y, MAX_FREE_CANVAS_SIZE - height), width, height }
    x += width + FREE_WINDOW_GAP
    rowHeight = Math.max(rowHeight, height)
  }
  return next
}

/** Content coordinates account for both viewport movement and canvas scrolling. */
export function freeCanvasPoint(clientX: number, clientY: number, bounds: { left: number; top: number }, scrollLeft: number, scrollTop: number): { x: number; y: number } {
  return { x: clientX - bounds.left + scrollLeft, y: clientY - bounds.top + scrollTop }
}

/** Pixels per frame, kept bounded when the pointer travels outside the viewport. */
export function freeAutoScrollDelta(pointer: number, start: number, size: number): number {
  if (size <= 0) return 0
  const band = Math.min(48, size / 4)
  if (pointer < start + band) return -Math.ceil(clamp((start + band - pointer) / band, 0, 1) * 18)
  if (pointer > start + size - band) return Math.ceil(clamp((pointer - (start + size - band)) / band, 0, 1) * 18)
  return 0
}
