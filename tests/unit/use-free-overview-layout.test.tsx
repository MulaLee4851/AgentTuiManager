// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { FREE_LAYOUT_STORAGE_KEY, parseFreeLayout, serializeFreeLayout, type FreeWindows } from '../../src/free-overview-layout'
import { useFreeOverviewLayout, type FreeOverviewLayout } from '../../src/use-free-overview-layout'

const initial: FreeWindows = {
  a: { x: 100, y: 100, width: 500, height: 400, zIndex: 1 },
  b: { x: 650, y: 100, width: 420, height: 350, zIndex: 2 },
}
let layout: FreeOverviewLayout
let frames: Map<number, FrameRequestCallback>
let frameId: number
let renders: number
let mounts: number
let unmounts: number
let getStorage: MockInstance<Storage['getItem']>
let setStorage: MockInstance<Storage['setItem']>

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.isPrimary = init.isPrimary ?? true
  }
}

function MountedTerminal(): JSX.Element {
  useEffect(() => {
    mounts++
    return () => { unmounts++ }
  }, [])
  return <span>terminal</span>
}

interface HarnessProps { ids?: string[]; visible?: string[]; enabled?: boolean; tick?: number; hideEmptyCanvas?: boolean }
function Harness({ ids = ['a', 'b'], visible = ids, enabled = true, tick = 0, hideEmptyCanvas = false }: HarnessProps): JSX.Element {
  layout = useFreeOverviewLayout(ids, visible, enabled)
  renders++
  if (hideEmptyCanvas && ids.length === 0) return <div>No sessions</div>
  return <section ref={layout.containerRef} data-testid="canvas" data-tick={tick}>
    {ids.map(id => {
      const rect = layout.windows[id]
      return <article className="terminal-card" data-testid={`card-${id}`} key={id} style={enabled && rect ? {
        position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: rect.zIndex,
      } : undefined}>
        <MountedTerminal />
        <textarea data-testid={`input-${id}`} />
        <header data-testid={`header-${id}`} onPointerDown={event => layout.start(id, 'move', event)}>
          <button className="free-window-move" data-testid={`move-${id}`} onPointerDown={event => layout.start(id, 'move', event)} onKeyDown={event => layout.keyAdjust(id, 'move', event)}>move</button>
        </header>
        <button data-testid={`east-${id}`} onPointerDown={event => layout.start(id, 'e', event)} onKeyDown={event => layout.keyAdjust(id, 'e', event)}>resize</button>
      </article>
    })}
    <div data-free-layout-spacer style={{ width: enabled ? layout.extent.width : undefined, height: enabled ? layout.extent.height : undefined }} />
  </section>
}

function canvasMetrics(): HTMLElement {
  const canvas = screen.getByTestId('canvas')
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 600 },
    scrollWidth: { configurable: true, get: () => Math.max(1200, parseFloat(canvas.querySelector<HTMLElement>('[data-free-layout-spacer]')!.style.width) || 0) },
    scrollHeight: { configurable: true, get: () => Math.max(600, parseFloat(canvas.querySelector<HTMLElement>('[data-free-layout-spacer]')!.style.height) || 0) },
  })
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, right: 1300, bottom: 650, width: 1200, height: 600, x: 100, y: 50, toJSON: () => ({}) })
  return canvas
}

function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: Element | Window, x = 400, y = 300, pointerId = 1): void {
  fireEvent[type](target, { pointerId, button: 0, clientX: x, clientY: y, isPrimary: true })
}

function flushFrame(): void {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(16))
  })
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  localStorage.clear()
  localStorage.setItem(FREE_LAYOUT_STORAGE_KEY, serializeFreeLayout(initial))
  frames = new Map()
  frameId = 0
  renders = 0
  mounts = 0
  unmounts = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  getStorage = vi.spyOn(Storage.prototype, 'getItem')
  setStorage = vi.spyOn(Storage.prototype, 'setItem')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('free overview interaction', () => {
  it.each(['header', 'move', 'east'])('moves focus away from the previous terminal when starting %s on another card', source => {
    render(<Harness />)
    canvasMetrics()
    const oldInput = screen.getByTestId('input-a')
    const focusTarget = screen.getByTestId(source === 'east' ? 'east-b' : 'move-b')
    const focus = vi.spyOn(focusTarget, 'focus')
    oldInput.focus()
    expect(oldInput).toHaveFocus()
    pointer('pointerDown', screen.getByTestId(`${source}-b`))
    expect(focusTarget).toHaveFocus()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(screen.getByTestId('input-b')).not.toHaveFocus()
    // Escape must return to the actual button even when the gesture began on a header.
    oldInput.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(focusTarget).toHaveFocus()
    expect(layout.windows).toEqual(initial)
  })

  it('binds resize and scroll observers when an initially absent canvas mounts and after deleting all sessions', () => {
    const observers: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }) }
    })
    const view = render(<Harness ids={[]} hideEmptyCanvas />)
    expect(screen.queryByTestId('canvas')).toBeNull()
    expect(observers).toHaveLength(0)
    view.rerender(<Harness hideEmptyCanvas />)
    const firstCanvas = canvasMetrics()
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observe).toHaveBeenCalledWith(firstCanvas)
    act(() => observers[0]!.callback([], {} as ResizeObserver))
    expect(layout.extent).toEqual({ width: 1200, height: 600 })
    view.rerender(<Harness hideEmptyCanvas tick={1} />)
    expect(observers).toHaveLength(1)
    firstCanvas.scrollLeft = 35
    firstCanvas.scrollTop = 80
    fireEvent.scroll(firstCanvas)
    view.rerender(<Harness hideEmptyCanvas enabled={false} />)
    firstCanvas.scrollLeft = 0
    firstCanvas.scrollTop = 0
    view.rerender(<Harness hideEmptyCanvas />)
    expect(firstCanvas.scrollLeft).toBe(35)
    expect(firstCanvas.scrollTop).toBe(80)
    view.rerender(<Harness ids={[]} hideEmptyCanvas />)
    expect(observers.at(-1)!.disconnect).toHaveBeenCalledOnce()
    const countBeforeRemount = observers.length
    view.rerender(<Harness ids={['b']} hideEmptyCanvas />)
    const secondCanvas = canvasMetrics()
    expect(secondCanvas).not.toBe(firstCanvas)
    expect(observers).toHaveLength(countBeforeRemount + 1)
    expect(observers.at(-1)!.observe).toHaveBeenCalledWith(secondCanvas)
    Object.defineProperty(secondCanvas, 'clientWidth', { configurable: true, value: 1400 })
    act(() => observers.at(-1)!.callback([], {} as ResizeObserver))
    expect(layout.extent.width).toBe(1400)
  })

  it('does no layout storage work in grid mode and preserves startup geometry until sessions arrive', () => {
    const view = render(<Harness enabled={false} ids={[]} />)
    expect(getStorage).not.toHaveBeenCalled()
    expect(setStorage).not.toHaveBeenCalled()
    view.rerender(<Harness ids={[]} />)
    expect(layout.windows).toEqual(initial)
    expect(setStorage).not.toHaveBeenCalled()
    view.rerender(<Harness ids={['a']} />)
    expect(layout.windows).toEqual({ a: initial.a })
    view.rerender(<Harness ids={[]} />)
    expect(layout.windows).toEqual({})
    expect(parseFreeLayout(localStorage.getItem(FREE_LAYOUT_STORAGE_KEY))).toEqual({})
  })

  it('coalesces moves into one frame, survives live rerenders, and saves once after release', () => {
    const view = render(<Harness />)
    canvasMetrics()
    const baselineRenders = renders
    setStorage.mockClear()
    pointer('pointerDown', screen.getByTestId('move-a'))
    pointer('pointerMove', window, 420, 310)
    pointer('pointerMove', window, 430, 320)
    pointer('pointerMove', window, 480, 360)
    expect(frames.size).toBe(1)
    expect(layout.windows.a).toEqual(initial.a)
    flushFrame()
    expect(screen.getByTestId('card-a')).toHaveStyle({ left: '180px', top: '160px' })
    expect(renders).toBe(baselineRenders)
    expect(setStorage).not.toHaveBeenCalled()
    view.rerender(<Harness tick={1} />)
    expect(screen.getByTestId('card-a')).toHaveStyle({ left: '180px', top: '160px' })
    pointer('pointerUp', window, 490, 365)
    expect(layout.windows.a).toMatchObject({ x: 190, y: 165, width: 500, height: 400 })
    expect(setStorage).toHaveBeenCalledTimes(1)
    expect(parseFreeLayout(localStorage.getItem(FREE_LAYOUT_STORAGE_KEY))).toEqual(layout.windows)
    expect(mounts).toBe(2)
    expect(unmounts).toBe(0)
    expect(frames.size).toBe(0)
  })

  it.each(['Escape', 'pointercancel', 'blur', 'lostpointercapture'])('rolls back on %s and removes active listeners', reason => {
    render(<Harness />)
    const canvas = canvasMetrics()
    const handle = screen.getByTestId('move-a')
    const release = vi.fn()
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: release })
    setStorage.mockClear()
    pointer('pointerDown', handle)
    pointer('pointerMove', window, 550, 450)
    flushFrame()
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else if (reason === 'pointercancel') pointer('pointerCancel', window)
    else if (reason === 'blur') fireEvent.blur(window)
    else fireEvent(handle, new TestPointerEvent('lostpointercapture', { pointerId: 1 }))
    expect(layout.windows).toEqual(initial)
    expect(screen.getByTestId('card-a')).toHaveStyle({ left: '100px', top: '100px', zIndex: '1' })
    expect(screen.getByTestId('card-a')).not.toHaveAttribute('data-free-layout-interacting')
    expect(canvas.style.userSelect).toBe('')
    expect(setStorage).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(1)
    pointer('pointerMove', window, 650, 500)
    pointer('pointerUp', window, 650, 500)
    expect(frames.size).toBe(0)
    expect(layout.windows).toEqual(initial)
  })

  it('cancels when switching mode, restores scroll and geometry, and retains terminal instances', () => {
    const view = render(<Harness />)
    const canvas = canvasMetrics()
    canvas.scrollLeft = 30
    canvas.scrollTop = 75
    fireEvent.scroll(canvas)
    pointer('pointerDown', screen.getByTestId('east-a'))
    pointer('pointerMove', window, 500, 350)
    flushFrame()
    view.rerender(<Harness enabled={false} />)
    expect(screen.getByTestId('card-a').style.width).toBe('')
    expect(frames.size).toBe(0)
    canvas.scrollLeft = 0
    canvas.scrollTop = 0
    view.rerender(<Harness />)
    expect(layout.windows).toEqual(initial)
    expect(canvas.scrollLeft).toBe(30)
    expect(canvas.scrollTop).toBe(75)
    expect(mounts).toBe(2)
    expect(unmounts).toBe(0)
    expect(screen.getByTestId('card-a')).toHaveStyle({ width: '500px', height: '400px' })
  })

  it('cancels a hidden or deleted window and does not resurrect it on pointer release', () => {
    const view = render(<Harness />)
    canvasMetrics()
    pointer('pointerDown', screen.getByTestId('move-a'))
    pointer('pointerMove', window, 500, 350)
    view.rerender(<Harness visible={['b']} />)
    expect(frames.size).toBe(0)
    expect(layout.windows).toEqual(initial)
    view.rerender(<Harness />)
    pointer('pointerDown', screen.getByTestId('move-a'))
    pointer('pointerMove', window, 500, 350)
    view.rerender(<Harness ids={['b']} />)
    pointer('pointerUp', window, 500, 350)
    expect(layout.windows).toEqual({ b: initial.b })
    expect(frames.size).toBe(0)
  })

  it('uses canvas scroll offsets and supports independent horizontal resizing', () => {
    render(<Harness />)
    const canvas = canvasMetrics()
    canvas.scrollLeft = 150
    canvas.scrollTop = 200
    pointer('pointerDown', screen.getByTestId('move-a'))
    canvas.scrollLeft += 20
    canvas.scrollTop += 30
    pointer('pointerUp', window, 430, 340)
    expect(layout.windows.a).toMatchObject({ x: 150, y: 170 })
    pointer('pointerDown', screen.getByTestId('east-a'))
    pointer('pointerUp', window, 525, 500)
    expect(layout.windows.a).toMatchObject({ width: 625, height: 400 })
  })

  it('continues bounded edge scrolling between pointer events', () => {
    render(<Harness />)
    const canvas = canvasMetrics()
    pointer('pointerDown', screen.getByTestId('move-a'))
    pointer('pointerMove', window, 400, 645)
    flushFrame()
    expect(canvas.scrollTop).toBeGreaterThan(0)
    const firstTop = canvas.scrollTop
    flushFrame()
    expect(canvas.scrollTop).toBeGreaterThan(firstTop)
    expect(layout.windows).toEqual(initial)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(frames.size).toBe(0)
  })

  it('allows keyboard movement/resizing and arranges visible windows without changing hidden geometry', () => {
    const view = render(<Harness />)
    const canvas = canvasMetrics()
    fireEvent.keyDown(screen.getByTestId('move-a'), { key: 'ArrowRight', shiftKey: true })
    expect(layout.windows.a!.x).toBe(132)
    fireEvent.keyDown(screen.getByTestId('east-a'), { key: 'ArrowRight' })
    expect(layout.windows.a).toMatchObject({ width: 508, height: 400 })
    const hidden = layout.windows.b
    view.rerender(<Harness visible={['a']} />)
    act(() => layout.arrange())
    expect(layout.windows.a).toMatchObject({ x: 16, y: 16, width: 560, height: 360 })
    expect(layout.windows.b).toBe(hidden)
    expect(canvas.scrollTop).toBe(0)
  })

  it('cleans up pending frames and listeners on unmount', () => {
    const view = render(<Harness />)
    canvasMetrics()
    pointer('pointerDown', screen.getByTestId('move-a'))
    pointer('pointerMove', window, 500, 400)
    view.unmount()
    expect(frames.size).toBe(0)
    pointer('pointerUp', window, 500, 400)
    expect(unmounts).toBe(2)
    expect(setStorage).not.toHaveBeenCalled()
  })
})
