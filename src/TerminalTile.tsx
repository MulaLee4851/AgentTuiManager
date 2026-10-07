import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import type { FreeWindowRect, ResizeEdge } from './free-overview-layout'
import { APPROVAL_MODE_LABEL, approvalModeOf } from './shared/approval-mode'
import { Terminal } from '@xterm/xterm'
import { useAppearanceSettings } from './appearance-settings'
import { TerminalFontSizer } from './terminal-font-size'

import type { ApprovalRequest, SessionSummary } from './shared/manager-api'
import { approvalReviewLabel } from './shared/approval-review-label'
import { SESSION_STATUS_LABEL, sessionDisplayStatus } from './shared/session-state'
import { TerminalWriteWatchdog } from './terminal-write-watchdog'
import { writeTerminalOutput } from './terminal-output'
import DeepSeekStartupOutput from './DeepSeekStartupOutput'
import { deepSeekWebUrl as validateDeepSeekWebUrl } from './shared/deepseek-web-url'
import codexLogoUrl from '../logo/codex.png'
import claudeLogoUrl from '../logo/claudecode.png'
import deepseekLogoUrl from '../logo/deepseek.svg'

const AGENT_LOGO_URLS: Partial<Record<SessionSummary['agentKind'], string>> = { codex: codexLogoUrl, claude: claudeLogoUrl, deepseek: deepseekLogoUrl }

function AgentLogo({ kind, className = '' }: { kind: SessionSummary['agentKind']; className?: string }): JSX.Element {
  const source = AGENT_LOGO_URLS[kind]
  return source ? <img className={className} src={source} alt={kind === 'claude' ? 'Claude Code' : kind === 'deepseek' ? 'DeepSeek Harness' : 'Codex'} /> : <span className={className}>{kind === 'pi' ? 'Pi' : kind === 'generic' ? '›_' : 'C'}</span>
}

const STABLE_TERMINAL_COLS = 100
const STABLE_TERMINAL_ROWS = 30
// Bounds mirror the validation in electron/main.ts `dimensions()`, so a fitted size
// can never be rejected by the main process.
const MIN_TERMINAL_COLS = 24
const MAX_TERMINAL_COLS = 500
const MIN_TERMINAL_ROWS = 8
const MAX_TERMINAL_ROWS = 200
// `.xterm-viewport` keeps a thin scrollbar gutter; reserve it so the last column
// is never clipped and the grid still fills the surface.
const TERMINAL_SCROLLBAR_WIDTH = 9
// xterm normally completes a write within a frame or two. If its callback is lost,
// keeping `writeInFlight` latched forever freezes only the visible terminal while the
// PTY and approval UI continue running. This deadline releases that renderer-side latch
// without replaying data, resizing the PTY, or changing the user's scroll position.
const TERMINAL_WRITE_WATCHDOG_MS = 2_000

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
  // ESC [ C/D are normal right/left arrow input, not device responses.
  return /^(?:(?:\x1b\[\??\d+;\d+R|\x1b\[\??[\d;]+c|\x1b\[>[\d;]+c|\x1b\[\?[\d;]+u)|(?:\x1b\](?:10|11|12);rgb:[\da-f]{1,4}\/[\da-f]{1,4}\/[\da-f]{1,4}(?:\x07|\x1b\\)))+$/i.test(data)
}

function isClosedPreviousHostError(message: string): boolean {
  return /Host\s+[0-9a-f-]+\s+connection (?:is )?closed/i.test(message)
}



interface TerminalTileProps {
  freeLayout?: {
    rect: FreeWindowRect
    start: (edge: 'move' | ResizeEdge, event: ReactPointerEvent<HTMLElement>) => void
    keyAdjust: (edge: 'move' | ResizeEdge, event: ReactKeyboardEvent<HTMLElement>) => void
  }
  session: SessionSummary
  approval?: ApprovalRequest
  detail?: boolean
  embedded?: boolean
  hidden?: boolean
  retained?: boolean
  active?: boolean
  onActivate?: () => void
  onOpen?: () => void
  onEdit?: () => void
  onBinding?: (mode: 'history' | 'fresh') => void
  onContinuation?: () => void
  onFullAuto?: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: () => void
}

export default function TerminalTile({ session, approval, detail = false, embedded = false, hidden = false, retained = true, active = false, onActivate, onOpen, onEdit, onContinuation, onBinding, onFullAuto, draggable = false, dragging = false, onDragStart, onDragEnd, onDragOver, freeLayout }: TerminalTileProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const { settings: appearance } = useAppearanceSettings()
  const fontSizeRef = useRef(appearance.terminalFontSize)
  const uiSizeRef = useRef(appearance.uiSize)
  const requestFit = useRef<() => void>()
  fontSizeRef.current = appearance.terminalFontSize
  uiSizeRef.current = appearance.uiSize
  useEffect(() => { requestFit.current?.() }, [appearance.terminalFontSize, appearance.uiSize])
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState<'restart' | 'remove'>()
  const statusRef = useRef(session.status)
  statusRef.current = session.status
  const terminalEnded = session.status === 'completed' || session.status === 'stopped' || session.status === 'failed'
  const deepSeekWeb = session.agentKind === 'deepseek'
  const deepSeekWebUrl = validateDeepSeekWebUrl(session.webUrl)

  useEffect(() => {
    if (terminalEnded || deepSeekWeb || !retained) return
    const host = hostRef.current
    if (!host) return
    const fontSizer = new TerminalFontSizer()
    const terminal = new Terminal({
      cols: STABLE_TERMINAL_COLS,
      rows: STABLE_TERMINAL_ROWS,
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: fontSizeRef.current === 'auto' ? 12 : fontSizeRef.current,
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
      linkHandler: {
        activate: (_event, url) => {
          void window.agentManager.openExternalWeb(url)
            .catch(() => setActionError('无法打开链接，仅支持 HTTP/HTTPS 网页。'))
        },
      },
    })
    terminal.open(host)
    let pendingOutput = ''
    let replayLoaded = false
    let replayProtocolResponsesBlocked = false
    let outputBeforeReplay: Array<{ data: string; sequence?: number }> = []
    let outputFrame = 0
    let writeInFlight = false
    let resizeAfterWrite = false
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
    let terminalRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let terminalRefreshPending = false
    let manualRedrawRequested = false
    const writeWatchdog = new TerminalWriteWatchdog(TERMINAL_WRITE_WATCHDOG_MS)
    // How far above the newest line the user has scrolled, counted from the bottom rather
    // than as an absolute row. Once the scrollback is full xterm drops the oldest line on
    // every new one, which shifts every absolute index down; pinning to one dragged the
    // view towards the very start of the history and made the scrollbar snap back.
    let userScrollOffset: number | undefined
    let pointerScrollGesture = false
    let keyboardScrollGesture = false
    // scrollToLine/scrollToBottom/resize all emit onScroll as well. Only a genuine user
    // gesture may arm the browsing lock, otherwise a resize latches it onto a line nobody
    // chose and every later redraw re-pins the viewport there.
    let programmaticScrollDepth = 0
    const programmaticScroll = (action: () => void): void => {
      programmaticScrollDepth += 1
      try { action() } finally { programmaticScrollDepth -= 1 }
    }
    const restoreUserScroll = (): void => {
      if (terminal.buffer.active.type !== 'normal') { userScrollOffset = undefined; return }
      if (userScrollOffset === undefined) return
      const target = Math.max(0, terminal.buffer.active.baseY - userScrollOffset)
      programmaticScroll(() => terminal.scrollToLine(target))
    }
    const scrollToLatest = (): void => {
      userScrollOffset = undefined
      if (terminal.buffer.active.type === 'normal') programmaticScroll(() => terminal.scrollToBottom())
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
      if (disposed) return
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
      replayProtocolResponsesBlocked = initialReplayLoading
      resizeRedrawActive = false
      initialReplayLoading = false
      writeInFlight = true
      const completeWrite = writeWatchdog.arm((timedOut) => {
        writeInFlight = false
        replayProtocolResponsesBlocked = false
        restoreUserScroll()
        if (terminalRefreshPending || timedOut) {
          terminalRefreshPending = false
          if (terminalRefreshTimer) {
            clearTimeout(terminalRefreshTimer)
            terminalRefreshTimer = undefined
          }
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        }
        if (synchronizedResizeRedraw) {
          if (terminal.buffer.active.type === 'normal' && resizeWasAtBottom && userScrollOffset === undefined) programmaticScroll(() => terminal.scrollToBottom())
          requestAnimationFrame(() => requestAnimationFrame(hideResizeCover))
        }
        if (pendingOutput && !outputFrame) outputFrame = requestAnimationFrame(flushOutput)
        if (resizeAfterWrite || synchronizedResizeRedraw) {
          resizeAfterWrite = false
          scheduleResize()
        }
      }, () => {
        // A timed-out write may still finish later. Repaint and restore only an explicit
        // user scroll lock; never release the current generation's latch from here.
        restoreUserScroll()
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      })
      // Never inject escape sequences at transport chunk boundaries: output may
      // end halfway through a CSI/OSC command. The visual cover hides resize frames.
      writeTerminalOutput(terminal, output, completeWrite, completeWrite.progress)
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
      const isCopy = (event.ctrlKey || event.metaKey) && !event.altKey
        && event.key.toLocaleLowerCase('en-US') === 'c'
        && (event.shiftKey || event.metaKey || terminal.hasSelection())
      if (isCopy) {
        // Consume copying even on failure: never fall through to xterm's ETX.
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'keydown' && !event.repeat && terminal.hasSelection()) {
          const selected = terminal.getSelection()
          void Promise.resolve().then(() => window.agentManager.writeClipboardText(selected))
            .catch((reason) => setActionError(reason instanceof Error ? reason.message : String(reason)))
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
      // Replaying an old query makes a new xterm instance answer it again. The original live query
      // was already handled, so never deliver that duplicate reply as user input. Codex Host also
      // answers live probes itself; preserve the existing all-time Codex guard.
      if (isTerminalProtocolResponse(data) && (session.agentKind === 'codex' || replayProtocolResponsesBlocked)) return
      if (!isTerminalProtocolResponse(data)) {
        userScrollOffset = undefined
        keyboardScrollGesture = false
        pointerScrollGesture = false
      }
      queueTerminalInput(data, /[\r\n\x03\x1b]/.test(data))
    })
    const rememberGestureScroll = (): void => {
      // Public onScroll also reports TUI output and asynchronous viewport sync.
      // Those events must not turn an input redraw into a history-browsing lock.
      if (terminal.buffer.active.type !== 'normal') { userScrollOffset = undefined; return }
      if (programmaticScrollDepth > 0 || (!pointerScrollGesture && !keyboardScrollGesture)) return
      const buffer = terminal.buffer.active
      userScrollOffset = buffer.viewportY < buffer.baseY ? buffer.baseY - buffer.viewportY : undefined
    }
    const scroll = terminal.onScroll(rememberGestureScroll)
    const beginPointerScroll = (event: PointerEvent): void => {
      pointerScrollGesture = event.target instanceof Element && !!event.target.closest('.xterm-viewport')
    }
    const endPointerScroll = (): void => {
      rememberGestureScroll()
      pointerScrollGesture = false
    }
    const beginKeyboardScroll = (event: KeyboardEvent): void => {
      keyboardScrollGesture = event.shiftKey && ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)
    }
    const endKeyboardScroll = (): void => {
      rememberGestureScroll()
      keyboardScrollGesture = false
    }
    host.addEventListener('pointerdown', beginPointerScroll, true)
    document.addEventListener('pointerup', endPointerScroll)
    document.addEventListener('pointercancel', endPointerScroll)
    host.addEventListener('keydown', beginKeyboardScroll, true)
    host.addEventListener('keyup', endKeyboardScroll)
    host.addEventListener('blur', endKeyboardScroll, true)
    // xterm suppresses public onScroll for native scrollbar movement. Listen on
    // the viewport AFTER xterm's handler, not capture (which sees the old buffer).
    const scrollViewport = host.querySelector('.xterm-viewport')
    scrollViewport?.addEventListener('scroll', rememberGestureScroll)
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
    copyButton.title = '复制选中内容；未选中时复制当前终端屏幕。Ctrl+C：有选中内容时复制，无选中内容时中断'
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
    const refreshButton = document.createElement('button')
    refreshButton.type = 'button'
    refreshButton.className = 'terminal-copy-button terminal-refresh-button'
    refreshButton.textContent = '刷新'
    refreshButton.title = '重绘终端并回到底部，不重启 Agent'
    refreshButton.setAttribute('aria-label', '刷新终端显示')
    const clickRefresh = (event: MouseEvent): void => {
      event.stopPropagation()
      scrollToLatest()
      manualRedrawRequested = true
      scheduleResize()
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
      // Also repaint after any in-flight output, without replaying/duplicating it.
      terminalRefreshPending = writeInFlight
    }
    refreshButton.addEventListener('mousedown', preserveSelection)
    refreshButton.addEventListener('click', clickRefresh)
    host.appendChild(refreshButton)
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
      } else if ('sessionId' in event && event.sessionId === session.sessionId && event.type === 'terminal-refresh-requested') {
        // Auto-approval can leave xterm's canvas one paint behind even though the PTY and
        // buffer are already progressing. Repaint the existing viewport only: never fit,
        // resize, remount, or scroll, since those actions reflow native TUIs and can move a
        // user who is reading history. Prefer the next completed write so the repaint sees
        // the newest frame; the timer also recovers a canvas when no further output arrives.
        terminalRefreshPending = true
        if (terminalRefreshTimer) clearTimeout(terminalRefreshTimer)
        terminalRefreshTimer = setTimeout(() => {
          terminalRefreshTimer = undefined
          if (!terminalRefreshPending || disposed) return
          terminalRefreshPending = false
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        }, 180)
      }
    })
    void window.agentManager.terminalReplay(session.sessionId).then((snapshot) => {
      if (disposed) return
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
        scheduleResize()
      }
    }).catch(() => {
      if (disposed) return
      for (const event of outputBeforeReplay) pendingOutput += event.data
      outputBeforeReplay = []
      replayLoaded = true
      if (pendingOutput && !outputFrame) outputFrame = requestAnimationFrame(flushOutput)
      else {
        initialReplayLoading = false
        hideResizeCover()
        scheduleResize()
      }
    })
    let resizeFrame = 0
    let ptyResizeTimer: ReturnType<typeof setTimeout> | undefined
    let lastSentCols: number | undefined
    let lastSentRows: number | undefined
    const sendPtyResize = (cols: number, rows: number): void => {
      if (disposed || (cols === lastSentCols && rows === lastSentRows)) return
      lastSentCols = cols
      lastSentRows = rows
      void Promise.resolve(window.agentManager.resize(session.sessionId, cols, rows)).catch(() => {
        // A failed IPC must not mark dimensions as successfully synchronized.
        if (lastSentCols === cols && lastSentRows === rows) {
          lastSentCols = undefined
          lastSentRows = undefined
        }
      })
    }
    const fitTerminal = (): void => {
      if (disposed || !host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return
      if (!replayLoaded || initialReplayLoading) return
      // Drain old-width output before changing the grid. No raw output is discarded.
      if (writeInFlight || pendingOutput) {
        resizeAfterWrite = true
        if (!writeInFlight) flushOutput()
        return
      }
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
      const fontSize = fontSizer.measure(availableWidth, uiSizeRef.current, fontSizeRef.current)
      if (terminal.options.fontSize !== fontSize) {
        terminal.options.fontSize = fontSize
        // xterm re-measures its cell box after the font changes, so fit the grid on the
        // next frame. The outer size change has already settled; do not add a second
        // 180ms debounce just to read the updated font metrics.
        scheduleResize(false)
        return
      }
      const cell = terminalCellSize(terminal)
      if (!cell) return
      const cols = clamp(Math.floor(availableWidth / cell.width), MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
      const fittedRows = clamp(Math.floor(availableHeight / cell.height), MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
      const forceRedraw = manualRedrawRequested && cols === terminal.cols && fittedRows === terminal.rows
      // Initial fitting is not the requested redraw: the PTY may already have
      // this size from before unmount, so that resize need not repaint anything.
      // Retain the request until replay is drained AND the local grid is fitted.
      if (forceRedraw) manualRedrawRequested = false
      // Notify the native TUI of a real size change, then restore the measured
      // size. Repainting stale xterm cells is insufficient.
      const rows = forceRedraw ? (fittedRows > MIN_TERMINAL_ROWS ? fittedRows - 1 : fittedRows + 1) : fittedRows
      if (cols === terminal.cols && rows === terminal.rows) {
        sendPtyResize(cols, rows)
        return
      }
      showResizeCover()
      resizeRedrawActive = true
      resizeRedrawDeadline = performance.now() + 600
      if (resizeCoverFailsafeTimer) clearTimeout(resizeCoverFailsafeTimer)
      resizeCoverFailsafeTimer = setTimeout(hideResizeCover, 900)
      programmaticScroll(() => terminal.resize(cols, rows))
      // A resize changes how many lines fit, so re-anchor explicitly rather than leaving
      // the viewport wherever the reflow happened to drop it. Going fullscreen and back
      // otherwise left the tile parked at the top of the history.
      if (terminal.buffer.active.type === 'normal' && userScrollOffset === undefined) programmaticScroll(() => terminal.scrollToBottom())
      else restoreUserScroll()
      sendPtyResize(cols, rows)
      if (forceRedraw || manualRedrawRequested) scheduleResize()
    }
    const scheduleResize = (debounce = true): void => {
      cancelAnimationFrame(resizeFrame)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      resizeFrame = requestAnimationFrame(() => {
        if (!debounce) { fitTerminal(); return }
        // Debounce the grid and PTY together, not just the PTY. Otherwise live
        // output uses old columns for 180ms while xterm already uses new ones.
        ptyResizeTimer = setTimeout(() => {
          ptyResizeTimer = undefined
          fitTerminal()
        }, 180)
      })
    }
    requestFit.current = scheduleResize
    scheduleResize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => scheduleResize())
    observer?.observe(host)
    return () => {
      requestFit.current = undefined
      disposed = true
      pendingTerminalInput = ''
      if (inputFrame) cancelAnimationFrame(inputFrame)
      cancelAnimationFrame(resizeFrame)
      cancelAnimationFrame(outputFrame)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
      if (resizeCoverFailsafeTimer) clearTimeout(resizeCoverFailsafeTimer)
      if (terminalRefreshTimer) clearTimeout(terminalRefreshTimer)
      writeWatchdog.dispose()
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
      resizeCover?.remove()
      pendingOutput = ''
      outputBeforeReplay = []
      observer?.disconnect()
      unsubscribe()
      input.dispose()
      scroll.dispose()
      host.removeEventListener('pointerdown', beginPointerScroll, true)
      document.removeEventListener('pointerup', endPointerScroll)
      document.removeEventListener('pointercancel', endPointerScroll)
      host.removeEventListener('keydown', beginKeyboardScroll, true)
      host.removeEventListener('keyup', endKeyboardScroll)
      host.removeEventListener('blur', endKeyboardScroll, true)
      scrollViewport?.removeEventListener('scroll', rememberGestureScroll)
      host.removeEventListener('wheel', scrollTerminal, true)
      host.removeEventListener('contextmenu', copySelection)
      host.removeEventListener('paste', pastePlainText, true)
      copyButton.removeEventListener('mousedown', preserveSelection)
      copyButton.removeEventListener('click', clickCopy)
      copyButton.remove()
      refreshButton.removeEventListener('mousedown', preserveSelection)
      refreshButton.removeEventListener('click', clickRefresh)
      refreshButton.remove()
      terminal.dispose()
    }
  }, [session.sessionId, terminalEnded, deepSeekWeb, retained])

  useEffect(() => {
    if (session.status === 'starting' || session.status === 'recovering' || session.status === 'running') {
      setActionError((message) => isClosedPreviousHostError(message) ? '' : message)
    }
  }, [session.status])
  useEffect(() => { setActionError('') }, [session.activitySince, session.nativeSessionId])

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
      className={`terminal-card${freeLayout ? ' terminal-card-floating' : ''}${active ? ' terminal-card-active' : ''}${detail ? ' terminal-card-detail' : ''}${embedded ? ' terminal-card-embedded' : ''}${hidden ? ' terminal-card-hidden' : ''}${dragging ? ' terminal-card-dragging' : ''}`}
      style={freeLayout ? { left: freeLayout.rect.x, top: freeLayout.rect.y, width: freeLayout.rect.width, height: freeLayout.rect.height, zIndex: freeLayout.rect.zIndex } : undefined}
      onPointerDownCapture={() => { if (!hidden) onActivate?.() }}
      onFocusCapture={() => { if (!hidden) onActivate?.() }}
      onDragOver={(event) => { if (!draggable) return; event.preventDefault(); onDragOver?.() }}
      data-testid={`terminal-tile-${session.sessionId}`}
      onClick={freeLayout ? undefined : openDetail}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ') && !detail && !embedded) openDetail() }}
      tabIndex={detail || embedded || hidden || terminalEnded ? -1 : 0}
      aria-hidden={hidden || undefined}
    >
      <header className="terminal-card-header" draggable={draggable} onDragStart={() => onDragStart?.()} onDragEnd={() => onDragEnd?.()}
        onPointerDown={event => { if (!(event.target as HTMLElement).closest('button, a, input, select, textarea')) freeLayout?.start('move', event) }}
        onDoubleClick={event => { if (freeLayout && !(event.target as HTMLElement).closest('button, a, input, select, textarea')) openDetail() }}>
        <div className="agent-identity">
          {freeLayout && <button className='free-window-move' type='button' aria-label={`移动 ${session.displayName}`} title='拖动移动窗口；方向键微调，Shift 加速' onPointerDown={event => freeLayout.start('move', event)} onKeyDown={event => freeLayout.keyAdjust('move', event)} onClick={event => event.stopPropagation()}>⠿</button>}
          <AgentLogo kind={session.agentKind} className={'agent-dot agent-' + session.agentKind} />
          <div><h2>{session.displayName}</h2><div className="terminal-session-meta">
            <button type="button" className="workspace-path-link" title={`打开工作区文件夹：${session.workspace}`} aria-label={`打开工作区：${session.workspace}`} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.openSessionWorkspace(session.sessionId)) }}>{session.workspace}</button>
            {session.nativeSessionId && <button type="button" className="native-session-id" title={`原生会话 ID：${session.nativeSessionId}（点击复制）`} aria-label="复制原生会话 ID" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.writeClipboardText(session.nativeSessionId!)) }}>ID: {session.nativeSessionId}</button>}
          </div></div>
        </div>
        <div className="terminal-actions">
          <span title={session.activityError ?? session.lastError} className={'status-badge status-' + sessionDisplayStatus(session)}>{session.status === 'starting' ? '正在启动' : SESSION_STATUS_LABEL[sessionDisplayStatus(session)]}</span>
          {!terminalEnded && !deepSeekWeb && onFullAuto && <button className={'full-auto-tile-button' + (approvalModeOf(session) !== 'manual' ? ' active' : '')} type="button" title="随时切换审批模式" aria-label={'审批模式：' + APPROVAL_MODE_LABEL[approvalModeOf(session)]} onClick={(event) => { event.stopPropagation(); onFullAuto() }}>{APPROVAL_MODE_LABEL[approvalModeOf(session)]}</button>}
          <button className="button-ghost workspace-folder-button" type="button" title="打开工作区文件夹" aria-label={`打开 ${session.displayName} 的工作区文件夹`} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.openSessionWorkspace(session.sessionId)) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v2M3 7v12a1 1 0 0 0 1 1h15l3-10H7L4 20" /></svg></button>
          {onEdit && <button className="button-ghost" type="button" title="编辑 Agent" onClick={(event) => { event.stopPropagation(); onEdit() }} aria-label={`编辑 ${session.displayName}`}>✎</button>}
          {onContinuation && (session.agentKind === 'codex' || session.agentKind === 'claude') && <button className="button-ghost" type="button" disabled={!session.nativeSessionId} title={session.nativeSessionId ? '新窗口清洗续写，继承配置' : '等待原生会话 ID 后可续写'} aria-label={`新窗口续写 ${session.displayName}`} onClick={event => { event.stopPropagation(); onContinuation() }}>↗</button>}
          {!detail && !embedded && !terminalEnded && <button className="button-ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen?.() }} aria-label={`查看 ${session.displayName}`}>⛶</button>}
          {terminalEnded ? <>
            <button className="button-secondary button-compact" type="button" disabled={Boolean(actionBusy)} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.restartSession(session.sessionId), 'restart') }}>{actionBusy === 'restart' ? '请稍后…' : '重新启动'}</button>
            <button className="button-danger" type="button" disabled={Boolean(actionBusy)} onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.removeSession(session.sessionId), 'remove') }}>{actionBusy === 'remove' ? '请稍后…' : '删除'}</button>
          </> : <button className="button-danger" type="button" aria-label="停止" title="停止" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.stopSession(session.sessionId)) }}>■</button>}
        </div>
      </header>
      {onBinding && (terminalEnded || session.status === 'needs_attention') && ['codex', 'claude'].includes(session.agentKind) && <div className='session-binding-actions' onClick={event => event.stopPropagation()}>
        <button type='button' className='button-secondary mini-button' onClick={() => onBinding('history')}>切换历史会话</button>
        <button type='button' className='button-secondary mini-button' onClick={() => onBinding('fresh')}>按原配置开启新会话</button>
      </div>}
      {terminalEnded ? <div className="terminal-ended" onClick={(event) => event.stopPropagation()}>
        <div className="terminal-ended-icon">›_</div>
        <strong>{session.status === 'completed' ? 'Agent 已正常完成' : session.status === 'stopped' ? 'Agent 已停止' : 'Agent 运行失败'}</strong>
        <span className={actionError ? 'terminal-ended-error' : undefined}>{actionError || (session.status === 'failed' && session.lastError ? session.lastError : '终端进程已经关闭，可重新启动或从总览删除。')}</span>
        {deepSeekWeb && <DeepSeekStartupOutput key={session.sessionId} sessionId={session.sessionId} />}
      </div> : deepSeekWeb ? <div className='terminal-surface deepseek-web-surface' onClick={(event) => event.stopPropagation()}>
        <div className='deepseek-service-overview'>
            <AgentLogo kind='deepseek' className='deepseek-service-logo' />
            <div><strong>{deepSeekWebUrl ? 'DeepSeek Harness Web 已就绪' : '正在启动 DeepSeek Harness Web'}</strong><span style={{ overflowWrap: 'anywhere' }}>{deepSeekWebUrl ?? 'Manager 正在等待官方服务地址…'}</span></div>
            <span>在独立窗口打开官方界面，兼容 Web 登录认证。</span>
            <button type='button' className='button-secondary button-compact' disabled={!deepSeekWebUrl} onClick={() => runAction(() => window.agentManager.openDeepSeekWeb(session.sessionId))}>打开完整界面</button>
            <button type='button' className='button-secondary button-compact' disabled={!deepSeekWebUrl} onClick={() => { if (deepSeekWebUrl) runAction(() => window.agentManager.openExternalWeb(deepSeekWebUrl)) }}>浏览器打开</button>
            <button type='button' className='button-secondary button-compact' disabled={!deepSeekWebUrl} onClick={() => { if (deepSeekWebUrl) runAction(() => window.agentManager.writeClipboardText(deepSeekWebUrl)) }}>复制完整地址</button>
            {deepSeekWebUrl && <span>地址包含访问凭据，请勿公开分享。</span>}
            {actionError && <span role='alert'>{actionError}</span>}
            <DeepSeekStartupOutput key={session.sessionId} sessionId={session.sessionId} />
          </div>
      </div> : <div
        className="terminal-surface"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="terminal-live-host" ref={hostRef} />
      </div>}
      {!terminalEnded && <div className="terminal-status-slot">
        {actionError && session.status !== 'needs_approval' && session.status !== 'needs_attention' ? <div className="tile-error">{actionError}</div>
          : session.status === 'needs_approval' ? <div className="inline-request"><span title={approval?.llmReview?.summary ?? session.pendingApprovalCommand ?? session.approvalInputSummary ?? session.approvalToolName ?? '授权详情待确认'}>{approvalModeOf(session) === 'manual' || approval?.llmReviewStatus ? approvalReviewLabel(approval) : '自动审批处理中'} · {(session.pendingApprovalCount ?? 1) > 1 ? `${session.pendingApprovalCount} 笔 · ` : ''}{session.pendingApprovalCommand ?? session.approvalInputSummary ?? session.approvalToolName ?? '详情待确认'}</span>{approvalModeOf(session) === 'manual' && <button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.approveSession(session.sessionId)) }}>批准</button>}</div>
            : session.status === 'needs_attention' ? <div className="inline-request attention-request"><span title={session.lastError}>{session.attentionKind === 'host-unresponsive' ? 'Agent 窗口疑似卡死，是否重启？' : '检测到异常：' + (session.lastError ?? '原因未知')}</span><button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.dismissRecoverySuggestion(session.sessionId)) }}>{session.attentionKind === 'host-unresponsive' ? '暂不重启' : '忽略'}</button>{session.attentionKind !== 'host-unresponsive' && <button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.acceptRecoverySuggestion(session.sessionId)) }}>采纳</button>}<button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.tryRecoveryOnce(session.sessionId)) }}>{session.attentionKind === 'host-unresponsive' ? '重启 Agent' : '尝试一次'}</button></div>
              : session.status === 'recovering' ? <div className="recovery-bar"><span>↻</span><span>请稍后…</span></div>
                : session.approvalSuggestion ? <div className="approval-suggestion"><span className="approval-suggestion-summary" tabIndex={0} data-tooltip={`已手动批准 ${session.approvalSuggestion.approvalCount} 次\n命令：${session.approvalSuggestion.command}\n加入后，相同命令将按安全规则自动批准。`}>已手动批准 {session.approvalSuggestion.approvalCount} 次 · {session.approvalSuggestion.command}</span><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.acceptApprovalSuggestion(session.sessionId) }}>加入</button><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.dismissApprovalSuggestion(session.sessionId) }}>暂不</button></div>
                  : null}
      </div>}
      {freeLayout && (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeEdge[]).map(edge => <button key={edge} type='button' className={'free-window-resize free-window-resize-' + edge} data-resize-edge={edge}
        aria-label={`调整 ${session.displayName} 的${({ n: '上边', ne: '右上角', e: '右边', se: '右下角', s: '下边', sw: '左下角', w: '左边', nw: '左上角' })[edge]}`}
        title='拖动调整窗口宽高；方向键微调，Shift 加速' onPointerDown={event => freeLayout.start(edge, event)} onKeyDown={event => freeLayout.keyAdjust(edge, event)} onClick={event => event.stopPropagation()} />)}
    </article>
  )
}
