// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVisibleFreeSession } from '../../src/use-visible-free-session'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('free window reminder visibility', () => {
  it('clears a selected Agent outside the canvas and ignores old observer callbacks after switching', () => {
    const callbacks: IntersectionObserverCallback[] = []
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback) }
      observe() {}
      disconnect = disconnect
    })
    const container = document.createElement('section'), first = document.createElement('article'), second = document.createElement('article')
    first.dataset.testid = 'terminal-tile-one'; second.dataset.testid = 'terminal-tile-two'
    container.append(first, second); document.body.append(container)
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect
    let offset = 10
    first.getBoundingClientRect = () => ({ left: 10, top: offset, right: 400, bottom: offset + 300, width: 390, height: 300 }) as DOMRect
    second.getBoundingClientRect = first.getBoundingClientRect
    const ref = { current: container }
    const view = renderHook(({ id, enabled }) => useVisibleFreeSession(ref, id, enabled), { initialProps: { id: 'one', enabled: true } })
    expect(view.result.current).toBe('one')
    act(() => { offset = -400; container.dispatchEvent(new Event('scroll')) })
    expect(view.result.current).toBeUndefined()
    act(() => { offset = 10; container.dispatchEvent(new Event('scroll')) })
    expect(view.result.current).toBe('one')
    const old = callbacks[0]!
    view.rerender({ id: 'two', enabled: true })
    act(() => old([{ target: first, time: 0, isIntersecting: true, intersectionRatio: 1, boundingClientRect: first.getBoundingClientRect(), rootBounds: container.getBoundingClientRect(), intersectionRect: first.getBoundingClientRect() }], {} as IntersectionObserver))
    expect(view.result.current).toBe('two')
    view.rerender({ id: 'two', enabled: false })
    expect(view.result.current).toBeUndefined()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
