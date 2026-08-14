import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'

import type { SessionSummary } from './shared/manager-api'
import codexLogoUrl from '../logo/codex.png'
import claudeLogoUrl from '../logo/claudecode.png'

const AGENT_LOGO_URLS: Partial<Record<SessionSummary['agentKind'], string>> = { codex: codexLogoUrl, claude: claudeLogoUrl }

function AgentLogo({ kind, className = '' }: { kind: SessionSummary['agentKind']; className?: string }): JSX.Element {
  const source = AGENT_LOGO_URLS[kind]
  return source ? <img className={className} src={source} alt={kind === 'claude' ? 'Claude Code' : 'Codex'} /> : <span className={className}>{kind === 'pi' ? 'Pi' : kind === 'generic' ? '›_' : 'C'}</span>
}

const STABLE_TERMINAL_COLS = 100
const STABLE_TERMINAL_ROWS = 30
// Bounds mirror the validation in electron/main.ts `dimensions()`, so a fitted size
// can never be rejected by the main process.
const MIN_TERMINAL_COLS = 24
const MAX_TERMINAL_COLS = 500
const MIN_TERMINAL_ROWS = 8
const MAX_TERMINAL_ROWS = 200
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 18
// `.xterm-viewport` keeps a thin scrollbar gutter; reserve it so the last column
// is never clipped and the grid still fills the surface.
const TERMINAL_SCROLLBAR_WIDTH = 9

export const NATIVE_TERMINAL_THEME = {
  background: '#0b1011',
  foreground: '#cbd9d7',
  cursor: '#b9d2cc',
  selectionBackground: '#315d4e',
  black: '#111719',
  red: '#f07b7b',
  green: '#4dcc99',
  yellow: '#efbd58',
  blue: '#78afe6',
  magenta: '#c08ad8',
  cyan: '#63c7c9',
  white: '#d5dfdd',
  brightBlack: '#667579',
  brightRed: '#ff9a9a',
  brightGreen: '#72deb5',
  brightYellow: '#ffd37a',
  brightBlue: '#9bc7f2',
  brightMagenta: '#d6a6e8',
  brightCyan: '#8adfe0',
  brightWhite: '#f5f8f8',
} as const

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

// xterm measures its own cell box after every font change and exposes it only through
// its internal render service; the official fit addon reads the same field. Guard the
// access so an xterm upgrade degrades to "keep current size" instead of throwing.
export function terminalCellSize(terminal: Terminal): { width: number; height: number } | undefined {
  const dimensions = (terminal as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } }
  })._core?._renderService?.dimensions?.css?.cell
  if (!dimensions?.width || !dimensions.height) return undefined
  return { width: dimensions.width, height: dimensions.height }
}

export function isTerminalProtocolResponse(data: string): boolean {
  return /^(?:\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\?[\d;]*u)$/.test(data)
}

function isClosedPreviousHostError(message: string): boolean {
  return /Host\s+[0-9a-f-]+\s+connection (?:is )?closed/i.test(message)
}

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  starting: '启动中', running: '运行中', needs_approval: '待授权', recovering: '请稍后…',
  needs_attention: '需要处理',
  completed: '已完成', stopped: '已停止', failed: '失败', unknown: '未知',
}

interface TerminalTileProps {
  session: SessionSummary
  detail?: boolean
  embedded?: boolean
  hidden?: boolean
  onOpen?: () => void
  onEdit?: () => void
  onFullAuto?: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: () => void
}

export default function TerminalTile({ session, detail = false, embedded = false, hidden = false, onOpen, onEdit, onFullAuto, draggable = false, dragging = false, onDragStart, onDragEnd, onDragOver }: TerminalTileProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState<'restart' | 'remove'>()
  const statusRef = useRef(session.status)
  statusRef.current = session.status
  const terminalEnded = session.status === 'completed' || session.status === 'stopped' || session.status === 'failed'

  useEffect(() => {
    if (terminalEnded) return
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cols: STABLE_TERMINAL_COLS,
      rows: STABLE_TERMINAL_ROWS,
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      minimumContrastRatio: 1,
      drawBoldTextInBrightColors: true,
      // Counted in visual rows, not messages. Narrowing the tile re-wraps every long line,
      // so the same history costs ~1.75x more rows at the grid width than at fullscreen
      // width. At 10,000 the trip fullscreen -> overview overflowed the limit and xterm
      // discarded the oldest rows for good, which read as "Claude Code lost its history"
      // (its prose and code lines wrap far more than Codex's compact inline output).
      // xterm grows the scrollback lazily, so a higher ceiling costs nothing until a
      // session really is that long.
      scrollback: 30_000,
      theme: NATIVE_TERMINAL_THEME,
    })
    terminal.open(host)
    let pendingOutput = ''
    let replayLoaded = false
    let outputBeforeReplay: Array<{ data: string; sequence?: number }> = []
    let outputFrame = 0
    let writeInFlight = false
    let resizeRedrawActive = false
    let resizeRedrawTimer: ReturnType<typeof setTimeout> | undefined
    let resizeCoverFailsafeTimer: ReturnType<typeof setTimeout> | undefined
    let resizeRedrawDeadline = 0
    let resizeCover: HTMLDivElement | undefined
    let initialReplayLoading = true
    let resizeWasAtBottom = true
    let lastPasteText = ''
    let lastPasteAt = 0
    let terminalInputQueue = Promise.resolve()
    let pendingTerminalInput = ''
    let inputFrame = 0
    let disposed = false
    // How far above the newest line the user has scrolled, counted from the bottom rather
    // than as an absolute row. Once the scrollback is full xterm drops the oldest line on
    // every new one, which shifts every absolute index down; pinning to one dragged the
    // view towards the very start of the history and made the scrollbar snap back.
    let userScrollOffset: number | undefined
    // scrollToLine/scrollToBottom/resize all emit onScroll as well. Only a genuine user
    // gesture may arm the browsing lock, otherwise a resize latches it onto a line nobody
    // chose and every later redraw re-pins the viewport there.
    let programmaticScrollDepth = 0
    const programmaticScroll = (action: () => void): void => {
      programmaticScrollDepth += 1
      try { action() } finally { programmaticScrollDepth -= 1 }
    }
    const restoreUserScroll = (): void => {
      if (userScrollOffset === undefined) return
      const target = Math.max(0, terminal.buffer.active.baseY - userScrollOffset)
      programmaticScroll(() => terminal.scrollToLine(target))
    }
    const scrollToLatest = (): void => {
      userScrollOffset = undefined
      programmaticScroll(() => terminal.scrollToBottom())
    }
    const preserveLatestReplayScrollback = (data: string): string => {
      const standard = data.lastIndexOf('\x1b[3J')
      const padded = data.lastIndexOf('\x1b[03J')
      const checkpoint = Math.max(standard, padded)
      if (checkpoint < 0) return data
      const length = padded === checkpoint ? 5 : 4
      return data.slice(0, checkpoint) + data.slice(checkpoint + length)
    }
    const hideResizeCover = (): void => {
      resizeCover?.remove()
      resizeCover = undefined
      if (resizeCoverFailsafeTimer) {
        clearTimeout(resizeCoverFailsafeTimer)
        resizeCoverFailsafeTimer = undefined
      }
    }
    const showResizeCover = (showMessage = false): void => {
      if (resizeCover) return
      const cover = document.createElement('div')
      cover.className = 'terminal-resize-cover'
      const activeBuffer = terminal.buffer.active
      resizeWasAtBottom = activeBuffer.viewportY >= activeBuffer.baseY
      const hostBounds = host.getBoundingClientRect()
      for (const canvas of host.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')) {
        const bounds = canvas.getBoundingClientRect()
        const copy = document.createElement('canvas')
        copy.width = canvas.width
        copy.height = canvas.height
        copy.style.left = `${bounds.left - hostBounds.left}px`
        copy.style.top = `${bounds.top - hostBounds.top}px`
        copy.style.width = `${bounds.width}px`
        copy.style.height = `${bounds.height}px`
        copy.getContext('2d')?.drawImage(canvas, 0, 0)
        cover.appendChild(copy)
      }
      if (showMessage || !cover.childElementCount) cover.textContent = '请稍后…'
      host.appendChild(cover)
      resizeCover = cover
    }
    const scheduleResizeRedrawFlush = (): void => {
      if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
      const remaining = Math.max(0, resizeRedrawDeadline - performance.now())
      resizeRedrawTimer = setTimeout(flushOutput, Math.min(140, remaining))
    }
    const flushOutput = (): void => {
      outputFrame = 0
      if (resizeRedrawTimer) {
        clearTimeout(resizeRedrawTimer)
        resizeRedrawTimer = undefined
      }
      if (writeInFlight) {
        if (resizeRedrawActive) scheduleResizeRedrawFlush()
        return
      }
      const output = pendingOutput
      pendingOutput = ''
      if (!output) return
      const synchronizedResizeRedraw = resizeRedrawActive || initialReplayLoading
      resizeRedrawActive = false
      initialReplayLoading = false
      writeInFlight = true
      terminal.write(synchronizedResizeRedraw ? `\x1b[?2026h${output}\x1b[?2026l` : output, () => {
        writeInFlight = false
        restoreUserScroll()
        if (synchronizedResizeRedraw) {
          if (resizeWasAtBottom && userScrollOffset === undefined) programmaticScroll(() => terminal.scrollToBottom())
          requestAnimationFrame(() => requestAnimationFrame(hideResizeCover))
        }
        if (pendingOutput && !outputFrame) outputFrame = requestAnimationFrame(flushOutput)
      })
    }
    const flushTerminalInput = (): void => {
      inputFrame = 0
      const payload = pendingTerminalInput
      pendingTerminalInput = ''
      if (!payload || disposed) return
      terminalInputQueue = terminalInputQueue.then(async () => {
        for (let offset = 0; offset < payload.length;) {
          if (disposed) return
          let end = Math.min(payload.length, offset + 4_096)
          if (end < payload.length) {
            const last = payload.charCodeAt(end - 1)
            const next = payload.charCodeAt(end)
            if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1
          }
          await window.agentManager.write(session.sessionId, payload.slice(offset, end))
          offset = end
        }
      }).catch((reason) => {
        if (disposed) return
        const message = reason instanceof Error ? reason.message : String(reason)
        if (isClosedPreviousHostError(message) && (statusRef.current === 'starting' || statusRef.current === 'recovering')) return
        setActionError(message)
      })
    }
    const queueTerminalInput = (data: string, immediate = false): void => {
      if (disposed || !data) return
      pendingTerminalInput += data
      if (immediate) {
        if (inputFrame) cancelAnimationFrame(inputFrame)
        flushTerminalInput()
      } else if (!inputFrame) inputFrame = requestAnimationFrame(flushTerminalInput)
    }
    const submitPlainTextPaste = (text: string): void => {
      if (!text) return
      const now = performance.now()
      if (text === lastPasteText && now - lastPasteAt < 1_000) return
      lastPasteText = text
      lastPasteAt = now
      const normalized = text.replace(/\r?\n/g, '\r')
      const payload = terminal.modes.bracketedPasteMode
        ? `\x1b[200~${normalized}\x1b[201~`
        : normalized
      scrollToLatest()
      queueTerminalInput(payload, true)
    }
    const pastePlainText = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      submitPlainTextPaste(event.clipboardData?.getData('text/plain') ?? '')
    }
    host.addEventListener('paste', pastePlainText, true)
    terminal.attachCustomKeyEventHandler((event) => {
      const isPaste = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase('en-US') === 'v'
      const isCopy = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLocaleLowerCase('en-US') === 'c'
      if (isCopy) {
        if (event.type === 'keydown' && terminal.hasSelection()) {
          void window.agentManager.writeClipboardText(terminal.getSelection())
        }
        return false
      }
      if (!isPaste) return true
      if (event.type === 'keydown') {
        void window.agentManager.readClipboardText()
          .then(submitPlainTextPaste)
          .catch((reason) => setActionError(reason instanceof Error ? reason.message : String(reason)))
      }
      return false
    })
    const input = terminal.onData((data) => {
      // Codex terminal probes are answered synchronously by its persistent Host. A renderer replay
      // can parse the same query again; do not deliver that duplicate protocol reply as user input.
      if (session.agentKind === 'codex' && isTerminalProtocolResponse(data)) return
      userScrollOffset = undefined
      queueTerminalInput(data, /[\r\n\x03\x1b]/.test(data))
    })
    const scroll = terminal.onScroll(() => {
      // Ignore the scrolls we cause ourselves; only a real gesture arms the browsing lock.
      if (programmaticScrollDepth > 0) return
      const buffer = terminal.buffer.active
      userScrollOffset = buffer.viewportY < buffer.baseY ? buffer.baseY - buffer.viewportY : undefined
    })
    const scrollTerminal = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      const buffer = terminal.buffer.active
      if (buffer.type !== 'normal' || buffer.baseY <= 0) return
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / 36))
      const currentLine = userScrollOffset === undefined
        ? buffer.viewportY
        : Math.max(0, buffer.baseY - userScrollOffset)
      const targetLine = Math.max(0, Math.min(buffer.baseY, currentLine + (event.deltaY < 0 ? -lines : lines)))
      userScrollOffset = targetLine < buffer.baseY ? buffer.baseY - targetLine : undefined
      programmaticScroll(() => terminal.scrollToLine(targetLine))
      event.preventDefault()
      event.stopPropagation()
    }
    host.addEventListener('wheel', scrollTerminal, { capture: true, passive: false })
    let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'terminal-copy-button'
    copyButton.textContent = '复制'
    copyButton.title = '复制选中内容；未选中时复制当前终端屏幕'
    copyButton.setAttribute('aria-label', '复制终端内容')
    const visibleTerminalText = (): string => {
      const buffer = terminal.buffer.active
      const lines: string[] = []
      const end = Math.min(buffer.length, buffer.viewportY + terminal.rows)
      for (let index = buffer.viewportY; index < end; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      }
      return lines.join('\n').replace(/\s+$/, '')
    }
    const showCopyFeedback = (label: string): void => {
      copyButton.textContent = label
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
      copyFeedbackTimer = setTimeout(() => { copyButton.textContent = '复制' }, 1_200)
    }
    const copyTerminalContent = (): void => {
      const text = terminal.hasSelection() ? terminal.getSelection() : visibleTerminalText()
      if (!text) {
        showCopyFeedback('无内容')
        return
      }
      void Promise.resolve(window.agentManager.writeClipboardText(text))
        .then(() => showCopyFeedback('已复制'))
        .catch((reason) => setActionError(reason instanceof Error ? reason.message : String(reason)))
    }
    const preserveSelection = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const clickCopy = (event: MouseEvent): void => {
      event.stopPropagation()
      copyTerminalContent()
    }
    copyButton.addEventListener('mousedown', preserveSelection)
    copyButton.addEventListener('click', clickCopy)
    host.appendChild(copyButton)
    const copySelection = (event: MouseEvent): void => {
      if (!terminal.hasSelection()) return
      event.preventDefault()
      void window.agentManager.writeClipboardText(terminal.getSelection())
    }
    host.addEventListener('contextmenu', copySelection)
    showResizeCover(true)
    const unsubscribe = window.agentManager.subscribe((event) => {
      if ('sessionId' in event && event.sessionId === session.sessionId && event.type === 'output') {
        if (!replayLoaded) {
          outputBeforeReplay.push({ data: event.data, sequence: event.sequence })
          return
        }
        pendingOutput += event.data
        if (resizeRedrawActive) scheduleResizeRedrawFlush()
        else if (!outputFrame) outputFrame = requestAnimationFrame(flushOutput)
      }
    })
    void window.agentManager.terminalReplay(session.sessionId).then((snapshot) => {
      pendingOutput += preserveLatestReplayScrollback(snapshot.data)
      for (const event of outputBeforeReplay) {
        if (event.sequence === undefined || event.sequence > snapshot.sequence) {
          pendingOutput += event.data
        }
      }
      outputBeforeReplay = []
      replayLoaded = true
      if (pendingOutput && !outputFrame) outputFrame = requestAnimationFrame(flushOutput)
      else {
        initialReplayLoading = false
        hideResizeCover()
      }
    }).catch(() => {
      for (const event of outputBeforeReplay) pendingOutput += event.data
      outputBeforeReplay = []
      replayLoaded = true
      if (pendingOutput && !outputFrame) outputFrame = requestAnimationFrame(flushOutput)
      else {
        initialReplayLoading = false
        hideResizeCover()
      }
    })
    let resizeFrame = 0
    let ptyResizeTimer: ReturnType<typeof setTimeout> | undefined
    let lastSentCols = STABLE_TERMINAL_COLS
    let lastSentRows = STABLE_TERMINAL_ROWS
    const sendPtyResize = (cols: number, rows: number): void => {
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      // Agents reflow their whole TUI on SIGWINCH, so only tell the PTY once the
      // drag has settled instead of on every intermediate frame.
      ptyResizeTimer = setTimeout(() => {
        ptyResizeTimer = undefined
        if (disposed || (cols === lastSentCols && rows === lastSentRows)) return
        lastSentCols = cols
        lastSentRows = rows
        void Promise.resolve(window.agentManager.resize(session.sessionId, cols, rows)).catch(() => undefined)
      }, 180)
    }
    const fitTerminal = (): void => {
      if (disposed || !host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return
      const style = getComputedStyle(host)
      const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      const availableWidth = host.clientWidth - paddingX - TERMINAL_SCROLLBAR_WIDTH
      const availableHeight = host.clientHeight - paddingY
      if (availableWidth <= 0 || availableHeight <= 0) return
      // Keep roughly today's text density: pick the font from the width a full-width
      // agent screen wants, then let the column and row counts take up whatever space
      // is left. Scaling the font alone pinned the grid at 100x30, so any container
      // whose aspect ratio or size did not match that box was left with black margins.
      const fontSize = clamp(Math.floor(availableWidth / (STABLE_TERMINAL_COLS * .62)), MIN_FONT_SIZE, MAX_FONT_SIZE)
      if (terminal.options.fontSize !== fontSize) {
        terminal.options.fontSize = fontSize
        // xterm re-measures its cell box after the font changes, so fit the grid on the
        // next frame when the new metrics are available rather than with stale ones.
        scheduleResize()
        return
      }
      const cell = terminalCellSize(terminal)
      if (!cell) return
      const cols = clamp(Math.floor(availableWidth / cell.width), MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
      const rows = clamp(Math.floor(availableHeight / cell.height), MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
      if (cols === terminal.cols && rows === terminal.rows) return
      showResizeCover()
      resizeRedrawActive = true
      resizeRedrawDeadline = performance.now() + 600
      if (resizeCoverFailsafeTimer) clearTimeout(resizeCoverFailsafeTimer)
      resizeCoverFailsafeTimer = setTimeout(hideResizeCover, 900)
      programmaticScroll(() => terminal.resize(cols, rows))
      // A resize changes how many lines fit, so re-anchor explicitly rather than leaving
      // the viewport wherever the reflow happened to drop it. Going fullscreen and back
      // otherwise left the tile parked at the top of the history.
      if (userScrollOffset === undefined) programmaticScroll(() => terminal.scrollToBottom())
      else restoreUserScroll()
      sendPtyResize(cols, rows)
    }
    const scheduleResize = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fitTerminal)
    }
    scheduleResize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleResize)
    observer?.observe(host)
    return () => {
      disposed = true
      pendingTerminalInput = ''
      if (inputFrame) cancelAnimationFrame(inputFrame)
      cancelAnimationFrame(resizeFrame)
      cancelAnimationFrame(outputFrame)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
      if (resizeCoverFailsafeTimer) clearTimeout(resizeCoverFailsafeTimer)
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
      resizeCover?.remove()
      pendingOutput = ''
      outputBeforeReplay = []
      observer?.disconnect()
      unsubscribe()
      input.dispose()
      scroll.dispose()
      host.removeEventListener('wheel', scrollTerminal, true)
      host.removeEventListener('contextmenu', copySelection)
      host.removeEventListener('paste', pastePlainText, true)
      copyButton.removeEventListener('mousedown', preserveSelection)
      copyButton.removeEventListener('click', clickCopy)
      copyButton.remove()
      terminal.dispose()
    }
  }, [session.sessionId, terminalEnded])

  useEffect(() => {
    if (session.status === 'starting' || session.status === 'recovering' || session.status === 'running') {
      setActionError((message) => isClosedPreviousHostError(message) ? '' : message)
    }
  }, [session.status])

  const openDetail = (): void => { if (!detail && !embedded && !terminalEnded) onOpen?.() }
  const runAction = (action: () => Promise<void> | void, busy?: 'restart' | 'remove'): void => {
    setActionError('')
    if (busy) setActionBusy(busy)
    void Promise.resolve(action())
      .catch((reason) => setActionError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { if (busy) setActionBusy(undefined) })
  }

  return (
    <article
      className={`terminal-card${detail ? ' terminal-card-detail' : ''}${embedded ? ' terminal-card-embedded' : ''}${hidden ? ' terminal-card-hidden' : ''}${dragging ? ' terminal-card-dragging' : ''}`}
      onDragOver={(event) => { if (!draggable) return; event.preventDefault(); onDragOver?.() }}
      data-testid={`terminal-tile-${session.sessionId}`}
      onClick={openDetail}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !detail && !embedded) openDetail() }}
      tabIndex={detail || embedded || hidden || terminalEnded ? -1 : 0}
      aria-hidden={hidden || undefined}
    >
      <header className="terminal-card-header" draggable={draggable} onDragStart={() => onDragStart?.()} onDragEnd={() => onDragEnd?.()}>
        <div className="agent-identity">
          <AgentLogo kind={session.agentKind} className={'agent-dot agent-' + session.agentKind} />
          <div><h2>{session.displayName}</h2><p title={session.workspace}>{session.workspace}</p></div>
        </div>
        <div className="terminal-actions">
          <span className={`status-badge status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
          {!terminalEnded && onFullAuto && <button className={'full-auto-tile-button' + (session.fullAutoEnabled ? ' active' : '')} type="button" title={session.fullAutoEnabled ? '关闭全自动模式' : '开启全自动模式'} onClick={(event) => { event.stopPropagation(); onFullAuto() }}>{session.fullAutoEnabled ? '全自动中' : '全自动'}</button>}
          {onEdit && <button className="button-ghost" type="button" title="编辑 Agent" onClick={(event) => { event.stopPropagation(); onEdit() }} aria-label={`编辑 ${session.displayName}`}>✎</button>}
          {!detail && !embedded && !terminalEnded && <button className="button-ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen?.() }} aria-label={`查看 ${session.displayName}`}>⛶</button>}
          {terminalEnded ? <>
            <button className="button-secondary button-compact" type="button" disabled={Boolean(actionBusy)} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.restartSession(session.sessionId), 'restart') }}>{actionBusy === 'restart' ? '请稍后…' : '重新启动'}</button>
            <button className="button-danger" type="button" disabled={Boolean(actionBusy)} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.removeSession(session.sessionId), 'remove') }}>{actionBusy === 'remove' ? '请稍后…' : '删除'}</button>
          </> : <button className="button-danger" type="button" aria-label="停止" title="停止" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.stopSession(session.sessionId)) }}>■</button>}
        </div>
      </header>
      {terminalEnded ? <div className="terminal-ended" onClick={(event) => event.stopPropagation()}>
        <div className="terminal-ended-icon">›_</div>
        <strong>{session.status === 'completed' ? 'Agent 已正常完成' : session.status === 'stopped' ? 'Agent 已停止' : 'Agent 运行失败'}</strong>
        <span className={actionError ? 'terminal-ended-error' : undefined}>{actionError || (session.status === 'failed' && session.lastError ? session.lastError : '终端进程已经关闭，可重新启动或从总览删除。')}</span>
      </div> : <div
        className="terminal-surface"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="terminal-live-host" ref={hostRef} />
      </div>}
      {!terminalEnded && <div className="terminal-status-slot">
        {actionError && session.status !== 'needs_approval' && session.status !== 'needs_attention' ? <div className="tile-error">{actionError}</div>
          : session.status === 'needs_approval' ? <div className="inline-request"><span>Agent 正在等待本次授权</span><button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.approveSession(session.sessionId) }}>批准</button></div>
            : session.status === 'needs_attention' ? <div className="inline-request attention-request"><span title={session.lastError}>{session.attentionKind === 'host-unresponsive' ? 'Agent 窗口疑似卡死，是否重启？' : '检测到异常：' + (session.lastError ?? '原因未知')}</span><button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.dismissRecoverySuggestion(session.sessionId)) }}>{session.attentionKind === 'host-unresponsive' ? '暂不重启' : '忽略'}</button>{session.attentionKind !== 'host-unresponsive' && <button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.acceptRecoverySuggestion(session.sessionId)) }}>采纳</button>}<button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.tryRecoveryOnce(session.sessionId)) }}>{session.attentionKind === 'host-unresponsive' ? '重启 Agent' : '尝试一次'}</button></div>
              : session.status === 'recovering' ? <div className="recovery-bar"><span>↻</span><span>请稍后…</span></div>
                : session.approvalSuggestion ? <div className="approval-suggestion"><span className="approval-suggestion-summary" tabIndex={0} data-tooltip={`已手动批准 ${session.approvalSuggestion.approvalCount} 次\n命令：${session.approvalSuggestion.command}\n加入后，相同命令将按安全规则自动批准。`}>已手动批准 {session.approvalSuggestion.approvalCount} 次 · {session.approvalSuggestion.command}</span><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.acceptApprovalSuggestion(session.sessionId) }}>加入</button><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.dismissApprovalSuggestion(session.sessionId) }}>暂不</button></div>
                  : null}
      </div>}
    </article>
  )
}
