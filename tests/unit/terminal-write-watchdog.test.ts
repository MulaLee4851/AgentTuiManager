import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalWriteWatchdog } from '../../src/terminal-write-watchdog'

describe('TerminalWriteWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('completes normally without firing the timeout path', () => {
    vi.useFakeTimers()
    const completed = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)

    const callback = watchdog.arm(completed)
    callback()
    vi.advanceTimersByTime(2_000)

    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(false)
  })

  it('releases a write whose xterm callback never arrives', () => {
    vi.useFakeTimers()
    const completed = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)

    watchdog.arm(completed)
    vi.advanceTimersByTime(1_999)
    expect(completed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(true)
  })

  it('ignores a late callback from an older timed-out write', () => {
    vi.useFakeTimers()
    const firstCompleted = vi.fn()
    const firstLateCompleted = vi.fn()
    const secondCompleted = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)

    const lateFirstCallback = watchdog.arm(firstCompleted, firstLateCompleted)
    vi.advanceTimersByTime(2_000)
    const secondCallback = watchdog.arm(secondCompleted)

    lateFirstCallback()
    expect(firstCompleted).toHaveBeenCalledTimes(1)
    expect(firstLateCompleted).toHaveBeenCalledTimes(1)
    expect(secondCompleted).not.toHaveBeenCalled()

    secondCallback()
    expect(secondCompleted).toHaveBeenCalledTimes(1)
    expect(secondCompleted).toHaveBeenCalledWith(false)
  })

  it('renews the stall deadline on progress without completing the logical write', () => {
    vi.useFakeTimers()
    const completed = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)
    const callback = watchdog.arm(completed)
    for (let index = 0; index < 5; index++) {
      vi.advanceTimersByTime(1_500)
      callback.progress()
      expect(completed).not.toHaveBeenCalled()
    }
    callback()
    callback.progress()
    vi.advanceTimersByTime(10_000)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(false)
  })

  it('still times out a stalled batch and ignores stale progress', () => {
    vi.useFakeTimers()
    const first = vi.fn(), second = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)
    const old = watchdog.arm(first)
    vi.advanceTimersByTime(1_500); old.progress()
    vi.advanceTimersByTime(2_000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(true)
    watchdog.arm(second)
    vi.advanceTimersByTime(1_500); old.progress()
    vi.advanceTimersByTime(500)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith(true)
  })

  it('does not release anything after disposal', () => {
    vi.useFakeTimers()
    const completed = vi.fn()
    const watchdog = new TerminalWriteWatchdog(2_000)

    const callback = watchdog.arm(completed)
    watchdog.dispose()
    callback()
    vi.advanceTimersByTime(2_000)

    expect(completed).not.toHaveBeenCalled()
  })
})
