import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

import TerminalTile from './TerminalTile'
import type { AgentKind, StartSessionRequest, SessionSummary } from './shared/manager-api'

function NewAgentForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const [displayName, setDisplayName] = useState('新 Agent')
  const [workspace, setWorkspace] = useState('')
  const [executable, setExecutable] = useState('codex')
  const [args, setArgs] = useState('')
  const [nativeSessionId, setNativeSessionId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changeKind = (kind: AgentKind): void => {
    setAgentKind(kind)
    if (kind !== 'generic') setExecutable(kind)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    const parsedArgs = args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    const request: StartSessionRequest = {
      displayName, agentKind, workspace, executable, args: parsedArgs, cols: 100, rows: 30,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    }
    if (nativeSessionId && agentKind === 'codex') request.recovery = { executable: 'codex', args: ['resume', nativeSessionId] }
    if (nativeSessionId && agentKind === 'claude') request.recovery = { executable: 'claude', args: ['--resume', nativeSessionId] }
    try { await window.agentManager.startSession(request); onCreated() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="agent-form" onSubmit={(event) => { void submit(event) }}>
        <header><div><span className="eyebrow">SESSION</span><h2>新增 Agent</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
        <label>Agent 类型<select value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="pi">Pi</option><option value="generic">通用终端</option></select></label>
        <label>名称<input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>工作区<input required placeholder="B:\\projects\\my-app" value={workspace} onChange={(event) => setWorkspace(event.target.value)} /></label>
        <label>Executable<input required value={executable} onChange={(event) => setExecutable(event.target.value)} /></label>
        <label>参数（每行一个）<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label>
        <label>原生会话 ID（可选）<input value={nativeSessionId} onChange={(event) => setNativeSessionId(event.target.value)} /><small>Codex / Claude 填写后，异常退出才会安全 resume。</small></label>
        {error && <p className="form-error">{error}</p>}
        <footer><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={busy}>{busy ? '请稍后…' : '启动 Agent'}</button></footer>
      </form>
    </div>
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showForm, setShowForm] = useState(false)
  const reload = useCallback(async () => setSessions(await window.agentManager.listSessions()), [])

  useEffect(() => {
    void reload()
    return window.agentManager.subscribe((event) => { if (event.type === 'sessions-changed') void reload() })
  }, [reload])

  const selected = sessions.find((session) => session.sessionId === selectedId)
  const runningCount = useMemo(() => sessions.filter((session) => ['starting', 'running', 'recovering'].includes(session.status)).length, [sessions])
  const pendingCount = useMemo(() => sessions.filter((session) => session.status === 'needs_approval').length, [sessions])

  if (selected) {
    return <main className="app-shell detail-shell"><div className="detail-toolbar"><button type="button" className="button-secondary" onClick={() => setSelectedId(undefined)} aria-label="返回总览">← 返回总览</button><span>{selected.agentKind.toUpperCase()} · 终端详情</span></div><TerminalTile session={selected} detail /></main>
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><span className="eyebrow">WORKSPACE CONTROL</span><h1>Agent 总览</h1><p>在一个窗口里掌控所有终端会话</p></div>
        <div className="topbar-actions"><div className="metric"><strong>{runningCount}</strong><span>运行中</span></div><div className="metric pending"><strong>{pendingCount}</strong><span>待处理</span></div><button className="button-primary" type="button" onClick={() => setShowForm(true)}>＋ 新增 Agent</button></div>
      </header>
      {sessions.length === 0 ? <section className="empty-state"><div className="empty-icon">›_</div><h2>还没有受管 Agent</h2><p>选择工作区并启动你的第一个终端 Agent。</p><button className="button-primary" type="button" onClick={() => setShowForm(true)}>新增 Agent</button></section> : <section className="terminal-grid">{sessions.map((session) => <TerminalTile key={session.sessionId} session={session} onOpen={() => setSelectedId(session.sessionId)} />)}</section>}
      {showForm && <NewAgentForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); void reload() }} />}
    </main>
  )
}
