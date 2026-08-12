import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TerminalTile from './TerminalTile'
import ApprovalRulesDialog from './ApprovalRulesDialog'
import ContinueKeywordDialog from './ContinueKeywordDialog'
import AuditPage from './AuditPage'
import AttentionCenter from './AttentionCenter'
import type { AgentConfigSource, AgentKind, ApprovalRequest, CCSwitchProviderSummary, NativeSessionSummary, StartSessionRequest, SessionSummary } from './shared/manager-api'

function FullAutoDialog({ session, onClose, onChanged }: { session: SessionSummary; onClose: () => void; onChanged: () => void }): JSX.Element {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const enabling = !session.fullAutoEnabled
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (typeof window.agentManager.setFullAutoMode !== 'function') throw new Error('全自动模式需要重启 Manager 后启用')
      await window.agentManager.setFullAutoMode(session.sessionId, enabling)
      onChanged(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className='modal-backdrop full-auto-backdrop' role='presentation'><section className='full-auto-dialog' role='dialog' aria-modal='true' aria-labelledby='full-auto-title'>
    <header><div><p className={enabling ? 'detail-kicker delete' : 'detail-kicker read'}>{enabling ? '高风险模式' : '当前已开启'}</p><h2 id='full-auto-title'>{enabling ? '开启全自动模式' : '关闭全自动模式'}</h2></div></header>
    <div className='full-auto-dialog-body'><p>仅对 <strong>{session.displayName}</strong> 生效。适合你暂时离开、但仍希望 Agent 连续工作的场景。</p>
      {enabling ? <><div className='full-auto-warning'><strong>普通读取、写入和已识别工具会自动批准</strong><span>操作将直接执行，可能修改当前工作区内容。请先确认 Agent 当前任务和工作区无误。</span></div><ul><li>删除、递归删除、提权和敏感系统操作仍需人工批准</li><li>工作区外写入会被拦截</li><li>命令或目标信息不完整时不会自动放行</li><li>每次自动批准和拦截都会写入审计</li></ul><label className='full-auto-confirm'><input type='checkbox' checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我了解风险，并确认暂时离开期间允许此 Agent 自动执行普通操作</label></> : <div className='full-auto-safe-note'>关闭后，后续没有命中安全规则的请求会重新进入处理中心。已经执行的操作不会撤销。</div>}
      {error && <p className='form-error'>{error}</p>}
    </div><footer><button className='button-secondary' type='button' onClick={onClose}>取消</button><button className={enabling ? 'button-danger full-auto-confirm-button' : 'button-primary'} type='button' disabled={busy || (enabling && !confirmed)} onClick={() => { void submit() }}>{busy ? '请稍后…' : enabling ? '开启全自动模式' : '关闭全自动模式'}</button></footer>
  </section></div>
}

function workspaceKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/[\\]+$/, '').toLocaleLowerCase('en-US')
}

const OVERVIEW_PREFERENCES_KEY = 'agent-tui-manager:overview-preferences:v1'

interface OverviewPreferences {
  overviewMode: 'wall' | 'list'
  groupByWorkspace: boolean
  activeWorkspace?: string
}

function readOverviewPreferences(): OverviewPreferences {
  const fallback: OverviewPreferences = { overviewMode: 'wall', groupByWorkspace: false }
  try {
    const stored = window.localStorage.getItem(OVERVIEW_PREFERENCES_KEY)
    if (!stored) return fallback
    const value = JSON.parse(stored) as Partial<OverviewPreferences>
    return {
      overviewMode: value.overviewMode === 'list' ? 'list' : 'wall',
      groupByWorkspace: value.groupByWorkspace === true,
      ...(typeof value.activeWorkspace === 'string' && value.activeWorkspace ? { activeWorkspace: value.activeWorkspace } : {}),
    }
  } catch {
    return fallback
  }
}

function writeOverviewPreferences(preferences: OverviewPreferences): void {
  try {
    window.localStorage.setItem(OVERVIEW_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // UI preferences are optional and must never interrupt live terminals.
  }
}

const SESSION_STATUS_LABEL: Record<SessionSummary['status'], string> = {
  starting: '启动中', running: '运行中', needs_approval: '待授权', recovering: '恢复中',
  needs_attention: '待处理', completed: '已完成', stopped: '已停止', failed: '失败', unknown: '未知',
}

function providerHost(baseUrl?: string): string {
  if (!baseUrl) return '未配置地址'
  try { return new URL(baseUrl).host } catch { return baseUrl }
}

function CCSwitchProviderList({
  providers, selectedId, loading, error, disabled, onSelect, onRefresh,
}: {
  providers: CCSwitchProviderSummary[]
  selectedId: string
  loading: boolean
  error: string
  disabled: boolean
  onSelect: (provider: CCSwitchProviderSummary) => void
  onRefresh: () => void
}): JSX.Element {
  return <div className='ccswitch-provider-section'>
    <div className='launcher-section-title'><h2>选择 Provider</h2><button type='button' className='button-secondary mini-button' disabled={disabled || loading} onClick={onRefresh}>{loading ? '读取中…' : '刷新'}</button></div>
    {error && <p className='launcher-state error'>读取失败：{error}</p>}
    {!error && !loading && providers.length === 0 && <p className='launcher-state'>没有找到匹配的 Provider</p>}
    <div className='ccswitch-provider-list'>
      {providers.map((provider) => <button
        type='button'
        key={provider.id}
        className={`ccswitch-provider-item${selectedId === provider.id ? ' active' : ''}${provider.issue ? ' invalid' : ''}`}
        disabled={disabled || Boolean(provider.issue)}
        onClick={() => onSelect(provider)}
      >
        <span className='ccswitch-provider-main'><strong>{provider.name}</strong>{provider.isCurrent && <em>当前</em>}<small>{providerHost(provider.baseUrl)}</small></span>
        <span className='ccswitch-provider-meta'><span>{provider.model || '继承模型'}</span><span>{provider.hasApiKey ? '已配置密钥' : '缺少密钥'}</span></span>
        {provider.issue && <small className='ccswitch-provider-issue'>{provider.issue}</small>}
      </button>)}
    </div>
    <div className='launcher-config-security'><strong>只读导入</strong><span>Manager 只读取所选 Provider 的快照并加密保存；不会修改 CCSwitch 或 Agent 的原始配置。</span></div>
  </div>
}

function NewAgentForm({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: string) => void }): JSX.Element {
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const [displayName, setDisplayName] = useState('新 Agent')
  const [workspace, setWorkspace] = useState('')
  const [executable, setExecutable] = useState('codex')
  const [args, setArgs] = useState('')
  const [maxContinueRetries, setMaxContinueRetries] = useState(3)
  const [configEnabled, setConfigEnabled] = useState(false)
  const [configSource, setConfigSource] = useState<Exclude<AgentConfigSource, 'local'>>('custom')
  const [configBaseUrl, setConfigBaseUrl] = useState('')
  const [configApiKey, setConfigApiKey] = useState('')
  const [configModel, setConfigModel] = useState('')
  const [configArgs, setConfigArgs] = useState('')
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyHost, setProxyHost] = useState('127.0.0.1')
  const [proxyPort, setProxyPort] = useState(7897)
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [ccSwitchProviders, setCCSwitchProviders] = useState<CCSwitchProviderSummary[]>([])
  const [ccSwitchProviderId, setCCSwitchProviderId] = useState('')
  const [ccSwitchLoading, setCCSwitchLoading] = useState(false)
  const [ccSwitchError, setCCSwitchError] = useState('')
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummary[]>([])
  const [nativeSessionId, setNativeSessionId] = useState('')
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>('idle')
  const [discoveryError, setDiscoveryError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [launcherTab, setLauncherTab] = useState<'new' | 'history' | 'external' | 'config'>('new')
  const [historyQuery, setHistoryQuery] = useState('')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const discoveryVersion = useRef(0)

  useEffect(() => {
    if (open) setCloseArmed(false)
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current) }
  }, [open])

  const armBackdropClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }

  const resetBackdropClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }

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

  const loadCCSwitchProviders = async (kind = agentKind): Promise<void> => {
    setCCSwitchLoading(true); setCCSwitchError('')
    if (kind !== 'codex' && kind !== 'claude') {
      setCCSwitchProviders([]); setCCSwitchProviderId(''); setCCSwitchLoading(false)
      setCCSwitchError('CCSwitch 当前仅支持 Codex 和 Claude Code')
      return
    }
    try {
      if (typeof window.agentManager.listCCSwitchProviders !== 'function') throw new Error('CCSwitch 功能需要重启 Manager 后启用')
      const providers = await window.agentManager.listCCSwitchProviders(kind)
      setCCSwitchProviders(providers)
      setCCSwitchProviderId((current) => providers.some((item) => item.id === current) ? current : providers.find((item) => item.isCurrent && !item.issue)?.id ?? '')
    } catch (reason) {
      setCCSwitchProviders([])
      setCCSwitchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCCSwitchLoading(false)
    }
  }

  const changeKind = (kind: AgentKind): void => {
    setAgentKind(kind)
    setExecutable(kind === 'generic' ? 'cmd.exe' : kind)
    if (workspace) void loadNativeSessions(kind, workspace)
    if (configSource === 'ccswitch') void loadCCSwitchProviders(kind)
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
      agentConfig: configEnabled && configSource === 'ccswitch' ? {
        enabled: true,
        source: 'ccswitch',
        providerId: ccSwitchProviderId,
        providerName: ccSwitchProviders.find((item) => item.id === ccSwitchProviderId)?.name,
      } : configEnabled ? {
        enabled: true,
        source: 'custom',
        ...(configBaseUrl.trim() ? { baseUrl: configBaseUrl.trim() } : {}),
        ...(configApiKey.trim() ? { apiKey: configApiKey.trim() } : {}),
        ...(configModel.trim() ? { model: configModel.trim() } : {}),
        extraArgs: configArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      } : { enabled: false, source: 'local' },
      agentProxy: proxyEnabled ? {
        enabled: true, protocol: 'http', host: proxyHost.trim(), port: proxyPort,
        ...(proxyUsername.trim() ? { username: proxyUsername.trim() } : {}),
        ...(proxyPassword ? { password: proxyPassword } : {}),
      } : { enabled: false, host: '127.0.0.1', port: 7897 },
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

  return <div
    className={'launcher-scrim' + (open ? '' : ' launcher-scrim-hidden')}
    role='presentation'
    aria-hidden={!open}
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return
        armBackdropClose()
      }}
      onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}
    >
    <form className='agent-launcher' onMouseDown={resetBackdropClose} onSubmit={(event) => { void submit(event) }}>
      <header className='launcher-head'><h1>添加 Agent</h1><button type='button' className='icon-button' onClick={onClose} aria-label='关闭'>×</button></header>
      <div className='launcher-workspace-row'><label htmlFor='workspace'>工作区</label><div className='workspace-picker'><input id='workspace' className='launcher-field' required readOnly placeholder='请选择工作区' value={workspace} /><button type='button' className='button-secondary' disabled={busy} onClick={() => { void chooseWorkspace() }}>选择文件夹</button></div></div>
      <div className='launcher-content'>
        <nav className='launcher-tabs' aria-label='会话方式'><button type='button' className={`launcher-tab${launcherTab === 'new' ? ' active' : ''}`} onClick={() => setLauncherTab('new')}>新会话</button><button type='button' className={`launcher-tab${launcherTab === 'history' ? ' active' : ''}`} onClick={() => setLauncherTab('history')}>恢复历史</button><button type='button' className={`launcher-tab${launcherTab === 'external' ? ' active' : ''}`} onClick={() => setLauncherTab('external')}>迁移外部会话</button><button type='button' className={`launcher-tab${launcherTab === 'config' ? ' active' : ''}`} onClick={() => setLauncherTab('config')}>独立配置</button></nav>
        <label className='sr-only' htmlFor='agent-kind'>Agent 类型</label><select className='sr-only' id='agent-kind' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select>
        <label className='sr-only' htmlFor='native-session'>历史会话</label><select className='sr-only' id='native-session' value={nativeSessionId} disabled={!workspace || discoveryState === 'loading' || discoveryState === 'unsupported'} onChange={(event) => setNativeSessionId(event.target.value)}><option value=''>新建会话</option>{nativeSessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select>
        {launcherTab === 'new' && <section className='launcher-panel'><div className='launcher-section-title'><h2>选择 Agent</h2><span>选择本机 CLI</span></div><div className='launcher-agent-options'>{agentOptions.map((option) => <button type='button' key={option.kind} className={`launcher-agent-option${agentKind === option.kind ? ' active' : ''}`} onClick={() => changeKind(option.kind)}><span className={`launcher-option-logo option-${option.kind}`}>{option.logo}</span><span><strong>{option.title}</strong><span>{option.subtitle}</span></span></button>)}</div>
           {discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}
           {discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}
          <div className='launcher-form-grid'><label htmlFor='session-name'>显示名称</label><input id='session-name' className='launcher-field' required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><label htmlFor='approval-mode'>审批策略</label><select id='approval-mode' className='launcher-field' defaultValue='workspace'><option value='workspace'>使用工作区默认策略</option><option value='manual'>全部手动确认</option><option value='builtin'>仅使用内置安全规则</option></select></div><div className='launcher-command-preview'>{executable || '<custom-command>'}<small>cwd: {workspace || '请选择工作区'}</small></div>
          <details className='advanced-settings'><summary>高级设置</summary><div><label>Executable<input required value={executable} onChange={(event) => setExecutable(event.target.value)} /></label><label>参数（每行一个）<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label><label>自动 continue 最大次数<input type='number' min={1} max={10} required value={maxContinueRetries} onChange={(event) => setMaxContinueRetries(Number(event.target.value))} /></label><small>遇到明确的临时错误时，每隔 3 秒重试一次。正常结束或手动中断不会重试。</small></div></details></section>}
        {launcherTab === 'history' && <section className='launcher-panel'><div className='launcher-filter-row'><input className='launcher-field' value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder='搜索标题或会话 ID' /><select className='launcher-field' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select></div><div className='launcher-section-title'><h2>该工作区的历史会话</h2><span>按最近活动排序</span></div>
          {discoveryState === 'loading' && <p className='launcher-state'>正在读取历史会话…</p>}{discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}{discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}{discoveryState === 'ready' && filteredSessions.length === 0 && <p className='launcher-state'>该工作区没有可恢复的历史会话</p>}<div className='launcher-session-list'>{filteredSessions.map((item) => <button type='button' aria-pressed={nativeSessionId === item.id} key={item.id} className={`launcher-session-item${nativeSessionId === item.id ? ' active' : ''}`} onClick={() => setNativeSessionId((current) => current === item.id ? '' : item.id)}><span className={`launcher-option-logo option-${agentKind}`}>{agentKind === 'claude' ? 'CL' : agentKind === 'pi' ? 'Pi' : 'C'}</span><span><strong>{item.title}</strong><span>{item.subtitle || item.id}</span><small>{agentKind === 'claude' ? 'Claude Code' : agentKind.toUpperCase()} · {item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}</div></section>}
        {launcherTab === 'external' && <section className='launcher-panel'><div className='launcher-external-note'>迁移会在原终端正常停止后，通过 Agent 自带的历史恢复能力在本应用重新打开；不会复制终端画面或改变原生会话数据。</div><div className='launcher-section-title'><h2>检测到的外部 Agent</h2><span>当前没有可迁移进程</span></div></section>}
        {launcherTab === 'config' && <section className='launcher-panel launcher-config-panel'>
          <div className='launcher-config-intro'><strong>默认继承本机配置</strong><span>关闭时与普通终端启动方式完全一致，不读取或修改本机 Codex、Claude Code 配置文件。</span></div>
          <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用独立配置</strong><small>仅注入这个 Agent 的进程环境；当前工作区和其他 Agent 不受影响。</small></span><input type='checkbox' role='switch' aria-label='启用独立配置' checked={configEnabled} onChange={(event) => setConfigEnabled(event.target.checked)} /></label>
          <div className={`launcher-config-fields${configEnabled ? '' : ' disabled'}`}>
            <div className='launcher-section-title'><h2>配置来源</h2><span>只影响当前 Agent</span></div>
            <div className='launcher-config-sources'><button type='button' className={configSource === 'custom' ? 'active' : ''} disabled={!configEnabled} onClick={() => setConfigSource('custom')}><strong>手动配置</strong><small>Base URL、API Key 与 Model</small></button><button type='button' className={configSource === 'ccswitch' ? 'active' : ''} disabled={!configEnabled} onClick={() => { setConfigSource('ccswitch'); void loadCCSwitchProviders() }}><strong>CCSwitch</strong><small>只读选择本机 Provider</small></button></div>
            {configSource === 'custom' ? <><div className='launcher-config-form'>
              <label>Base URL<input className='launcher-field' disabled={!configEnabled} value={configBaseUrl} onChange={(event) => setConfigBaseUrl(event.target.value)} placeholder={agentKind === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} /></label>
              <label>API Key<input className='launcher-field' disabled={!configEnabled} type='password' autoComplete='off' value={configApiKey} onChange={(event) => setConfigApiKey(event.target.value)} placeholder='仅加密保存在本机' /></label>
              <label>Model<input className='launcher-field' disabled={!configEnabled} value={configModel} onChange={(event) => setConfigModel(event.target.value)} placeholder='留空时继承本机默认模型' /></label>
              <label>启动参数（每行一个）<textarea className='launcher-field' disabled={!configEnabled} rows={4} value={configArgs} onChange={(event) => setConfigArgs(event.target.value)} placeholder={'--feature\nvalue'} /></label>
            </div>
            <div className='launcher-config-security'><strong>安全边界</strong><span>API Key 不写入 Host 注册表、审计正文或终端回放；Manager 启动 Agent 时才临时解密。</span></div></> : <CCSwitchProviderList providers={ccSwitchProviders} selectedId={ccSwitchProviderId} loading={ccSwitchLoading} error={ccSwitchError} disabled={!configEnabled} onSelect={(provider) => setCCSwitchProviderId(provider.id)} onRefresh={() => { void loadCCSwitchProviders() }} />}
          </div>
          <div className='launcher-proxy-section'>
            <div className='launcher-section-title'><h2>HTTP 代理</h2><span>独立于模型配置</span></div>
            <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用代理</strong><small>默认关闭；开启后仅向这个 Agent 进程注入代理，不修改系统或原生 Agent 配置。</small></span><input type='checkbox' role='switch' aria-label='启用 HTTP 代理' checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} /></label>
            <div className={`launcher-proxy-form${proxyEnabled ? '' : ' disabled'}`}>
              <label>协议<input className='launcher-field' disabled value='HTTP' readOnly /></label>
              <label>主机<input className='launcher-field' disabled={!proxyEnabled} required={proxyEnabled} value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} placeholder='127.0.0.1' /></label>
              <label>端口<input className='launcher-field' disabled={!proxyEnabled} required={proxyEnabled} type='number' min={1} max={65535} value={proxyPort} onChange={(event) => setProxyPort(Number(event.target.value))} /></label>
              <label>用户名（可选）<input className='launcher-field' disabled={!proxyEnabled} autoComplete='off' value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} /></label>
              <label>密码（可选）<input className='launcher-field' disabled={!proxyEnabled} type='password' autoComplete='new-password' value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder='仅加密保存在本机' /></label>
            </div>
          </div>
        </section>}
      </div>
      {closeArmed && <p className='launcher-dismiss-hint'>再点击一次空白处关闭，已填写内容会保留</p>}
      {error && <p className='launcher-error'>{error}</p>}
      <footer className='launcher-foot'><span>{nativeSessionId ? '将在新终端中恢复已选择的历史会话' : launcherTab === 'external' ? '迁移不会中断或接管外部终端' : launcherTab === 'config' ? configEnabled ? '独立配置只应用于这个 Agent' : '当前继续继承本机配置' : `将启动新的 ${agentOptions.find((option) => option.kind === agentKind)?.title ?? 'Agent'} 会话`}</span><button type='button' className='button-secondary' onClick={onClose}>取消</button>{launcherTab !== 'external' && <button type='submit' className='button-primary' disabled={busy || !workspace || (configEnabled && configSource === 'ccswitch' && !ccSwitchProviderId)}>{busy ? '请稍后…' : nativeSessionId ? '恢复会话' : '启动 Agent'}</button>}</footer>
    </form>
  </div>
}

function EditAgentForm({ open, session, onClose, onSaved }: { open: boolean; session: SessionSummary; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [displayName, setDisplayName] = useState(session.displayName)
  const [editTab, setEditTab] = useState<'basic' | 'config'>('basic')
  const [configEnabled, setConfigEnabled] = useState(session.agentConfig?.enabled ?? false)
  const [configSource, setConfigSource] = useState<Exclude<AgentConfigSource, 'local'>>(session.agentConfig?.source === 'ccswitch' ? 'ccswitch' : 'custom')
  const [configBaseUrl, setConfigBaseUrl] = useState(session.agentConfig?.baseUrl ?? '')
  const [configApiKey, setConfigApiKey] = useState('')
  const [configModel, setConfigModel] = useState(session.agentConfig?.model ?? '')
  const [configArgs, setConfigArgs] = useState(session.agentConfig?.extraArgs.join('\n') ?? '')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(session.agentProxy?.enabled ?? false)
  const [proxyHost, setProxyHost] = useState(session.agentProxy?.host ?? '127.0.0.1')
  const [proxyPort, setProxyPort] = useState(session.agentProxy?.port ?? 7897)
  const [proxyUsername, setProxyUsername] = useState(session.agentProxy?.username ?? '')
  const [proxyPassword, setProxyPassword] = useState('')
  const [clearProxyPassword, setClearProxyPassword] = useState(false)
  const [ccSwitchProviders, setCCSwitchProviders] = useState<CCSwitchProviderSummary[]>([])
  const [ccSwitchProviderId, setCCSwitchProviderId] = useState(session.agentConfig?.providerId ?? '')
  const [ccSwitchLoading, setCCSwitchLoading] = useState(false)
  const [ccSwitchError, setCCSwitchError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const options: Array<{ kind: AgentKind; logo: string; title: string }> = [
    { kind: 'codex', logo: 'C', title: 'Codex' }, { kind: 'claude', logo: 'CL', title: 'Claude Code' },
    { kind: 'pi', logo: 'Pi', title: 'Pi' }, { kind: 'generic', logo: '+', title: '自定义命令' },
  ]

  useEffect(() => {
    setDisplayName(session.displayName)
    setConfigEnabled(session.agentConfig?.enabled ?? false)
    setConfigSource(session.agentConfig?.source === 'ccswitch' ? 'ccswitch' : 'custom')
    setConfigBaseUrl(session.agentConfig?.baseUrl ?? '')
    setConfigApiKey('')
    setConfigModel(session.agentConfig?.model ?? '')
    setConfigArgs(session.agentConfig?.extraArgs.join('\n') ?? '')
    setClearApiKey(false)
    setProxyEnabled(session.agentProxy?.enabled ?? false)
    setProxyHost(session.agentProxy?.host ?? '127.0.0.1')
    setProxyPort(session.agentProxy?.port ?? 7897)
    setProxyUsername(session.agentProxy?.username ?? '')
    setProxyPassword('')
    setClearProxyPassword(false)
    setCCSwitchProviders([])
    setCCSwitchProviderId(session.agentConfig?.providerId ?? '')
    setCCSwitchError('')
    setError('')
    setCloseArmed(false)
  }, [session.sessionId])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  const resetClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }
  const armClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }
  const loadCCSwitchProviders = async (): Promise<void> => {
    setCCSwitchLoading(true); setCCSwitchError('')
    if (session.agentKind !== 'codex' && session.agentKind !== 'claude') {
      setCCSwitchProviders([]); setCCSwitchLoading(false)
      setCCSwitchError('CCSwitch 当前仅支持 Codex 和 Claude Code')
      return
    }
    try {
      if (typeof window.agentManager.listCCSwitchProviders !== 'function') throw new Error('CCSwitch 功能需要重启 Manager 后启用')
      const providers = await window.agentManager.listCCSwitchProviders(session.agentKind)
      setCCSwitchProviders(providers)
      setCCSwitchProviderId((current) => providers.some((item) => item.id === current) ? current : providers.find((item) => item.isCurrent && !item.issue)?.id ?? '')
    } catch (reason) {
      setCCSwitchProviders([])
      setCCSwitchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCCSwitchLoading(false)
    }
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (typeof window.agentManager.renameSession !== 'function') throw new Error('编辑功能需要重启 Manager 后启用')
      if (typeof window.agentManager.updateSessionConfig !== 'function') throw new Error('独立配置功能需要重启 Manager 后启用')
      if (typeof window.agentManager.updateSessionProxy !== 'function') throw new Error('代理配置功能需要重启 Manager 后启用')
      await window.agentManager.renameSession(session.sessionId, displayName)
      await window.agentManager.updateSessionConfig(session.sessionId, configEnabled && configSource === 'ccswitch' ? {
        enabled: true,
        source: 'ccswitch',
        providerId: ccSwitchProviderId,
        providerName: ccSwitchProviders.find((item) => item.id === ccSwitchProviderId)?.name ?? session.agentConfig?.providerName,
      } : configEnabled ? {
        enabled: true,
        source: 'custom',
        ...(configBaseUrl.trim() ? { baseUrl: configBaseUrl.trim() } : {}),
        ...(configApiKey.trim() ? { apiKey: configApiKey.trim() } : {}),
        ...(configModel.trim() ? { model: configModel.trim() } : {}),
        extraArgs: configArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      } : { enabled: false, source: 'local' })
      await window.agentManager.updateSessionProxy(session.sessionId, proxyEnabled ? {
        enabled: true, protocol: 'http', host: proxyHost.trim(), port: proxyPort,
        ...(proxyUsername.trim() ? { username: proxyUsername.trim() } : {}),
        ...(proxyPassword ? { password: proxyPassword } : {}),
        ...(clearProxyPassword ? { clearPassword: true } : {}),
      } : { enabled: false, host: '127.0.0.1', port: 7897 })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return <div className={'launcher-scrim' + (open ? '' : ' launcher-scrim-hidden')} role='presentation' aria-hidden={!open}
    onMouseDown={(event) => { if (event.target === event.currentTarget) armClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetClose(); onClose() } }}>
    <form className='agent-launcher agent-editor' onMouseDown={resetClose} onSubmit={(event) => { void submit(event) }}>
      <header className='launcher-head'><h1>编辑 Agent</h1><button type='button' className='icon-button' onClick={onClose} aria-label='关闭'>×</button></header>
      <div className='launcher-workspace-row'><label>工作区</label><div className='workspace-picker'><input className='launcher-field' disabled value={session.workspace} readOnly /><button type='button' className='button-secondary' disabled>选择文件夹</button></div></div>
      <div className='launcher-content'>
        <nav className='launcher-tabs' aria-label='编辑范围'><button type='button' className={`launcher-tab${editTab === 'basic' ? ' active' : ''}`} onClick={() => setEditTab('basic')}>基本信息</button><button type='button' className={`launcher-tab${editTab === 'config' ? ' active' : ''}`} onClick={() => { setEditTab('config'); if (configEnabled && configSource === 'ccswitch') void loadCCSwitchProviders() }}>独立配置</button></nav>
        {editTab === 'basic' && <section className='launcher-panel'><div className='launcher-section-title'><h2>Agent 类型</h2><span>类型和工作区暂不可修改</span></div><div className='launcher-agent-options'>{options.map((option) => <button type='button' disabled key={option.kind} className={`launcher-agent-option${session.agentKind === option.kind ? ' active' : ''}`}><span className={`launcher-option-logo option-${option.kind}`}>{option.logo}</span><span><strong>{option.title}</strong><span>{session.agentKind === option.kind ? '当前类型' : '不可修改'}</span></span></button>)}</div>
          <div className='launcher-form-grid'><label htmlFor='edit-session-name'>显示名称</label><input id='edit-session-name' className='launcher-field' required maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><label>审批策略</label><select className='launcher-field' disabled defaultValue='workspace'><option value='workspace'>使用工作区默认策略</option></select></div>
          <div className='launcher-command-preview'>{session.agentKind === 'generic' ? 'cmd.exe' : session.agentKind}<small>session: {session.nativeSessionId ?? session.sessionId}</small></div>
          <details className='advanced-settings'><summary>高级设置</summary><div><label>Executable<input disabled value={session.agentKind === 'generic' ? 'cmd.exe' : session.agentKind} readOnly /></label><label>Model<input disabled value='跟随本机配置' readOnly /></label><label>参数<textarea disabled rows={3} value='当前版本不可修改' readOnly /></label></div></details>
        </section>}
        {editTab === 'config' && <section className='launcher-panel launcher-config-panel'>
          <div className='launcher-config-intro'><strong>{session.agentConfig?.enabled ? '当前使用独立配置' : '当前继承本机配置'}</strong><span>保存不会重启正在运行的 Agent；新配置会在下次重新启动或恢复会话时生效。</span></div>
          <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用独立配置</strong><small>关闭后恢复读取本机原生配置，不会删除或修改本机配置文件。</small></span><input type='checkbox' role='switch' aria-label='编辑独立配置' checked={configEnabled} onChange={(event) => setConfigEnabled(event.target.checked)} /></label>
          <div className={`launcher-config-fields${configEnabled ? '' : ' disabled'}`}>
            <div className='launcher-config-sources'><button type='button' className={configSource === 'custom' ? 'active' : ''} disabled={!configEnabled} onClick={() => setConfigSource('custom')}><strong>手动配置</strong><small>Base URL、API Key 与 Model</small></button><button type='button' className={configSource === 'ccswitch' ? 'active' : ''} disabled={!configEnabled} onClick={() => { setConfigSource('ccswitch'); void loadCCSwitchProviders() }}><strong>CCSwitch</strong><small>只读选择本机 Provider</small></button></div>
            {configSource === 'custom' ? <><div className='launcher-config-form'>
              <label>Base URL<input className='launcher-field' disabled={!configEnabled} value={configBaseUrl} onChange={(event) => setConfigBaseUrl(event.target.value)} /></label>
              <label>API Key<input className='launcher-field' disabled={!configEnabled} type='password' autoComplete='off' value={configApiKey} onChange={(event) => { setConfigApiKey(event.target.value); if (event.target.value) setClearApiKey(false) }} placeholder={session.agentConfig?.hasApiKey ? '已安全保存，留空保持不变' : '仅加密保存在本机'} /></label>
              {session.agentConfig?.hasApiKey && <label className='launcher-clear-secret'><input type='checkbox' disabled={!configEnabled} checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setConfigApiKey('') }} />清除已保存的 API Key</label>}
              <label>Model<input className='launcher-field' disabled={!configEnabled} value={configModel} onChange={(event) => setConfigModel(event.target.value)} placeholder='留空时继承本机默认模型' /></label>
              <label>启动参数（每行一个）<textarea className='launcher-field' disabled={!configEnabled} rows={4} value={configArgs} onChange={(event) => setConfigArgs(event.target.value)} /></label>
            </div>
            <div className='launcher-config-security'><strong>安全边界</strong><span>API Key 只保存在 Manager 的加密配置中，不修改 Agent 本机配置。</span></div></> : <CCSwitchProviderList providers={ccSwitchProviders} selectedId={ccSwitchProviderId} loading={ccSwitchLoading} error={ccSwitchError} disabled={!configEnabled} onSelect={(provider) => setCCSwitchProviderId(provider.id)} onRefresh={() => { void loadCCSwitchProviders() }} />}
          </div>
          <div className='launcher-proxy-section'>
            <div className='launcher-section-title'><h2>HTTP 代理</h2><span>下次启动或恢复时生效</span></div>
            <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用代理</strong><small>关闭后直接使用本机网络；不会修改系统代理或 Agent 原生配置。</small></span><input type='checkbox' role='switch' aria-label='编辑 HTTP 代理' checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} /></label>
            <div className={`launcher-proxy-form${proxyEnabled ? '' : ' disabled'}`}>
              <label>协议<input className='launcher-field' disabled value='HTTP' readOnly /></label>
              <label>主机<input className='launcher-field' disabled={!proxyEnabled} required={proxyEnabled} value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} /></label>
              <label>端口<input className='launcher-field' disabled={!proxyEnabled} required={proxyEnabled} type='number' min={1} max={65535} value={proxyPort} onChange={(event) => setProxyPort(Number(event.target.value))} /></label>
              <label>用户名（可选）<input className='launcher-field' disabled={!proxyEnabled} autoComplete='off' value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} /></label>
              <label>密码（可选）<input className='launcher-field' disabled={!proxyEnabled} type='password' autoComplete='new-password' value={proxyPassword} onChange={(event) => { setProxyPassword(event.target.value); if (event.target.value) setClearProxyPassword(false) }} placeholder={session.agentProxy?.hasPassword ? '已安全保存，留空保持不变' : '仅加密保存在本机'} /></label>
              {session.agentProxy?.hasPassword && <label className='launcher-clear-secret'><input type='checkbox' disabled={!proxyEnabled} checked={clearProxyPassword} onChange={(event) => { setClearProxyPassword(event.target.checked); if (event.target.checked) setProxyPassword('') }} />清除已保存的代理密码</label>}
            </div>
          </div>
        </section>}
      </div>
      {closeArmed && <p className='launcher-dismiss-hint'>双击空白处关闭，未保存的名称会保留</p>}
      {error && <p className='launcher-error'>{error}</p>}
      <footer className='launcher-foot'><span>{editTab === 'config' ? '配置将在下次启动或恢复时生效' : '名称更新不会重启 Agent'}</span><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy || !displayName.trim() || (configEnabled && configSource === 'ccswitch' && !ccSwitchProviderId)}>{busy ? '请稍后…' : '保存修改'}</button></footer>
    </form>
  </div>
}

export default function App(): JSX.Element {
  const initialOverviewPreferences = useRef<OverviewPreferences>()
  if (!initialOverviewPreferences.current) initialOverviewPreferences.current = readOverviewPreferences()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showForm, setShowForm] = useState(false)
  const [formMounted, setFormMounted] = useState(false)
  const [showApprovalRules, setShowApprovalRules] = useState(false)
  const [showContinueKeywords, setShowContinueKeywords] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string>()
  const [showNotifications, setShowNotifications] = useState(false)
  const [notificationMounted, setNotificationMounted] = useState(false)
  const [notificationBusyId, setNotificationBusyId] = useState<string>()
  const [notificationError, setNotificationError] = useState('')
  const [fullAutoSessionId, setFullAutoSessionId] = useState<string>()
  const [view, setView] = useState<'overview' | 'attention' | 'audit'>('overview')
  const [overviewMode, setOverviewMode] = useState<'wall' | 'list'>(initialOverviewPreferences.current.overviewMode)
  const [groupByWorkspace, setGroupByWorkspace] = useState(initialOverviewPreferences.current.groupByWorkspace)
  const [listActiveId, setListActiveId] = useState<string>()
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>(initialOverviewPreferences.current.activeWorkspace)
  const notificationRef = useRef<HTMLDivElement>(null)
  const notificationHideTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    writeOverviewPreferences({ overviewMode, groupByWorkspace, ...(activeWorkspace ? { activeWorkspace } : {}) })
  }, [activeWorkspace, groupByWorkspace, overviewMode])
  const openAgentForm = (): void => {
    setFormMounted(true)
    setShowForm(true)
  }
  const openAgentEditor = (sessionId: string): void => { setEditingSessionId(sessionId); setShowEditor(true) }
  const reloadInFlight = useRef<Promise<void>>()
  const reloadRequested = useRef(false)
  const reload = useCallback(async () => {
    reloadRequested.current = true
    if (reloadInFlight.current) return reloadInFlight.current
    const pending = (async () => {
      try {
        while (reloadRequested.current) {
          reloadRequested.current = false
          const nextSessions = await window.agentManager.listSessions()
          const nextApprovals = typeof window.agentManager.listPendingApprovals === 'function'
            ? await window.agentManager.listPendingApprovals()
            : nextSessions
              .filter((session) => session.status === 'needs_approval')
              .map((session) => ({
                requestId: 'terminal:' + session.sessionId,
                sessionId: session.sessionId,
                displayName: session.displayName,
                agentKind: session.agentKind,
                workspace: session.workspace,
                ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
                source: 'terminal' as const,
                risk: session.approvalRisk ?? 'unknown' as const,
                ...(session.approvalToolName ? { toolName: session.approvalToolName } : {}),
                ...(session.pendingApprovalCommand ? { command: session.pendingApprovalCommand } : {}),
                ...(session.approvalInputSummary ? { inputSummary: session.approvalInputSummary } : {}),
                reason: session.approvalReason ?? '当前客户端仍在使用旧审批接口，请重启 Manager 后查看完整结构化详情',
                ...(session.approvalFilePath ? { filePath: session.approvalFilePath } : {}),
                ...(session.approvalTargetPaths ? { targetPaths: session.approvalTargetPaths } : {}),
                createdAt: 0,
                canBulkApprove: session.approvalRisk !== 'delete' && session.approvalRisk !== 'unknown',
              }))
          setSessions(nextSessions)
          setApprovals(nextApprovals)
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

  useEffect(() => {
    if (!showNotifications) return
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!notificationRef.current?.contains(event.target as Node)) setShowNotifications(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [showNotifications])

  useEffect(() => () => { if (notificationHideTimer.current) clearTimeout(notificationHideTimer.current) }, [])

  const revealNotifications = (): void => {
    if (notificationHideTimer.current) { clearTimeout(notificationHideTimer.current); notificationHideTimer.current = undefined }
    setNotificationMounted(true)
    setShowNotifications(true)
  }
  const hideNotifications = (): void => {
    setShowNotifications(false)
    if (notificationHideTimer.current) clearTimeout(notificationHideTimer.current)
    notificationHideTimer.current = setTimeout(() => { setNotificationMounted(false); notificationHideTimer.current = undefined }, 160)
  }

  const selected = sessions.find((session) => session.sessionId === selectedId)
  const editingSession = sessions.find((session) => session.sessionId === editingSessionId)
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
  const overviewSessions = groupByWorkspace ? visibleSessions : sessions
  const overviewSessionIds = useMemo(() => new Set(overviewSessions.map((session) => session.sessionId)), [overviewSessions])
  const listSessions = overviewSessions
  const activeListSessionId = listSessions.some((session) => session.sessionId === listActiveId) ? listActiveId : listSessions[0]?.sessionId
  const runningCount = useMemo(() => overviewSessions.filter((session) => ['starting', 'running', 'recovering'].includes(session.status)).length, [overviewSessions])
  const pendingCount = useMemo(() => approvals.filter((request) => currentWorkspace && workspaceKey(request.workspace) === workspaceKey(currentWorkspace)).length
    + visibleSessions.filter((session) => session.status === 'needs_attention').length, [approvals, currentWorkspace, visibleSessions])
  const totalPendingCount = useMemo(() => approvals.length + sessions.filter((session) => session.status === 'needs_attention').length, [approvals, sessions])
  const overviewPendingCount = groupByWorkspace ? pendingCount : totalPendingCount
  const attentionSessions = useMemo(() => sessions.filter((session) => session.status === 'needs_attention'), [sessions])
  const activeWorkspaceName = currentWorkspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? '尚未选择工作区'
  const mountedSessions = selected
    ? sessions.filter((session) => session.sessionId === selected.sessionId)
    : view === 'overview' ? sessions : []

  const approveNotification = async (request: ApprovalRequest): Promise<void> => {
    setNotificationBusyId(request.requestId)
    setNotificationError('')
    try {
      if (typeof window.agentManager.approveRequest === 'function') await window.agentManager.approveRequest(request.requestId)
      else await window.agentManager.approveSession(request.sessionId)
      await reload()
    } catch (reason) {
      setNotificationError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setNotificationBusyId(undefined)
    }
  }
  const rejectNotification = async (request: ApprovalRequest): Promise<void> => {
    setNotificationBusyId(request.requestId); setNotificationError('')
    try { await window.agentManager.rejectRequest(request.requestId); await reload() }
    catch (reason) { setNotificationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setNotificationBusyId(undefined) }
  }
  const fullAutoSession = sessions.find((session) => session.sessionId === fullAutoSessionId)

  return (
    <main className={`app-shell${selected ? ' detail-shell' : ''}`}>
      {selected ? <div className='detail-toolbar'>
        <button type='button' className='button-secondary' onClick={() => setSelectedId(undefined)} aria-label='返回总览'>← 返回总览</button>
        <strong>{selected.displayName}</strong>
        <span>{selected.agentKind.toUpperCase()} · {selected.workspace}</span>
        <div className='topbar-spacer' /><button type='button' className={'full-auto-toolbar-button' + (selected.fullAutoEnabled ? ' active' : '')} onClick={() => setFullAutoSessionId(selected.sessionId)}>{selected.fullAutoEnabled ? '全自动中' : '全自动模式'}</button><button type='button' className='button-secondary button-compact' onClick={() => openAgentEditor(selected.sessionId)}>编辑 Agent</button>
      </div> : <header className='topbar'>
        <div className='brand-block'>AT</div>
        <div className='app-title'><strong>Agent TUI Manager</strong><small title={groupByWorkspace ? currentWorkspace : '全部工作区'}>{groupByWorkspace ? currentWorkspace ?? '尚未选择工作区' : '全部工作区'}</small></div>
        <div className='topbar-spacer' />
        <div className='notification-wrap' ref={notificationRef} onMouseEnter={revealNotifications} onFocusCapture={revealNotifications} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideNotifications() }}>
          <button className='icon-button notification-button' type='button' title='待处理通知' aria-label='通知' aria-expanded={showNotifications} onClick={revealNotifications}>!{totalPendingCount > 0 && <i>{totalPendingCount}</i>}</button>
          {notificationMounted && <aside className={'notification-popover' + (showNotifications ? ' is-visible' : '')} role='dialog' aria-label='通知' aria-hidden={!showNotifications}>
            <header><div><strong>待处理通知</strong><span>{totalPendingCount} 项</span></div></header>
            <div className='notification-list'>
              {totalPendingCount === 0 && <p className='notification-empty'>当前没有待处理项</p>}
              {approvals.slice(0, 5).map((request) => <div className={'notification-item risk-' + request.risk} key={request.requestId}>
                <i />
                <div><strong>{request.displayName}</strong><span>{request.toolName ?? request.agentKind.toUpperCase()} · {request.inputSummary ?? request.command ?? '参数待确认'}</span><small title={request.workspace}>{request.workspace}</small></div>
                <div className='notification-actions'><button className='button-secondary button-compact' type='button' disabled={notificationBusyId === request.requestId} onClick={() => { void rejectNotification(request) }}>拒绝</button><button className='button-approve' type='button' disabled={notificationBusyId === request.requestId} onClick={() => { void approveNotification(request) }}>{notificationBusyId === request.requestId ? '请稍后…' : '批准'}</button></div>
              </div>)}
              {attentionSessions.slice(0, Math.max(0, 5 - approvals.length)).map((session) => <div className='notification-item recovery' key={session.sessionId}>
                <i />
                <div><strong>{session.displayName}</strong><span>{session.lastError ?? '检测到异常退出'}</span><small title={session.workspace}>{session.workspace}</small></div>
              </div>)}
            </div>
            {notificationError && <p className='notification-error'>{notificationError}</p>}
            <footer><span>仅展示最近 5 项</span><button className='button-secondary button-compact' type='button' onClick={() => { hideNotifications(); setView('attention') }}>打开处理中心</button></footer>
          </aside>}
        </div>
        <button className='button-secondary' type='button' onClick={() => setShowApprovalRules(true)}>批准规则</button>
        <button className='button-secondary' type='button' onClick={() => setShowContinueKeywords(true)}>Continue 规则</button>
        <button className='button-primary' type='button' onClick={openAgentForm}>＋ 新建 Agent</button>
      </header>}
      <div className={`workspace-layout${selected ? ' workspace-layout-detail' : ''}`}>
        <nav className='sidebar'>
          {groupByWorkspace && <><p className='nav-label'>工作区</p>{workspaceGroups.map((group) => <button className={`nav-item${currentWorkspace && workspaceKey(group.workspace) === workspaceKey(currentWorkspace) ? ' active' : ''}`} type='button' key={workspaceKey(group.workspace)} onClick={() => setActiveWorkspace(group.workspace)}><span>▣</span><span title={group.workspace}>{group.workspace.split(/[\\/]/).filter(Boolean).at(-1)}</span><i className='nav-count neutral'>{group.sessions.length}</i></button>)}</>}
          <p className={`nav-label${groupByWorkspace ? ' nav-section' : ''}`}>视图</p>
          <button className={`nav-item${view === 'overview' ? ' active' : ''}`} type='button' onClick={() => setView('overview')}><span>▦</span><span>Agent 总览</span></button>
          <button className={`nav-item${view === 'attention' ? ' active' : ''}`} type='button' onClick={() => setView('attention')}><span>!</span><span>处理中心</span>{totalPendingCount > 0 && <i className='nav-count'>{totalPendingCount}</i>}</button>
          <button className={`nav-item${view === 'audit' ? ' active' : ''}`} type='button' aria-label='审计' onClick={() => setView('audit')}><span>↺</span><span>审计</span></button>
          <button className='nav-item' type='button' onClick={() => setShowApprovalRules(true)}><span>✓</span><span>批准规则</span></button>
          <button className='nav-item' type='button' onClick={() => setShowContinueKeywords(true)}><span>↻</span><span>Continue 规则</span></button>
        </nav>
        <section className='workspace-main'>
          <div className='sectionbar'>{selected ? <span aria-hidden='true' /> : <><h1>{view === 'overview' ? 'Agent 总览' : view === 'attention' ? '处理中心' : '活动审计'}</h1><span>{view === 'overview' ? `${runningCount} 运行 · ${overviewPendingCount} 待处理 · ${overviewSessions.length} 总计` : view === 'attention' ? `${totalPendingCount} 个待处理项` : '所有会话活动记录'}</span><div className='topbar-spacer' />{view === 'overview' && <div className='overview-mode-switch' role='group' aria-label='Agent 显示模式'><button type='button' aria-pressed={overviewMode === 'wall'} title='总览模式' onClick={() => setOverviewMode('wall')}>▦ 总览</button><button type='button' aria-pressed={overviewMode === 'list'} title='列表模式' onClick={() => setOverviewMode('list')}>☰ 列表</button></div>}{view === 'overview' && <button className='workspace-scope-toggle' type='button' role='switch' aria-checked={groupByWorkspace} onClick={() => setGroupByWorkspace((enabled) => !enabled)}><i />按工作区划分</button>}<span>{view === 'attention' || !groupByWorkspace ? '全部工作区' : activeWorkspaceName}</span></>}</div>
          <div className={`workspace-overview-shell${view === 'overview' ? '' : ' workspace-view-hidden'}`}>{sessions.length === 0
            ? <section className='empty-state'><div className='empty-icon'>›_</div><h2>还没有受管 Agent</h2><p>选择工作区并启动你的第一个终端 Agent。</p><button className='button-primary' type='button' onClick={openAgentForm}>新增 Agent</button></section>
            : <section className={`agent-overview-workbench${overviewMode === 'list' && !selected ? ' agent-overview-workbench-list' : ''}${selected ? ' agent-overview-workbench-detail' : ''}`}>
              {overviewMode === 'list' && !selected && <aside className='agent-session-list' aria-label='Agent 列表'>{listSessions.map((session) => <button type='button' className={session.sessionId === activeListSessionId ? 'active' : ''} aria-pressed={session.sessionId === activeListSessionId} aria-label={`切换到 ${session.displayName}`} key={session.sessionId} onClick={() => setListActiveId(session.sessionId)}><span className={`agent-dot agent-${session.agentKind}`}>{session.agentKind === 'claude' ? 'CL' : session.agentKind === 'pi' ? 'Pi' : session.agentKind === 'generic' ? '›_' : 'C'}</span><span><strong>{session.displayName}</strong><small title={session.workspace}>{session.workspace}</small></span><em className={`status-${session.status}`}>{SESSION_STATUS_LABEL[session.status]}</em></button>)}</aside>}
              <section key='terminal-grid' className={`terminal-grid terminal-grid-count-${Math.min(selected ? 1 : overviewSessions.length, 6)}${overviewMode === 'list' && !selected ? ' terminal-grid-list' : ''}${selected ? ' terminal-grid-detail' : ''}`}>{mountedSessions.map((session) => <TerminalTile
                key={session.sessionId}
                session={session}
                detail={Boolean(selected)}
                embedded={overviewMode === 'list' && !selected}
                hidden={!selected && (!overviewSessionIds.has(session.sessionId) || overviewMode === 'list' && session.sessionId !== activeListSessionId)}
                onOpen={() => setSelectedId(session.sessionId)}
                onEdit={() => openAgentEditor(session.sessionId)}
                onFullAuto={() => setFullAutoSessionId(session.sessionId)}
              />)}</section>
            </section>}</div>
          {view === 'attention' && <AttentionCenter sessions={sessions} approvals={approvals} onReload={reload} onOpenSession={(sessionId) => { setSelectedId(sessionId); setView('overview') }} />}
          {view === 'audit' && <AuditPage sessions={sessions} />}
        </section>
      </div>
      {formMounted && <NewAgentForm open={showForm} onClose={() => setShowForm(false)} onCreated={(workspace) => { setActiveWorkspace(workspace); setShowForm(false); setFormMounted(false); void reload() }} />}
      {editingSession && <EditAgentForm open={showEditor} session={editingSession} onClose={() => setShowEditor(false)} onSaved={() => { setShowEditor(false); void reload() }} />}
      {showApprovalRules && <ApprovalRulesDialog onClose={() => setShowApprovalRules(false)} />}
      {showContinueKeywords && <ContinueKeywordDialog onClose={() => setShowContinueKeywords(false)} />}
      {fullAutoSession && <FullAutoDialog session={fullAutoSession} onClose={() => setFullAutoSessionId(undefined)} onChanged={() => { void reload() }} />}
    </main>
  )
}
