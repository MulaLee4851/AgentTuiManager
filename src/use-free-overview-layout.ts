import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import {
  adjustFreeWindow, arrangeFreeWindows, FREE_LAYOUT_STORAGE_KEY, freeAutoScrollDelta, freeCanvasPoint,
  freeWindowExtent, parseFreeLayout, raiseFreeWindow, reconcileFreeWindows, serializeFreeLayout,
  type FreeLayoutAction, type FreeLayoutExtent, type FreeWindowRect, type FreeWindows,
} from './free-overview-layout'

export type { FreeWindowRect, ResizeEdge } from './free-overview-layout'

interface Gesture {
  id: string
  action: FreeLayoutAction
  pointerId: number
  handle: HTMLElement
  card: HTMLElement
  container: HTMLElement
  origin: { x: number; y: number }
  original: FreeWindowRect
  basis: FreeWindowRect
  current: FreeWindowRect
  clientX: number
  clientY: number
  frame: number | undefined
  originalUserSelect: string
  cleanup: () => void
}

export interface FreeOverviewLayout {
  containerRef: RefObject<HTMLElement>
  extent: FreeLayoutExtent
  windows: FreeWindows
  bringToFront: (id: string) => void
  start: (id: string, action: FreeLayoutAction, event: ReactPointerEvent<HTMLElement>) => void
  keyAdjust: (id: string, action: FreeLayoutAction, event: ReactKeyboardEvent<HTMLElement>) => void
  arrange: () => void
}

function applyRect(element: HTMLElement, rect: FreeWindowRect): void {
  element.style.left = `${rect.x}px`
  element.style.top = `${rect.y}px`
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
  element.style.zIndex = String(rect.zIndex)
}

function persist(windows: FreeWindows): void {
  try { window.localStorage.setItem(FREE_LAYOUT_STORAGE_KEY, serializeFreeLayout(windows)) } catch {
    // Unavailable or full storage must not interfere with terminal interaction.
  }
}

export function useFreeOverviewLayout(allIds: readonly string[], visibleIds: readonly string[], enabled: boolean): FreeOverviewLayout {
  const containerRef = useRef<HTMLElement>(null)
  const [windows, setWindows] = useState<FreeWindows>({})
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const windowsRef = useRef(windows)
  const context = useRef({ allIds, visibleIds, enabled })
  context.current = { allIds, visibleIds, enabled }
  const gesture = useRef<Gesture>()
  const loaded = useRef(false)
  const sawSessions = useRef(false)
  const mounted = useRef(true)
  const savedScroll = useRef({ left: 0, top: 0 })
  const previouslyEnabled = useRef(false)
  const hasSessions = allIds.length > 0
  const allIdsKey = JSON.stringify(allIds)
  const visibleIdsKey = JSON.stringify(visibleIds)

  const commit = useCallback((next: FreeWindows): void => {
    if (next === windowsRef.current) return
    windowsRef.current = next
    if (mounted.current) setWindows(next)
    persist(next)
  }, [])

  const paint = useCallback((active: Gesture): void => {
    applyRect(active.card, active.current)
    const extent = freeWindowExtent(
      { ...windowsRef.current, [active.id]: active.current }, context.current.visibleIds,
      active.container.clientWidth, active.container.clientHeight,
    )
    const spacer = active.container.querySelector<HTMLElement>('[data-free-layout-spacer]')
    if (spacer) {
      spacer.style.width = `${extent.width}px`
      spacer.style.height = `${extent.height}px`
    }
  }, [])

  const finish = useCallback((accept: boolean, restoreDom = true): void => {
    const active = gesture.current
    if (!active) return
    gesture.current = undefined
    if (active.frame !== undefined) window.cancelAnimationFrame(active.frame)
    active.cleanup()
    try {
      if (active.handle.hasPointerCapture?.(active.pointerId)) active.handle.releasePointerCapture(active.pointerId)
    } catch { /* A removed handle can already have lost its pointer capture. */ }
    active.container.style.userSelect = active.originalUserSelect
    active.card.removeAttribute('data-free-layout-interacting')
    if (accept && context.current.enabled && context.current.allIds.includes(active.id)) {
      const next = raiseFreeWindow(windowsRef.current, active.id)
      commit({ ...next, [active.id]: { ...active.current, zIndex: next[active.id]?.zIndex ?? active.current.zIndex } })
    } else if (restoreDom && context.current.enabled && active.card.isConnected) {
      applyRect(active.card, windowsRef.current[active.id] ?? active.original)
    }
    if (restoreDom && context.current.enabled) {
      const extent = freeWindowExtent(windowsRef.current, context.current.visibleIds, active.container.clientWidth, active.container.clientHeight)
      const spacer = active.container.querySelector<HTMLElement>('[data-free-layout-spacer]')
      if (spacer) {
        spacer.style.width = `${extent.width}px`
        spacer.style.height = `${extent.height}px`
      }
    }
    if (context.current.enabled) savedScroll.current = { left: active.container.scrollLeft, top: active.container.scrollTop }
  }, [commit])

  const start = useCallback((id: string, action: FreeLayoutAction, event: ReactPointerEvent<HTMLElement>): void => {
    if (!context.current.enabled || event.button !== 0 || event.isPrimary === false || gesture.current) return
    const container = containerRef.current
    const original = windowsRef.current[id]
    const card = event.currentTarget.closest<HTMLElement>('.terminal-card')
    if (!container || !original || !card || !context.current.visibleIds.includes(id)) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const focusTarget = action === 'move'
      ? card.querySelector<HTMLElement>('.free-window-move') ?? (handle.tabIndex >= 0 ? handle : card)
      : handle
    const bounds = container.getBoundingClientRect()
    const basis = raiseFreeWindow(windowsRef.current, id)[id]!
    const active: Gesture = {
      id, action, pointerId: event.pointerId, handle, card, container, original, basis, current: basis,
      origin: freeCanvasPoint(event.clientX, event.clientY, bounds, container.scrollLeft, container.scrollTop),
      clientX: event.clientX, clientY: event.clientY, frame: undefined,
      originalUserSelect: container.style.userSelect, cleanup: () => undefined,
    }
    gesture.current = active
    // preventDefault suppresses the browser's normal focus transfer. Leave the
    // previous terminal's input before activating another window's drag controls.
    focusTarget.focus({ preventScroll: true })
    container.style.userSelect = 'none'
    card.setAttribute('data-free-layout-interacting', action)
    try { handle.setPointerCapture?.(event.pointerId) } catch { /* Window listeners also cover uncaptured pointer events. */ }

    const update = (): void => {
      const point = freeCanvasPoint(active.clientX, active.clientY, container.getBoundingClientRect(), container.scrollLeft, container.scrollTop)
      active.current = adjustFreeWindow(active.basis, action, point.x - active.origin.x, point.y - active.origin.y)
      paint(active)
    }
    const tick = (): void => {
      active.frame = undefined
      if (gesture.current !== active) return
      update()
      const area = container.getBoundingClientRect()
      const dx = freeAutoScrollDelta(active.clientX, area.left, container.clientWidth)
      const dy = freeAutoScrollDelta(active.clientY, area.top, container.clientHeight)
      const oldLeft = container.scrollLeft
      const oldTop = container.scrollTop
      container.scrollLeft = Math.max(0, Math.min(Math.max(0, container.scrollWidth - container.clientWidth), oldLeft + dx))
      container.scrollTop = Math.max(0, Math.min(Math.max(0, container.scrollHeight - container.clientHeight), oldTop + dy))
      if (container.scrollLeft !== oldLeft || container.scrollTop !== oldTop) {
        schedule()
      }
    }
    const schedule = (): void => {
      if (active.frame === undefined && gesture.current === active) active.frame = window.requestAnimationFrame(tick)
    }
    const onMove = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== active.pointerId) return
      active.clientX = pointer.clientX
      active.clientY = pointer.clientY
      pointer.preventDefault()
      schedule()
    }
    const onUp = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== active.pointerId) return
      active.clientX = pointer.clientX
      active.clientY = pointer.clientY
      update()
      finish(true)
    }
    const onCancel = (pointer: PointerEvent): void => {
      if (pointer.pointerId === active.pointerId) finish(false)
    }
    const onKey = (keyboard: KeyboardEvent): void => {
      if (keyboard.key !== 'Escape') return
      keyboard.preventDefault()
      keyboard.stopPropagation()
      finish(false)
      if (focusTarget.isConnected) focusTarget.focus({ preventScroll: true })
    }
    const onBlur = (): void => finish(false)
    const onVisibility = (): void => { if (document.hidden) finish(false) }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    container.addEventListener('scroll', schedule, { passive: true })
    active.cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      handle.removeEventListener('lostpointercapture', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      container.removeEventListener('scroll', schedule)
    }
    paint(active)
  }, [finish, paint])

  const bringToFront = useCallback((id: string): void => {
    if (!context.current.enabled || gesture.current || !context.current.visibleIds.includes(id)) return
    commit(raiseFreeWindow(windowsRef.current, id))
  }, [commit])

  const keyAdjust = useCallback((id: string, action: FreeLayoutAction, event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!context.current.enabled || gesture.current || !context.current.visibleIds.includes(id)) return
    const step = event.shiftKey ? 32 : 8
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    const delta = movement[event.key]
    const original = windowsRef.current[id]
    if (!delta || !original) return
    event.preventDefault()
    event.stopPropagation()
    const next = raiseFreeWindow(windowsRef.current, id)
    commit({ ...next, [id]: adjustFreeWindow(next[id]!, action, ...delta) })
  }, [commit])

  const arrange = useCallback((): void => {
    if (!context.current.enabled) return
    finish(false)
    commit(arrangeFreeWindows(windowsRef.current, context.current.visibleIds, containerRef.current?.clientWidth ?? 1000))
    if (containerRef.current) {
      containerRef.current.scrollLeft = 0
      containerRef.current.scrollTop = 0
    }
    savedScroll.current = { left: 0, top: 0 }
  }, [commit, finish])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      finish(false, false)
    }
  }, [finish])

  // Loading is lazy: grid mode performs no free-layout storage or resize work.
  useLayoutEffect(() => {
    if (!enabled) return
    if (!loaded.current) {
      loaded.current = true
      try { windowsRef.current = parseFreeLayout(window.localStorage.getItem(FREE_LAYOUT_STORAGE_KEY)) } catch { windowsRef.current = {} }
      setWindows(windowsRef.current)
    }
    if (allIds.length > 0) sawSessions.current = true
    const next = reconcileFreeWindows(windowsRef.current, allIds, containerRef.current?.clientWidth ?? 1000, sawSessions.current)
    commit(next)
  }, [enabled, allIdsKey, commit])

  useLayoutEffect(() => {
    if (gesture.current && (!enabled || !allIds.includes(gesture.current.id) || !visibleIds.includes(gesture.current.id))) finish(false, enabled)
  }, [enabled, allIdsKey, visibleIdsKey, finish])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!enabled || !container) {
      previouslyEnabled.current = false
      return
    }
    const measure = (): void => {
      const width = container.clientWidth
      const height = container.clientHeight
      setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(container)
    window.addEventListener('resize', measure)
    const rememberScroll = (): void => {
      // A mode switch can collapse the scroll range before effect cleanup.
      if (context.current.enabled) savedScroll.current = { left: container.scrollLeft, top: container.scrollTop }
    }
    container.addEventListener('scroll', rememberScroll, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      container.removeEventListener('scroll', rememberScroll)
    }
  }, [enabled, hasSessions])

  // React may render in response to live session updates during a gesture. Its
  // committed geometry remains unchanged; reapply the current DOM preview before paint.
  useLayoutEffect(() => {
    if (gesture.current) paint(gesture.current)
    if (enabled && !previouslyEnabled.current && containerRef.current && loaded.current) {
      containerRef.current.scrollLeft = savedScroll.current.left
      containerRef.current.scrollTop = savedScroll.current.top
      previouslyEnabled.current = true
    }
  })

  return {
    containerRef,
    extent: freeWindowExtent(windows, visibleIds, viewport.width, viewport.height),
    windows, bringToFront, start, keyAdjust, arrange,
  }
}

export default useFreeOverviewLayout
