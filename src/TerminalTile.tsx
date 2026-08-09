import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'

import type { SessionSummary } from './shared/manager-api'

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  starting: '启动中', running: '运行中', needs_approval: '待授权', recovering: '请稍后…',
  completed: '已完成', stopped: '已停止', failed: '失败', unknown: '未知',
}

interface TerminalTileProps {
  session: SessionSummary
  detail?: boolean
  onOpen?: () => void
}

export default function TerminalTile({ session, detail = false, onOpen }: TerminalTileProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: detail ? 14 : 12,
      theme: { background: '#090d18', foreground: '#d8e1f5', cursor: '#7c98ff', selectionBackground: '#334269' },
    })
    terminal.open(host)
    const input = terminal.onData((data) => { void window.agentManager.write(session.sessionId, data) })
    const unsubscribe = window.agentManager.subscribe((event) => {
      if (event.sessionId === session.sessionId && event.type === 'output') terminal.write(event.data)
    })
    const resize = (): void => {
      const cols = Math.max(20, Math.min(500, Math.floor((host.clientWidth || 640) / 8.2)))
      const rows = Math.max(5, Math.min(200, Math.floor((host.clientHeight || 260) / 18)))
      void window.agentManager.resize(session.sessionId, cols, rows)
    }
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    observer?.observe(host)
    return () => { observer?.disconnect(); unsubscribe(); input.dispose(); terminal.dispose() }
  }, [detail, session.sessionId])

  return (
    <article className={`terminal-card${detail ? ' terminal-card-detail' : ''}`} data-testid={`terminal-tile-${session.sessionId}`}>
      <header className="terminal-card-header">
        <div className="agent-identity">
          <span className={`agent-dot agent-${session.agentKind}`} />
          <div><h2>{session.displayName}</h2><p title={session.workspace}>{session.workspace}</p></div>
        </div>
        <div className="terminal-actions">
          <span className={`status-badge status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
          {!detail && <button className="button-ghost" type="button" onClick={onOpen} aria-label={`查看 ${session.displayName}`}>放大</button>}
          <button className="button-danger" type="button" onClick={() => { void window.agentManager.stopSession(session.sessionId) }}>停止</button>
        </div>
      </header>
      <div className="terminal-surface" ref={hostRef} />
      {session.status === 'recovering' && <div className="recovery-cover">请稍后…</div>}
    </article>
  )
}
