import { describe, expect, it } from 'vitest'
import {
  adjustFreeWindow, arrangeFreeWindows, freeAutoScrollDelta, freeCanvasPoint, freeWindowExtent,
  MAX_FREE_CANVAS_SIZE, MAX_FREE_WINDOW_SIZE, MIN_FREE_WINDOW_HEIGHT, MIN_FREE_WINDOW_WIDTH,
  parseFreeLayout, placeFreeWindow, raiseFreeWindow, reconcileFreeWindows, sanitizeFreeWindowRect, serializeFreeLayout,
  type FreeWindowRect, type ResizeEdge,
} from '../../src/free-overview-layout'

const rect: FreeWindowRect = { x: 100, y: 100, width: 500, height: 400, zIndex: 2 }

describe('free overview geometry', () => {
  it.each<[ResizeEdge, Partial<FreeWindowRect>]>([
    ['n', { x: 100, y: 120, width: 500, height: 380 }],
    ['ne', { x: 100, y: 120, width: 540, height: 380 }],
    ['e', { x: 100, y: 100, width: 540, height: 400 }],
    ['se', { x: 100, y: 100, width: 540, height: 420 }],
    ['s', { x: 100, y: 100, width: 500, height: 420 }],
    ['sw', { x: 140, y: 100, width: 460, height: 420 }],
    ['w', { x: 140, y: 100, width: 460, height: 400 }],
    ['nw', { x: 140, y: 120, width: 460, height: 380 }],
  ])('resizes %s with the opposite edges fixed and no aspect ratio constraint', (edge, expected) => {
    expect(adjustFreeWindow(rect, edge, 40, 20)).toEqual({ ...rect, ...expected })
  })

  it('keeps every edge within its bounds for extreme deltas', () => {
    const actions = ['move', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
    for (const action of actions) for (const dx of [-1e9, 1e9]) for (const dy of [-1e9, 1e9]) {
      const result = adjustFreeWindow(rect, action, dx, dy)
      expect(result.x).toBeGreaterThanOrEqual(0)
      expect(result.y).toBeGreaterThanOrEqual(0)
      expect(result.width).toBeGreaterThanOrEqual(MIN_FREE_WINDOW_WIDTH)
      expect(result.height).toBeGreaterThanOrEqual(MIN_FREE_WINDOW_HEIGHT)
      expect(result.width).toBeLessThanOrEqual(MAX_FREE_WINDOW_SIZE)
      expect(result.height).toBeLessThanOrEqual(MAX_FREE_WINDOW_SIZE)
      expect(result.x + result.width).toBeLessThanOrEqual(MAX_FREE_CANVAS_SIZE)
      expect(result.y + result.height).toBeLessThanOrEqual(MAX_FREE_CANVAS_SIZE)
    }
    expect(adjustFreeWindow(rect, 'move', NaN, Infinity)).toEqual(rect)
  })

  it('validates saved data and serializes only geometry', () => {
    expect(parseFreeLayout('oops')).toEqual({})
    expect(parseFreeLayout('null')).toEqual({})
    expect(parseFreeLayout('{"version":2,"windows":{}}')).toEqual({})
    expect(sanitizeFreeWindowRect({ ...rect, x: Infinity })).toBeUndefined()
    const raw = serializeFreeLayout({ a: { ...rect, content: 'private terminal content' } as FreeWindowRect })
    expect(raw).not.toContain('private')
    expect(parseFreeLayout(raw)).toEqual({ a: rect })
    const damaged = parseFreeLayout(JSON.stringify({ version: 1, windows: {
      bad: { x: '1' }, bounded: { ...rect, x: -4, y: 1e8, width: 1, height: 1e8, zIndex: -1 },
    } }))
    expect(Object.keys(damaged)).toEqual(['bounded'])
    expect(damaged.bounded).toEqual({ x: 0, y: MAX_FREE_CANVAS_SIZE - MAX_FREE_WINDOW_SIZE, width: 320, height: MAX_FREE_WINDOW_SIZE, zIndex: 1 })
    const malicious = parseFreeLayout('{"version":1,"windows":{"__proto__":{"x":0,"y":0,"width":320,"height":240,"zIndex":1}}}')
    expect(Object.getPrototypeOf(malicious)).toBeNull()
  })

  it('preserves geometry across viewport changes and reclaims confirmed deleted sessions', () => {
    const stored = { a: rect, removed: { ...rect, x: 2000 } }
    expect(reconcileFreeWindows(stored, [], 800, false)).toBe(stored)
    const next = reconcileFreeWindows(stored, ['a', 'new'], 700, true)
    expect(next.a).toEqual(rect)
    expect(next.removed).toBeUndefined()
    expect(next.new).toBeDefined()
    expect(reconcileFreeWindows(next, ['a', 'new'], 350, true)).toBe(next)
    expect(reconcileFreeWindows(next, [], 350, true)).toEqual({})
  })

  it('places new windows in vacant space and resets oversized distant visible windows to defaults', () => {
    const first = placeFreeWindow({}, 1200)
    const second = placeFreeWindow({ first }, 1200)
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.width)
    const hidden = { ...rect, x: 6000, y: 5000 }
    const arranged = arrangeFreeWindows({ a: { ...rect, x: 5000, y: 27000, width: 4096, height: 4096 }, b: { ...rect, width: 400, height: 280 }, hidden }, ['a', 'b'], 1200)
    expect(arranged.a).toEqual({ ...rect, x: 16, y: 16, width: 560, height: 360 })
    expect(arranged.b).toEqual({ ...rect, x: 592, y: 16, width: 560, height: 360 })
    expect(arranged.hidden).toBe(hidden)
    expect(freeWindowExtent(arranged, ['a', 'b'], 1200, 500)).toEqual({ width: 1200, height: 500 })
    expect(raiseFreeWindow(arranged, 'a').a!.zIndex).toBeGreaterThan(arranged.b!.zIndex)
  })

  it('accounts for scrolled canvas coordinates and bounded edge scrolling', () => {
    expect(freeCanvasPoint(110, 90, { left: 10, top: 20 }, 300, 400)).toEqual({ x: 400, y: 470 })
    expect(freeAutoScrollDelta(500, 0, 1000)).toBe(0)
    expect(freeAutoScrollDelta(-20, 0, 1000)).toBe(-18)
    expect(freeAutoScrollDelta(1005, 0, 1000)).toBe(18)
  })
})
