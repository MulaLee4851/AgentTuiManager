import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TerminalTile from './TerminalTile'
import type { AgentKind, NativeSessionSummary, StartSessionRequest, SessionSummary } from './shared/manager-api'

function NewAgentForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const [displayName, setDisplayName] = useState('新 Agent')
  const [workspace, setWorkspace] = useState('')
  const [executable, setExecutable] = useState('codex')
  const [args, setArgs] = useState('')
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummary[]>([])
  const [nativeSessionId, setNativeSessionId] = useState('')
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>('idle')
  const [discoveryError, setDiscoveryError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const discoveryVersion = useRef(0)

  const loadNativeSessions = async (kind: AgentKind, selectedWorkspace: string): Promise<void> => {
    const version = ++discoveryVersion.current
    setNativeSessionId('')
    setNativeSessions([])
    setDiscoveryError('')
    if (kind === 'pi' || kind === 'generic') {
      setDiscoveryState('unsupported')
      return
    }
    setDiscoveryState('loading')
    try {
      const discovered = await window.agentManager.discoverSessions(kind, selectedWorkspace)
      if (version !== discoveryVersion.current) return
      setNativeSessions(discovered)
      setDiscoveryState('ready')
    } catch (reason) {
      if (version !== discoveryVersion.current) return
      setDiscoveryError(reason instanceof Error ? reason.message : String(reason))
      setDiscoveryState('error')
    }
  }

  const changeKind = (kind: AgentKind): void => {
    setAgentKind(kind)
    setExecutable(kind === 'generic' ? 'cmd.exe' : kind)
    if (workspace) void loadNativeSessions(kind, workspace)
  }

  const chooseWorkspace = async (): Promise<void> => {
    setError('')
    try {
      const selected = await window.agentManager.chooseWorkspace()
      if (selected) {
        setWorkspace(selected)
        await loadNativeSessions(agentKind, selected)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    const parsedArgs = args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    const resumeArgs = nativeSessionId
      ? agentKind === 'codex' ? ['resume', nativeSessionId] : agentKind === 'claude' ? ['--resume', nativeSessionId] : undefined
      : undefined
    const request: StartSessionRequest = {
      displayName, agentKind, workspace, executable, args: resumeArgs ?? parsedArgs, cols: 100, rows: 30,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    }
    if (resumeArgs) request.recovery = { executable, args: resumeArgs }
    try { await window.agentManager.startSession(request); onCreated() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="agent-form" onSubmit={(event) => { void submit(event) }}>
        <header><div><span className="eyebrow">SESSION</span><h2>新增 Agent</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
        <label>Agent 类型<select value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="pi">Pi</option><option value="generic">通用终端</option></select></label>
        <label>名称<input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <div className="form-field"><label htmlFor="workspace">工作区</label><div className="workspace-picker"><input id="workspace" required readOnly placeholder="请选择工作区" value={workspace} /><button type="button" className="button-secondary" disabled={busy} onClick={() => { void chooseWorkspace() }}>选择文件夹</button></div></div>
        <div className="form-field history-field"><label htmlFor="native-session">历史会话</label>
          {discoveryState === 'loading' && <p className="field-note">正在读取历史会话…</p>}
          {discoveryState === 'unsupported' && <p className="field-note">该 Agent 暂不支持自动读取历史会话</p>}
          {discoveryState === 'error' && <p className="field-error">读取失败：{discoveryError}，仍可新建会话。</p>}
          <select id="native-session" value={nativeSessionId} disabled={!workspace || discoveryState === 'loading' || discoveryState === 'unsupported'} onChange={(event) => setNativeSessionId(event.target.value)}>
            <option value="">新建会话</option>
            {nativeSessions.map((nativeSession) => <option key={nativeSession.id} value={nativeSession.id}>{nativeSession.title} · {new Date(nativeSession.updatedAt).toLocaleString()}</option>)}
          </select>
        </div>
        <details className="advanced-settings"><summary>高级设置</summary><div>
          <label>Executable<input required value={executable} onChange={(event) => setExecutable(event.target.value)} /></label>
          <label>参数（每行一个）<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label>
        </div></details>
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

  return (
    <main className={`app-shell${selected ? ' detail-shell' : ''}`}>
      {selected ? <div className="detail-toolbar"><button type="button" className="button-secondary" onClick={() => setSelectedId(undefined)} aria-label="返回总览">← 返回总览</button><span>{selected.agentKind.toUpperCase()} · 终端详情</span></div> : <header className="topbar">
        <div><span className="eyebrow">WORKSPACE CONTROL</span><h1>Agent 总览</h1><p>在一个窗口里掌控所有终端会话</p></div>
        <div className="topbar-actions"><div className="metric"><strong>{runningCount}</strong><span>运行中</span></div><div className="metric pending"><strong>{pendingCount}</strong><span>待处理</span></div><button className="button-primary" type="button" onClick={() => setShowForm(true)}>＋ 新增 Agent</button></div>
      </header>}
      {sessions.length === 0 ? <section className="empty-state"><div className="empty-icon">›_</div><h2>还没有受管 Agent</h2><p>选择工作区并启动你的第一个终端 Agent。</p><button className="button-primary" type="button" onClick={() => setShowForm(true)}>新增 Agent</button></section> : <section className={`terminal-grid${selected ? ' terminal-grid-detail' : ''}`}>{sessions.map((session) => <TerminalTile key={session.sessionId} session={session} detail={selected?.sessionId === session.sessionId} hidden={selected !== undefined && selected.sessionId !== session.sessionId} onOpen={() => setSelectedId(session.sessionId)} />)}</section>}
      {showForm && <NewAgentForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); void reload() }} />}
    </main>
  )
}
