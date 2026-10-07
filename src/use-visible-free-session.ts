import { useEffect, useState, type RefObject } from 'react'

/** Selection outside the free canvas viewport must not suppress an Agent reminder. */
export function useVisibleFreeSession(containerRef: RefObject<HTMLElement>, sessionId: string | undefined, enabled: boolean): string | undefined {
  const [visibleId, setVisibleId] = useState<string>()
  useEffect(() => {
    setVisibleId(undefined)
    if (!enabled || !sessionId) return
    const container = containerRef.current
    const card = container && Array.from(container.children).find(child => (child as HTMLElement).dataset.testid === 'terminal-tile-' + sessionId)
    if (!container || !card) return
    let current = true
    const update = (visible: boolean): void => { if (current) setVisibleId(visible ? sessionId : undefined) }
    const measure = (): void => {
      const bounds = container.getBoundingClientRect(), rect = card.getBoundingClientRect()
      update(rect.width > 0 && rect.height > 0 && bounds.width > 0 && bounds.height > 0
        && rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom)
    }
    measure()
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === card)
      if (entry) update(entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)
    }, { root: container, threshold: 0 })
    observer?.observe(card)
    // Also update immediately during scrollbar interaction, before observer delivery.
    container.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      current = false
      observer?.disconnect()
      container.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [containerRef, sessionId, enabled])
  return enabled && visibleId === sessionId ? visibleId : undefined
}
