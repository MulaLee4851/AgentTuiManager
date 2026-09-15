// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStoppedSessionGrace } from '../../src/useStoppedSessionGrace'
import type { SessionSummary } from '../../src/shared/manager-api'

afterEach(() => { cleanup(); vi.useRealTimers() })
const session = (status: string, userStopRequested = false) => ({
  sessionId: 'one', status, activity: 'running', userStopRequested,
} as SessionSummary)

it('keeps a manual stop for exactly five seconds across refreshes', () => {
  vi.useFakeTimers()
  const { result, rerender } = renderHook(({ sessions }) => useStoppedSessionGrace(sessions), {
    initialProps: { sessions: [session('running')] },
  })
  rerender({ sessions: [session('stopped', true)] })
  expect(result.current.get('one')).toBe('running')
  act(() => { vi.advanceTimersByTime(4000) })
  rerender({ sessions: [session('stopped', true)] })
  act(() => { vi.advanceTimersByTime(999) })
  expect(result.current.has('one')).toBe(true)
  act(() => { vi.advanceTimersByTime(1) })
  expect(result.current.size).toBe(0)
})

it('does not retain old stops or normal exits and clears retention on restart', () => {
  vi.useFakeTimers()
  const { result, rerender } = renderHook(({ sessions }) => useStoppedSessionGrace(sessions), {
    initialProps: { sessions: [session('stopped', true)] },
  })
  expect(result.current.size).toBe(0)
  rerender({ sessions: [session('running')] })
  rerender({ sessions: [session('completed')] })
  expect(result.current.size).toBe(0)
  rerender({ sessions: [session('running')] })
  rerender({ sessions: [session('stopped', true)] })
  expect(result.current.size).toBe(1)
  rerender({ sessions: [session('starting')] })
  expect(result.current.size).toBe(0)
  act(() => { vi.advanceTimersByTime(5000) })
  expect(result.current.size).toBe(0)
})
