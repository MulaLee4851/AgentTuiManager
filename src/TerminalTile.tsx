import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'

import type { SessionSummary, TerminalHistorySnapshot } from './shared/manager-api'

const STABLE_TERMINAL_COLS = 100
const STABLE_TERMINAL_ROWS = 30

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  starting: '启动中', running: '运行中', needs_approval: '待授权', recovering: '请稍后…',
  needs_attention: '需要处理',
  completed: '已完成', stopped: '已停止', failed: '失败', unknown: '未知',
}

interface TerminalTileProps {
  session: SessionSummary
  detail?: boolean
  hidden?: boolean
  onOpen?: () => void
}

export default function TerminalTile({ session, detail = false, hidden = false, onOpen }: TerminalTileProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [actionError, setActionError] = useState('')
  const [terminalHistory, setTerminalHistory] = useState<TerminalHistorySnapshot>({ entries: [], truncated: false })
  const terminalEnded = session.status === 'completed' || session.status === 'stopped' || session.status === 'failed'

  useEffect(() => {
    if (terminalEnded) return
    const host = hostRef.current
    const scroll = scrollRef.current
    if (!host || !scroll) return
    const terminal = new Terminal({
      cols: STABLE_TERMINAL_COLS,
      rows: STABLE_TERMINAL_ROWS,
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      scrollback: 1_500,
      theme: { background: '#0b1011', foreground: '#cbd9d7', cursor: '#b9d2cc', selectionBackground: '#315d4e' },
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
    let historyRequest = 0
    let lastHistoryRefreshAt = 0
    const scrollIsAtBottom = (): boolean => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4
    let pinFrames: number[] = []
    const scrollToLiveTerminal = (): void => {
      for (const frame of pinFrames) cancelAnimationFrame(frame)
      pinFrames = []
      const pin = (remaining: number): void => {
        scroll.scrollTop = scroll.scrollHeight
        if (remaining > 0) pinFrames.push(requestAnimationFrame(() => pin(remaining - 1)))
      }
      pin(3)
    }
    const refreshHistory = (force = false): void => {
      const now = performance.now()
      if (!force && now - lastHistoryRefreshAt < 2_000) return
      lastHistoryRefreshAt = now
      const request = ++historyRequest
      const wasAtBottom = scrollIsAtBottom()
      void window.agentManager.terminalHistory(session.sessionId).then((history) => {
        if (request !== historyRequest) return
        setTerminalHistory(history)
        requestAnimationFrame(() => {
          if (request === historyRequest && wasAtBottom) scrollToLiveTerminal()
        })
      }).catch(() => undefined)
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
        if (synchronizedResizeRedraw) {
          if (resizeWasAtBottom) terminal.scrollToBottom()
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
        if (!disposed) setActionError(reason instanceof Error ? reason.message : String(reason))
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
      terminal.scrollToBottom()
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
      queueTerminalInput(data, /[\r\n\x03\x1b]/.test(data))
    })
    terminal.attachCustomWheelEventHandler((event) => {
      if (event.deltaY === 0) return true
      if (event.deltaY < 0) refreshHistory()
      if (scroll.scrollHeight > scroll.clientHeight + 1) {
        scroll.scrollTop += event.deltaY
        return false
      }
      const buffer = terminal.buffer.active
      if (buffer.type === 'normal' && buffer.baseY > 0) {
        const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / 36))
        terminal.scrollLines((event.deltaY < 0 ? -1 : 1) * lines)
        return false
      }
      return true
    })
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
    refreshHistory(true)
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
    const resizeFontOnly = (): void => {
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return
      const wasAtBottom = scrollIsAtBottom()
      const availableWidth = Math.max(1, host.clientWidth - 20)
      const availableHeight = Math.max(1, host.clientHeight - 16)
      const fitByWidth = availableWidth / (STABLE_TERMINAL_COLS * .62)
      const fitByHeight = availableHeight / (STABLE_TERMINAL_ROWS * 1.25)
      const fontSize = Math.max(8, Math.min(18, Math.floor(Math.min(fitByWidth, fitByHeight))))
      scroll.style.setProperty('--terminal-font-size', `${fontSize}px`)
      if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize
      if (wasAtBottom) scrollToLiveTerminal()
    }
    const scheduleResize = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resizeFontOnly)
    }
    scheduleResize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleResize)
    observer?.observe(host)
    observer?.observe(scroll)
    return () => {
      disposed = true
      pendingTerminalInput = ''
      if (inputFrame) cancelAnimationFrame(inputFrame)
      cancelAnimationFrame(resizeFrame)
      cancelAnimationFrame(outputFrame)
      for (const frame of pinFrames) cancelAnimationFrame(frame)
      if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
      if (resizeCoverFailsafeTimer) clearTimeout(resizeCoverFailsafeTimer)
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
      historyRequest += 1
      resizeCover?.remove()
      pendingOutput = ''
      outputBeforeReplay = []
      observer?.disconnect()
      unsubscribe()
      input.dispose()
      host.removeEventListener('contextmenu', copySelection)
      host.removeEventListener('paste', pastePlainText, true)
      copyButton.removeEventListener('mousedown', preserveSelection)
      copyButton.removeEventListener('click', clickCopy)
      copyButton.remove()
      terminal.dispose()
    }
  }, [session.sessionId, terminalEnded])

  useEffect(() => {
    if (terminalEnded) return
    const scroll = scrollRef.current
    if (!scroll) return
    const frames: number[] = []
    const pin = (remaining: number): void => {
      scroll.scrollTop = scroll.scrollHeight
      if (remaining > 0) frames.push(requestAnimationFrame(() => pin(remaining - 1)))
    }
    frames.push(requestAnimationFrame(() => pin(3)))
    return () => { for (const frame of frames) cancelAnimationFrame(frame) }
  }, [detail, terminalEnded])

  const openDetail = (): void => { if (!detail && !terminalEnded) onOpen?.() }
  const runAction = (action: () => Promise<void> | void): void => {
    setActionError('')
    void Promise.resolve(action()).catch((reason) => setActionError(reason instanceof Error ? reason.message : String(reason)))
  }

  return (
    <article
      className={`terminal-card${detail ? ' terminal-card-detail' : ''}${hidden ? ' terminal-card-hidden' : ''}`}
      data-testid={`terminal-tile-${session.sessionId}`}
      onClick={openDetail}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !detail) openDetail() }}
      tabIndex={detail || hidden || terminalEnded ? -1 : 0}
      aria-hidden={hidden || undefined}
    >
      <header className="terminal-card-header">
        <div className="agent-identity">
          <span className={`agent-dot agent-${session.agentKind}`}>{session.agentKind === 'claude' ? 'CL' : session.agentKind === 'pi' ? 'Pi' : session.agentKind === 'generic' ? '›_' : 'C'}</span>
          <div><h2>{session.displayName}</h2><p title={session.workspace}>{session.workspace}</p></div>
        </div>
        <div className="terminal-actions">
          <span className={`status-badge status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
          {!detail && !terminalEnded && <button className="button-ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen?.() }} aria-label={`查看 ${session.displayName}`}>⛶</button>}
          {terminalEnded ? <>
            <button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.restartSession(session.sessionId)) }}>重新启动</button>
            <button className="button-danger" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.removeSession(session.sessionId)) }}>删除</button>
          </> : <button className="button-danger" type="button" aria-label="停止" title="停止" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.stopSession(session.sessionId)) }}>■</button>}
        </div>
      </header>
      {terminalEnded ? <div className="terminal-ended" onClick={(event) => event.stopPropagation()}>
        <div className="terminal-ended-icon">›_</div>
        <strong>{session.status === 'completed' ? 'Agent 已正常完成' : session.status === 'stopped' ? 'Agent 已停止' : 'Agent 运行失败'}</strong>
        <span>{session.status === 'failed' && session.lastError ? session.lastError : '终端进程已经关闭，可重新启动或从总览删除。'}</span>
      </div> : <div
        className="terminal-surface"
        ref={scrollRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {terminalHistory.entries.length > 0 && <section className="terminal-native-history" aria-label="原生会话历史">
          {terminalHistory.truncated && <div className="terminal-history-truncated">更早的会话内容已折叠</div>}
          {terminalHistory.entries.map((entry, index) => (
            <article className={`terminal-history-entry terminal-history-${entry.role}`} key={`${entry.role}-${index}`}>
              <div className="terminal-history-title">{entry.title}</div>
              {entry.text && <pre className="terminal-history-content">{entry.text}</pre>}
            </article>
          ))}
        </section>}
        <div className="terminal-live-host" ref={hostRef} />
      </div>}
      {!terminalEnded && <div className="terminal-status-slot">
        {actionError && session.status !== 'needs_approval' && session.status !== 'needs_attention' ? <div className="tile-error">{actionError}</div>
          : session.status === 'needs_approval' ? <div className="inline-request"><span>Agent 正在等待本次授权</span><button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.approveSession(session.sessionId) }}>批准</button></div>
            : session.status === 'needs_attention' ? <div className="inline-request attention-request"><span title={session.lastError}>检测到异常：{session.lastError ?? '原因未知'}</span><button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.dismissRecoverySuggestion(session.sessionId)) }}>忽略</button><button className="button-secondary button-compact" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.acceptRecoverySuggestion(session.sessionId)) }}>采纳</button><button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); runAction(() => window.agentManager.tryRecoveryOnce(session.sessionId)) }}>尝试一次</button></div>
              : session.status === 'recovering' ? <div className="recovery-bar"><span>↻</span><span>请稍后…</span></div>
                : session.approvalSuggestion ? <div className="approval-suggestion"><span title={session.approvalSuggestion.command}>已手动批准 {session.approvalSuggestion.approvalCount} 次，加入自动批准？</span><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.acceptApprovalSuggestion(session.sessionId) }}>加入</button><button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.dismissApprovalSuggestion(session.sessionId) }}>暂不</button></div>
                  : null}
      </div>}
    </article>
  )
}
