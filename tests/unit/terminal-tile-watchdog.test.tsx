// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
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
  onData: vi.fn((_listener: (data: string) => void) => ({ dispose: vi.fn() })),
  onScroll: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
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
    terminalMocks.hasSelection.mockReturnValue(false)
    terminalMocks.getSelection.mockReturnValue('')
    listener = undefined
    terminalMocks.write.mockReset()
    terminalMocks.cols = 100
    terminalMocks.rows = 30
    terminalMocks.buffer.active.baseY = 100
    terminalMocks.buffer.active.viewportY = 100
    terminalMocks.options.fontSize = 12
    terminalMocks.open.mockImplementation((host: HTMLElement) => {
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      host.appendChild(viewport)
    })
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

  it('copies a selection with Ctrl+C without forwarding an interrupt', async () => {
    render(<TerminalTile session={session} />)
    terminalMocks.hasSelection.mockReturnValue(true)
    terminalMocks.getSelection.mockReturnValue('selected terminal text')
    const handler = terminalMocks.attachCustomKeyEventHandler.mock.calls[0]![0]
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    await act(async () => { expect(handler(event)).toBe(false) })
    expect(event.defaultPrevented).toBe(true)
    expect(window.agentManager.writeClipboardText).toHaveBeenCalledWith('selected terminal text')
    expect(window.agentManager.write).not.toHaveBeenCalled()
    expect(handler(new KeyboardEvent('keyup', { key: 'c', ctrlKey: true }))).toBe(false)
    expect(handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, repeat: true }))).toBe(false)
    expect(window.agentManager.writeClipboardText).toHaveBeenCalledTimes(1)
  })

  it('retains Ctrl+C interruption without selection and preserves explicit copy shortcuts', () => {
    render(<TerminalTile session={session} />)
    const handler = terminalMocks.attachCustomKeyEventHandler.mock.calls[0]![0]
    expect(handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true)
    expect(handler(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(handler(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))).toBe(false)
    terminalMocks.hasSelection.mockReturnValue(true)
    expect(handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, altKey: true }))).toBe(true)
    expect(window.agentManager.writeClipboardText).not.toHaveBeenCalled()
  })

  it('never sends an interrupt when copying the selection fails', async () => {
    render(<TerminalTile session={session} />)
    terminalMocks.hasSelection.mockReturnValue(true)
    terminalMocks.getSelection.mockReturnValue('selected text')
    vi.mocked(window.agentManager.writeClipboardText).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    const handler = terminalMocks.attachCustomKeyEventHandler.mock.calls[0]![0]
    await act(async () => {
      expect(handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(false)
    })
    expect(window.agentManager.write).not.toHaveBeenCalled()
  })

  it('does not pin a programmatic scroll after typing, but preserves real history browsing', async () => {
    vi.useFakeTimers()
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    const view = render(<TerminalTile session={session} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(20) })
    const input = terminalMocks.onData.mock.calls[0]![0]
    const scroll = terminalMocks.onScroll.mock.calls[0]![0]
    act(() => {
      input('a')
      terminalMocks.buffer.active.viewportY = 98
      scroll()
      listener?.({ type: 'output', sessionId: session.sessionId, data: 'redraw' })
    })
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.scrollToLine).not.toHaveBeenCalled()
    const host = view.container.querySelector('.terminal-live-host')!
    fireEvent.wheel(host, { deltaY: -72 })
    terminalMocks.scrollToLine.mockClear()
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, data: 'more' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.scrollToLine).toHaveBeenCalledWith(96)
    terminalMocks.scrollToLine.mockClear()
    act(() => {
      input('b')
      scroll()
      listener?.({ type: 'output', sessionId: session.sessionId, data: 'typing again' })
    })
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.scrollToLine).not.toHaveBeenCalled()
  })

  it('preserves native scrollbar browsing and releases its gesture on pointerup', async () => {
    vi.useFakeTimers()
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    const view = render(<TerminalTile session={session} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(20) })
    const host = view.container.querySelector('.terminal-live-host')!
    const viewport = host.querySelector('.xterm-viewport')!
    fireEvent.pointerDown(viewport)
    terminalMocks.buffer.active.viewportY = 80
    fireEvent.scroll(viewport)
    fireEvent.pointerUp(document)
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, data: 'next' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.scrollToLine).toHaveBeenLastCalledWith(80)
    terminalMocks.scrollToLine.mockClear()
    act(() => terminalMocks.onData.mock.calls[0]![0]('x'))
    terminalMocks.buffer.active.viewportY = 79
    fireEvent.scroll(viewport)
    act(() => listener?.({ type: 'output', sessionId: session.sessionId, data: 'redraw' }))
    await act(async () => vi.advanceTimersByTime(20))
    expect(terminalMocks.scrollToLine).not.toHaveBeenCalled()
  })

  it('manually requests native redraw and restores size without input or replay', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(753)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    const view = render(<TerminalTile session={{ ...session, nativeSessionId: 'native-demo-id' }} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(250) })
    terminalMocks.scrollToBottom.mockClear()
    fireEvent.click(view.getByRole('button', { name: '刷新终端显示' }))
    expect(terminalMocks.refresh).toHaveBeenCalledWith(0, terminalMocks.rows - 1)
    expect(terminalMocks.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(window.agentManager.write).not.toHaveBeenCalled()
    expect(window.agentManager.terminalReplay).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(500))
    expect(window.agentManager.resize).toHaveBeenCalledWith(session.sessionId, 93, 19)
    expect(window.agentManager.resize).toHaveBeenLastCalledWith(session.sessionId, 93, 20)
    fireEvent.click(view.getByRole('button', { name: '复制原生会话 ID' }))
    expect(window.agentManager.writeClipboardText).toHaveBeenCalledWith('native-demo-id')
    view.unmount()
    expect(view.queryByRole('button', { name: '刷新终端显示' })).toBeNull()
  })

  it('retains a manual refresh until delayed replay and initial fitting finish', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(753)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    let resolveReplay!: (value: { data: string; sequence: number }) => void
    vi.mocked(window.agentManager.terminalReplay).mockReturnValue(new Promise(resolve => { resolveReplay = resolve }))
    const view = render(<TerminalTile session={session} />)
    fireEvent.click(view.getByRole('button', { name: '刷新终端显示' }))
    await act(async () => vi.advanceTimersByTime(500))
    expect(window.agentManager.resize).not.toHaveBeenCalled()
    await act(async () => { resolveReplay({ data: 'old screen', sequence: 0 }); await Promise.resolve() })
    await act(async () => vi.advanceTimersByTime(2000))
    expect(vi.mocked(window.agentManager.resize).mock.calls.map(call => call.slice(1))).toEqual([[93, 20], [93, 19], [93, 20]])
    await act(async () => vi.advanceTimersByTime(10000))
    expect(window.agentManager.resize).toHaveBeenCalledTimes(3)
    expect(window.agentManager.write).not.toHaveBeenCalled()
  })

  it('ignores the removed page-return refresh event', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(753)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
    terminalMocks.write.mockImplementation((_data, done) => done?.())
    const view = render(<TerminalTile session={session} />)
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(250) })
    vi.mocked(window.agentManager.resize).mockClear()
    act(() => view.container.querySelector('.terminal-live-host')!.dispatchEvent(new Event('terminal-page-return')))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(window.agentManager.resize).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(10000))
    expect(window.agentManager.resize).not.toHaveBeenCalled()
    expect(window.agentManager.write).not.toHaveBeenCalled()
    expect(window.agentManager.terminalReplay).toHaveBeenCalledTimes(1)
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
