// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentManagerApi, ManagerEvent, SessionSummary } from '../../src/shared/manager-api'

const terminalMocks = vi.hoisted(() => ({
  cols: 100,
  rows: 30,
  _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
  open: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  paste: vi.fn(),
  dispose: vi.fn(),
  refresh: vi.fn(),
  scrollToBottom: vi.fn(),
  scrollToLine: vi.fn(),
  scrollLines: vi.fn(),
  options: { fontSize: 12 },
  modes: { bracketedPasteMode: true },
  buffer: { active: { type: 'normal', baseY: 100, viewportY: 100 } },
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ''),
  attachCustomKeyEventHandler: vi.fn(),
  attachCustomWheelEventHandler: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminalMocks) }))

import TerminalTile from '../../src/TerminalTile'

const session: SessionSummary = {
  sessionId: 'frozen-renderer-session',
  displayName: '直播',
  agentKind: 'codex',
  workspace: 'A:\\淘宝直播',
  status: 'running',
  recoveryAttempts: 0,
  userStopRequested: false,
}

describe('TerminalTile write watchdog', () => {
  let listener: ((event: ManagerEvent) => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    listener = undefined
    terminalMocks.write.mockReset()
    terminalMocks.cols = 100
    terminalMocks.rows = 30
    terminalMocks.options.fontSize = 12
    terminalMocks.resize.mockImplementation((cols, rows) => {
      terminalMocks.cols = cols
      terminalMocks.rows = rows
    })
    window.agentManager = {
      subscribe: vi.fn((next) => {
        listener = next
        return () => undefined
      }),
      terminalReplay: vi.fn(async () => ({ data: '', sequence: 0 })),
      write: vi.fn(),
      resize: vi.fn(),
      writeClipboardText: vi.fn(),
    } as unknown as AgentManagerApi
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('settles the grid and PTY together and does not resize on same-size visibility changes', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(753)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    const view = render(<TerminalTile session={session} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(100) })
    expect(terminalMocks.resize).not.toHaveBeenCalled()
    expect(window.agentManager.resize).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(150))
    expect(terminalMocks.resize).toHaveBeenCalledTimes(1)
    expect(terminalMocks.resize).toHaveBeenCalledWith(93, 20)
    expect(window.agentManager.resize).toHaveBeenCalledTimes(1)
    expect(window.agentManager.resize).toHaveBeenCalledWith(session.sessionId, 93, 20)
    terminalMocks.scrollToBottom.mockClear()
    view.rerender(<TerminalTile session={session} hidden />)
    view.rerender(<TerminalTile session={session} />)
    await act(async () => vi.advanceTimersByTime(5000))
    expect(terminalMocks.resize).toHaveBeenCalledTimes(1)
    expect(window.agentManager.resize).toHaveBeenCalledTimes(1)
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
  })

  it('does not inject control codes between replay and a split live ANSI command', async () => {
    vi.useFakeTimers()
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    vi.mocked(window.agentManager.terminalReplay).mockResolvedValue({ data: '\x1b[2', sequence: 1 })
    const view = render(<TerminalTile session={session} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(20) })
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, sequence: 2, data: 'J\x1b[Hcurrent' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.write.mock.calls.map(call => call[0]).join('')).toBe('\x1b[2J\x1b[Hcurrent')
    terminalMocks.resize.mockClear()
    terminalMocks.scrollToBottom.mockClear()
    terminalMocks.refresh.mockClear()
    const writeCount = terminalMocks.write.mock.calls.length
    view.rerender(<TerminalTile session={session} hidden />)
    view.rerender(<TerminalTile session={session} />)
    await act(async () => vi.advanceTimersByTime(5000))
    expect(terminalMocks.write).toHaveBeenCalledTimes(writeCount)
    expect(terminalMocks.resize).not.toHaveBeenCalled()
    expect(terminalMocks.refresh).not.toHaveBeenCalled()
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
  })

  it('continues consuming output after a lost xterm callback without resizing or scrolling', async () => {
    const callbacks: Array<() => void> = []
    terminalMocks.write.mockImplementation((...args: unknown[]) => {
      const callback = args[1]
      if (typeof callback === 'function') callbacks.push(callback as () => void)
    })

    vi.useFakeTimers()
    render(<TerminalTile session={session} />)
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(20)
    })
    expect(listener).toBeTypeOf('function')
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, sequence: 1, data: 'first' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.write).toHaveBeenCalledTimes(1)
    terminalMocks.refresh.mockClear()
    terminalMocks.resize.mockClear()
    terminalMocks.scrollToBottom.mockClear()
    terminalMocks.scrollToLine.mockClear()

    act(() => listener?.({ type: 'output', sessionId: session.sessionId, sequence: 2, data: 'second' }))
    await act(async () => vi.advanceTimersByTime(2_020))
    expect(terminalMocks.write).toHaveBeenCalledTimes(2)
    expect(terminalMocks.refresh).toHaveBeenCalledWith(0, terminalMocks.rows - 1)
    expect(terminalMocks.resize).not.toHaveBeenCalled()
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
    expect(terminalMocks.scrollToLine).not.toHaveBeenCalled()

    // A late callback from the timed-out first write must not unlock the second write.
    act(() => callbacks[0]?.())
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, sequence: 3, data: 'third' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.write).toHaveBeenCalledTimes(2)

    act(() => callbacks[1]?.())
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.write).toHaveBeenCalledTimes(3)
    expect(terminalMocks.resize).not.toHaveBeenCalled()
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
    expect(terminalMocks.scrollToLine).not.toHaveBeenCalled()
  })
})
