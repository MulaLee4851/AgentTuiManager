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
  hidden?: boolean
  onOpen?: () => void
}

export default function TerminalTile({ session, detail = false, hidden = false, onOpen }: TerminalTileProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
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
  }, [session.sessionId])

  const openDetail = (): void => { if (!detail) onOpen?.() }

  return (
    <article
      className={`terminal-card${detail ? ' terminal-card-detail' : ''}${hidden ? ' terminal-card-hidden' : ''}`}
      data-testid={`terminal-tile-${session.sessionId}`}
      onClick={openDetail}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !detail) openDetail() }}
      tabIndex={detail || hidden ? -1 : 0}
      aria-hidden={hidden || undefined}
    >
      <header className="terminal-card-header">
        <div className="agent-identity">
          <span className={`agent-dot agent-${session.agentKind}`} />
          <div><h2>{session.displayName}</h2><p title={session.workspace}>{session.workspace}</p></div>
        </div>
        <div className="terminal-actions">
          <span className={`status-badge status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
          {session.status === 'needs_approval' && <button className="button-approve" type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.approveSession(session.sessionId) }}>批准</button>}
          {!detail && <button className="button-ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen?.() }} aria-label={`查看 ${session.displayName}`}>放大</button>}
          <button className="button-danger" type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.stopSession(session.sessionId) }}>停止</button>
        </div>
      </header>
      {session.approvalSuggestion && <div className="approval-suggestion">
        <span title={session.approvalSuggestion.command}>已手动批准 {session.approvalSuggestion.approvalCount} 次，加入自动批准？</span>
        <button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.acceptApprovalSuggestion(session.sessionId) }}>加入</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); void window.agentManager.dismissApprovalSuggestion(session.sessionId) }}>暂不</button>
      </div>}
      <div className="terminal-surface" ref={hostRef} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} />
      {session.status === 'recovering' && <div className="recovery-cover">请稍后…</div>}
    </article>
  )
}
