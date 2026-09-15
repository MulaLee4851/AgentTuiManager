import { useLayoutEffect, useRef, useState } from 'react'
import type { SessionSummary } from './shared/manager-api'
import { sessionDisplayStatus, type SessionDisplayStatus } from './shared/session-state'

/** Keep manually stopped cards reachable without delaying the actual stop. */
export function useStoppedSessionGrace(sessions: SessionSummary[]): Map<string, SessionDisplayStatus> {
  const previous = useRef(new Map<string, SessionDisplayStatus>())
  const deadlines = useRef(new Map<string, { status: SessionDisplayStatus; until: number }>())
  const [retained, setRetained] = useState(new Map<string, SessionDisplayStatus>())
  useLayoutEffect(() => {
    const now = Date.now()
    const current = new Map(sessions.map((session) => [session.sessionId, sessionDisplayStatus(session)]))
    for (const session of sessions) {
      const before = previous.current.get(session.sessionId)
      if (session.status === 'stopped' && session.userStopRequested && before && before !== 'stopped') {
        deadlines.current.set(session.sessionId, { status: before, until: now + 5000 })
      }
    }
    previous.current = current
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = (): void => {
      for (const [id, entry] of deadlines.current) {
        if (current.get(id) !== 'stopped' || entry.until <= Date.now()) deadlines.current.delete(id)
      }
      setRetained((before) => {
        const next = new Map([...deadlines.current].map(([id, entry]) => [id, entry.status]))
        return before.size === next.size && [...next].every(([id, status]) => before.get(id) === status) ? before : next
      })
      if (deadlines.current.size) {
        timer = setTimeout(update, Math.max(0, Math.min(...[...deadlines.current.values()].map((entry) => entry.until)) - Date.now()))
      }
    }
    update()
    return () => { if (timer) clearTimeout(timer) }
  }, [sessions])
  return retained
}
