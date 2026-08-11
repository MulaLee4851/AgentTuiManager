import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TerminalTile from './TerminalTile'
import ApprovalRulesDialog from './ApprovalRulesDialog'
import AuditPage from './AuditPage'
import AttentionCenter from './AttentionCenter'
import type { AgentKind, NativeSessionSummary, StartSessionRequest, SessionSummary } from './shared/manager-api'

function workspaceKey(value: string): string {
  return value.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

function NewAgentForm({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: string) => void }): JSX.Element {
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const [displayName, setDisplayName] = useState('新 Agent')
  const [workspace, setWorkspace] = useState('')
  const [executable, setExecutable] = useState('codex')
  const [args, setArgs] = useState('')
  const [maxContinueRetries, setMaxContinueRetries] = useState(3)
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummary[]>([])
  const [nativeSessionId, setNativeSessionId] = useState('')
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>('idle')
  const [discoveryError, setDiscoveryError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [launcherTab, setLauncherTab] = useState<'new' | 'history' | 'external'>('new')
  const [historyQuery, setHistoryQuery] = useState('')
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
      maxContinueRetries,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    }
    if (resumeArgs) request.recovery = { executable, args: resumeArgs }
    try { await window.agentManager.startSession(request); onCreated(workspace) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  const filteredSessions = nativeSessions.filter((nativeSession) => {
    const query = historyQuery.trim().toLocaleLowerCase('zh-CN')
    return !query || nativeSession.title.toLocaleLowerCase('zh-CN').includes(query)
      || nativeSession.id.toLocaleLowerCase('en-US').includes(query)
      || Boolean(nativeSession.subtitle?.toLocaleLowerCase('zh-CN').includes(query))
  })
  const agentOptions: Array<{ kind: AgentKind; logo: string; title: string; subtitle: string }> = [
    { kind: 'codex', logo: 'C', title: 'Codex', subtitle: '深度适配 · 已安装' },
    { kind: 'claude', logo: 'CL', title: 'Claude Code', subtitle: '深度适配 · 已安装' },
    { kind: 'pi', logo: 'Pi', title: 'Pi', subtitle: '基础终端' },
    { kind: 'generic', logo: '+', title: '自定义命令', subtitle: '配置任意 CLI Agent' },
  ]

  return <div className='launcher-scrim' role='presentation'>
    <form className='agent-launcher' onSubmit={(event) => { void submit(event) }}>
      <header className='launcher-head'><h1>添加 Agent</h1><button type='button' className='icon-button' onClick={onClose} aria-label='关闭'>×</button></header>
      <div className='launcher-workspace-row'><label htmlFor='workspace'>工作区</label><div className='workspace-picker'><input id='workspace' className='launcher-field' required readOnly placeholder='请选择工作区' value={workspace} /><button type='button' className='button-secondary' disabled={busy} onClick={() => { void chooseWorkspace() }}>选择文件夹</button></div></div>
      <div className='launcher-content'>
        <nav className='launcher-tabs' aria-label='会话方式'><button type='button' className={`launcher-tab${launcherTab === 'new' ? ' active' : ''}`} onClick={() => { setLauncherTab('new'); setNativeSessionId('') }}>新会话</button><button type='button' className={`launcher-tab${launcherTab === 'history' ? ' active' : ''}`} onClick={() => setLauncherTab('history')}>恢复历史</button><button type='button' className={`launcher-tab${launcherTab === 'external' ? ' active' : ''}`} onClick={() => setLauncherTab('external')}>迁移外部会话</button></nav>
        <label className='sr-only' htmlFor='agent-kind'>Agent 类型</label><select className='sr-only' id='agent-kind' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select>
        <label className='sr-only' htmlFor='native-session'>历史会话</label><select className='sr-only' id='native-session' value={nativeSessionId} disabled={!workspace || discoveryState === 'loading' || discoveryState === 'unsupported'} onChange={(event) => setNativeSessionId(event.target.value)}><option value=''>新建会话</option>{nativeSessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select>
        {launcherTab === 'new' && <section className='launcher-panel'><div className='launcher-section-title'><h2>选择 Agent</h2><span>选择本机 CLI</span></div><div className='launcher-agent-options'>{agentOptions.map((option) => <button type='button' key={option.kind} className={`launcher-agent-option${agentKind === option.kind ? ' active' : ''}`} onClick={() => changeKind(option.kind)}><span className={`launcher-option-logo option-${option.kind}`}>{option.logo}</span><span><strong>{option.title}</strong><span>{option.subtitle}</span></span></button>)}</div>
           {discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}
           {discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}
          <div className='launcher-form-grid'><label htmlFor='session-name'>显示名称</label><input id='session-name' className='launcher-field' required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><label htmlFor='approval-mode'>审批策略</label><select id='approval-mode' className='launcher-field' defaultValue='workspace'><option value='workspace'>使用工作区默认策略</option><option value='manual'>全部手动确认</option><option value='builtin'>仅使用内置安全规则</option></select></div><div className='launcher-command-preview'>{executable || '<custom-command>'}<small>cwd: {workspace || '请选择工作区'}</small></div>
          <details className='advanced-settings'><summary>高级设置</summary><div><label>Executable<input required value={executable} onChange={(event) => setExecutable(event.target.value)} /></label><label>参数（每行一个）<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label><label>自动 continue 最大次数<input type='number' min={1} max={10} required value={maxContinueRetries} onChange={(event) => setMaxContinueRetries(Number(event.target.value))} /></label><small>遇到明确的临时错误时，每隔 3 秒重试一次。正常结束或手动中断不会重试。</small></div></details></section>}
        {launcherTab === 'history' && <section className='launcher-panel'><div className='launcher-filter-row'><input className='launcher-field' value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder='搜索标题或会话 ID' /><select className='launcher-field' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select></div><div className='launcher-section-title'><h2>该工作区的历史会话</h2><span>按最近活动排序</span></div>
          {discoveryState === 'loading' && <p className='launcher-state'>正在读取历史会话…</p>}{discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}{discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}{discoveryState === 'ready' && filteredSessions.length === 0 && <p className='launcher-state'>该工作区没有可恢复的历史会话</p>}<div className='launcher-session-list'>{filteredSessions.map((item) => <button type='button' key={item.id} className={`launcher-session-item${nativeSessionId === item.id ? ' active' : ''}`} onClick={() => setNativeSessionId(item.id)}><span className={`launcher-option-logo option-${agentKind}`}>{agentKind === 'claude' ? 'CL' : agentKind === 'pi' ? 'Pi' : 'C'}</span><span><strong>{item.title}</strong><span>{item.subtitle || item.id}</span><small>{agentKind === 'claude' ? 'Claude Code' : agentKind.toUpperCase()} · {item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}</div></section>}
        {launcherTab === 'external' && <section className='launcher-panel'><div className='launcher-external-note'>迁移会在原终端正常停止后，通过 Agent 自带的历史恢复能力在本应用重新打开；不会复制终端画面或改变原生会话数据。</div><div className='launcher-section-title'><h2>检测到的外部 Agent</h2><span>当前没有可迁移进程</span></div></section>}
      </div>
      {error && <p className='launcher-error'>{error}</p>}
      <footer className='launcher-foot'><span>{launcherTab === 'history' || nativeSessionId ? '将在新终端中恢复选中的历史会话' : launcherTab === 'external' ? '迁移不会中断或接管外部终端' : `将启动新的 ${agentOptions.find((option) => option.kind === agentKind)?.title ?? 'Agent'} 会话`}</span><button type='button' className='button-secondary' onClick={onClose}>取消</button>{launcherTab !== 'external' && <button type='submit' className='button-primary' disabled={busy || !workspace || (launcherTab === 'history' && !nativeSessionId)}>{busy ? '请稍后…' : launcherTab === 'history' && nativeSessionId ? '恢复会话' : '启动 Agent'}</button>}</footer>
    </form>
  </div>
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showForm, setShowForm] = useState(false)
  const [showApprovalRules, setShowApprovalRules] = useState(false)
  const [view, setView] = useState<'overview' | 'attention' | 'audit'>('overview')
  const [activeWorkspace, setActiveWorkspace] = useState<string>()
  const reloadInFlight = useRef<Promise<void>>()
  const reloadRequested = useRef(false)
  const reload = useCallback(async () => {
    reloadRequested.current = true
    if (reloadInFlight.current) return reloadInFlight.current
    const pending = (async () => {
      try {
        while (reloadRequested.current) {
          reloadRequested.current = false
          setSessions(await window.agentManager.listSessions())
        }
      } finally {
        reloadInFlight.current = undefined
      }
    })()
    reloadInFlight.current = pending
    return pending
  }, [])

  useEffect(() => {
    void reload()
    return window.agentManager.subscribe((event) => { if (event.type === 'sessions-changed') void reload() })
  }, [reload])

  const selected = sessions.find((session) => session.sessionId === selectedId)
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, { workspace: string; sessions: SessionSummary[] }>()
    for (const session of sessions) {
      const key = workspaceKey(session.workspace)
      const group = groups.get(key) ?? { workspace: session.workspace, sessions: [] }
      group.sessions.push(session)
      groups.set(key, group)
    }
    return [...groups.values()]
  }, [sessions])
  const currentWorkspace = activeWorkspace && workspaceGroups.some((group) => workspaceKey(group.workspace) === workspaceKey(activeWorkspace))
    ? activeWorkspace
    : workspaceGroups[0]?.workspace
  const visibleSessions = useMemo(() => sessions.filter((session) => currentWorkspace && workspaceKey(session.workspace) === workspaceKey(currentWorkspace)), [currentWorkspace, sessions])
  const runningCount = useMemo(() => visibleSessions.filter((session) => ['starting', 'running', 'recovering'].includes(session.status)).length, [visibleSessions])
  const pendingCount = useMemo(() => visibleSessions.filter((session) => session.status === 'needs_approval' || session.status === 'needs_attention').length, [visibleSessions])
  const totalPendingCount = useMemo(() => sessions.filter((session) => session.status === 'needs_approval' || session.status === 'needs_attention').length, [sessions])
  const activeWorkspaceName = currentWorkspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? '尚未选择工作区'
  const mountedSessions = selected
    ? sessions.filter((session) => session.sessionId === selected.sessionId)
    : view === 'overview' ? visibleSessions : []

  return (
    <main className={`app-shell${selected ? ' detail-shell' : ''}`}>
      {selected ? <div className='detail-toolbar'>
        <button type='button' className='button-secondary' onClick={() => setSelectedId(undefined)} aria-label='返回总览'>← 返回总览</button>
        <strong>{selected.displayName}</strong>
        <span>{selected.agentKind.toUpperCase()} · {selected.workspace}</span>
      </div> : <header className='topbar'>
        <div className='brand-block'>AT</div>
        <div className='app-title'><strong>Agent TUI Manager</strong><small title={currentWorkspace}>{currentWorkspace ?? '尚未选择工作区'}</small></div>
        <div className='topbar-spacer' />
        <button className='icon-button notification-button' type='button' title='审计与待处理' aria-label='处理中心' onClick={() => setView('attention')}>!{totalPendingCount > 0 && <i>{totalPendingCount}</i>}</button>
        <button className='button-secondary' type='button' onClick={() => setShowApprovalRules(true)}>批准规则</button>
        <button className='button-primary' type='button' onClick={() => setShowForm(true)}>＋ 新建 Agent</button>
      </header>}
      <div className={`workspace-layout${selected ? ' workspace-layout-detail' : ''}`}>
        <nav className='sidebar'>
          <p className='nav-label'>工作区</p>
          {workspaceGroups.map((group) => <button className={`nav-item${currentWorkspace && workspaceKey(group.workspace) === workspaceKey(currentWorkspace) ? ' active' : ''}`} type='button' key={workspaceKey(group.workspace)} onClick={() => setActiveWorkspace(group.workspace)}><span>▣</span><span title={group.workspace}>{group.workspace.split(/[\\/]/).filter(Boolean).at(-1)}</span><i className='nav-count neutral'>{group.sessions.length}</i></button>)}
          <p className='nav-label nav-section'>视图</p>
          <button className={`nav-item${view === 'overview' ? ' active' : ''}`} type='button' onClick={() => setView('overview')}><span>▦</span><span>Agent 总览</span></button>
          <button className={`nav-item${view === 'attention' ? ' active' : ''}`} type='button' onClick={() => setView('attention')}><span>!</span><span>处理中心</span>{pendingCount > 0 && <i className='nav-count'>{pendingCount}</i>}</button>
          <button className={`nav-item${view === 'audit' ? ' active' : ''}`} type='button' aria-label='审计' onClick={() => setView('audit')}><span>↺</span><span>审计</span></button>
          <button className='nav-item' type='button' onClick={() => setShowApprovalRules(true)}><span>✓</span><span>批准规则</span></button>
        </nav>
        <section className='workspace-main'>
          <div className='sectionbar'>{selected ? <span aria-hidden='true' /> : <><h1>{view === 'overview' ? 'Agent 总览' : view === 'attention' ? '处理中心' : '活动审计'}</h1><span>{view === 'overview' ? `${runningCount} 运行 · ${pendingCount} 待处理 · ${visibleSessions.length} 总计` : view === 'attention' ? `${pendingCount} 个待处理项` : '所有会话活动记录'}</span><div className='topbar-spacer' /><span>{activeWorkspaceName}</span></>}</div>
          <div className={`workspace-overview-shell${view === 'overview' ? '' : ' workspace-view-hidden'}`}>{sessions.length === 0
            ? <section className='empty-state'><div className='empty-icon'>›_</div><h2>还没有受管 Agent</h2><p>选择工作区并启动你的第一个终端 Agent。</p><button className='button-primary' type='button' onClick={() => setShowForm(true)}>新增 Agent</button></section>
            : <section className={`terminal-grid terminal-grid-count-${Math.min(mountedSessions.length, 6)}${selected ? ' terminal-grid-detail' : ''}`}>{mountedSessions.map((session) => <TerminalTile
              key={session.sessionId}
              session={session}
              detail={Boolean(selected)}
              onOpen={() => setSelectedId(session.sessionId)}
            />)}</section>}</div>
          {view === 'attention' && <AttentionCenter sessions={visibleSessions} onReload={reload} onOpenSession={(sessionId) => { setSelectedId(sessionId); setView('overview') }} />}
          {view === 'audit' && <AuditPage />}
        </section>
      </div>
      {showForm && <NewAgentForm onClose={() => setShowForm(false)} onCreated={(workspace) => { setActiveWorkspace(workspace); setShowForm(false); void reload() }} />}
      {showApprovalRules && <ApprovalRulesDialog onClose={() => setShowApprovalRules(false)} />}
    </main>
  )
}
