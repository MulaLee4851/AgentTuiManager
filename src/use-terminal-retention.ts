import { useEffect, useMemo, useState } from 'react'

// Defer unseen terminals, but never evict a viewed one: its parsed scrollback and
// viewport can outlive the host's bounded raw replay buffer. Removal releases it.
export function useTerminalRetention(sessionIds: string[], visibleIds: string[]): ReadonlySet<string> {
  const [recent, setRecent] = useState<string[]>([])
  const retained = useMemo(() => {
    const existing = new Set(sessionIds)
    const visible = new Set(visibleIds.filter(id => existing.has(id)))
    return [...recent.filter(id => existing.has(id) && !visible.has(id)), ...visible]
  }, [recent, sessionIds, visibleIds])
  useEffect(() => {
    setRecent(previous => previous.length === retained.length && previous.every((id, index) => id === retained[index])
      ? previous : retained)
  }, [retained])
  return useMemo(() => new Set(retained), [retained])
}
