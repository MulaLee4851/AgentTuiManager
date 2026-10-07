import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import TerminalTile from './TerminalTile'
import { useTerminalRetention } from './use-terminal-retention'
import { useFreeOverviewLayout } from './use-free-overview-layout'
import { useVisibleFreeSession } from './use-visible-free-session'
import OverviewLayoutControls, { type OverviewArrangement } from './OverviewLayoutControls'
import './free-overview-layout.css'
import CCSwitchProviderList from './CCSwitchProviderList'
import FavoriteWorkspaces from './FavoriteWorkspaces'
import TopNavigation, { type NavigationAction } from './TopNavigation'
import AnimatedDetails from './AnimatedDetails'
import MotionPresence from './MotionPresence'
import { motionVariables } from './ui-motion'
import { rememberRecentWorkspace } from './workspace-shortcuts'
import CollapsiblePanel from './CollapsiblePanel'
import './upgrade-ui.css'
import { playAttentionAudio } from './attention-audio'
import TerminalSettingsDialog from './TerminalSettingsDialog'
import AppearanceSettingsDialog from './AppearanceSettingsDialog'
import AttentionSoundSettingsDialog from './AttentionSoundSettingsDialog'
import NetworkRetryControls from './NetworkRetryControls'
import AutoCompactControls from './AutoCompactControls'
import ProviderModelField from './ProviderModelField'
import SessionContinuationDialog from './SessionContinuationDialog'
import SessionBindingDialog from './SessionBindingDialog'
import SessionRecoveryDialog from './SessionRecoveryDialog'
import type { NetworkRetrySettings } from './shared/network-retry'
import ApprovalModeDialog from './ApprovalModeDialog'
import { APPROVAL_MODE_LABEL, approvalModeOf } from './shared/approval-mode'
import { useStoppedSessionGrace } from './useStoppedSessionGrace'
import { SESSION_STATUS_LABEL, sessionDisplayStatus, type SessionDisplayStatus } from './shared/session-state'
import ApprovalRulesDialog from './ApprovalRulesDialog'
import ContinueKeywordDialog from './ContinueKeywordDialog'
import SessionSafetyDialog from './SessionSafetyDialog'
import DingTalkSettingsDialog from './DingTalkSettingsDialog'
import LlmReviewSettingsDialog from './LlmReviewSettingsDialog'
import './ui-motion.css'
import AuditPage from './AuditPage'
import TokenUsagePage from './TokenUsagePage'
import AttentionCenter from './AttentionCenter'
import type { AgentConfigSource, AgentEnvironmentSummary, AgentInstallProgress, AgentKind, ApprovalRequest, CCSwitchProviderSummary, ExternalTerminalDragProjection, NativeSessionSummary, NpmRegistryChoice, StartSessionRequest, SessionSummary } from './shared/manager-api'
import managerLogoUrl from '../logo/AgentTuiManager.png'
import codexLogoUrl from '../logo/codex.png'
import claudeLogoUrl from '../logo/claudecode.png'
import deepseekLogoUrl from '../logo/deepseek.svg'

import SessionStatusFilter, { normalizeStatusFilter } from './SessionStatusFilter'
const AGENT_LOGO_URLS: Partial<Record<AgentKind, string>> = { codex: codexLogoUrl, claude: claudeLogoUrl, deepseek: deepseekLogoUrl }
const DEEPSEEK_WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open']
function AgentLogo({ kind, className = '', label }: { kind: AgentKind; className?: string; label?: string }): JSX.Element {
  const source = AGENT_LOGO_URLS[kind]
  return source ? <img className={className} src={source} alt={label ?? (kind === 'claude' ? 'Claude Code' : kind === 'deepseek' ? 'DeepSeek Harness' : 'Codex')} /> : <span className={className}>{kind === 'pi' ? 'Pi' : kind === 'generic' ? '›_' : 'C'}</span>
}


function workspaceKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/[\\]+$/, '').toLocaleLowerCase('en-US')
}

const OVERVIEW_PREFERENCES_KEY = 'agent-tui-manager:overview-preferences:v1'

interface OverviewPreferences {
  overviewMode: 'wall' | 'list'
  arrangement?: OverviewArrangement
  groupByWorkspace: boolean
  activeWorkspace?: string
  sessionOrder?: string[]
  statusFilter?: SessionDisplayStatus[]
}

type OverlayKind = 'agent-form' | 'agent-editor' | 'approval-rules' | 'continue-keywords' | 'session-safety' | 'attention-sound' | 'terminal-settings' | 'appearance' | 'dingtalk' | 'llm-review' | 'full-auto' | 'continuation'

function readOverviewPreferences(): OverviewPreferences {
  const fallback: OverviewPreferences = { overviewMode: 'wall', groupByWorkspace: false }
  try {
    const stored = window.localStorage.getItem(OVERVIEW_PREFERENCES_KEY)
    if (!stored) return fallback
    const value = JSON.parse(stored) as Partial<OverviewPreferences>
    return {
      overviewMode: value.overviewMode === 'list' ? 'list' : 'wall',
      arrangement: value.arrangement === 'free' ? 'free' : 'grid',
      groupByWorkspace: value.groupByWorkspace === true,
      statusFilter: normalizeStatusFilter(value.statusFilter),
      ...(typeof value.activeWorkspace === 'string' && value.activeWorkspace ? { activeWorkspace: value.activeWorkspace } : {}),
      ...(Array.isArray(value.sessionOrder) ? { sessionOrder: value.sessionOrder.filter((item): item is string => typeof item === 'string') } : {}),
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


interface ExternalImportIntent {
  transactionId: string
  workspace?: string
  agentKind?: 'codex' | 'claude'
  nativeSessionId?: string
  issue?: string
}

function defaultExecutable(kind: AgentKind, platform = window.agentManager.platform): string {
  if (kind !== 'generic') return kind === 'deepseek' ? 'dsh' : kind
  if (platform === 'win32') return 'cmd.exe'
  return platform === 'darwin' ? 'zsh' : 'bash'
}

interface AgentEnvironmentView {
  candidate: string
  state: 'idle' | 'loading' | 'ready' | 'error'
  environment?: AgentEnvironmentSummary
  error: string
}

interface AgentInstallView {
  operation?: 'install' | 'update'
  busy: boolean
  progress?: AgentInstallProgress
  messages: Array<{ text: string; level: 'info' | 'warning' | 'error' }>
}

function NewAgentForm({ open, initialImport, onClose, onCreated }: { open: boolean; initialImport?: ExternalImportIntent; onClose: () => void; onCreated: (workspace: string, sessionId?: string) => void }): JSX.Element {
  const [agentKind, setAgentKind] = useState<AgentKind>('codex')
  const [displayName, setDisplayName] = useState('新 Agent')
  const [workspace, setWorkspace] = useState('')
  const [executable, setExecutable] = useState(() => defaultExecutable('codex'))
  const [args, setArgs] = useState('')
  const [maxContinueRetries, setMaxContinueRetries] = useState(3)
  const [configEnabled, setConfigEnabled] = useState(false)
  const [networkRetry, setNetworkRetry] = useState<NetworkRetrySettings>({})
  const [autoCompactTokens, setAutoCompactTokens] = useState<number>()
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
  const ccSwitchRequest = useRef(0)
  useEffect(() => () => { ccSwitchRequest.current += 1 }, [])
  const [ccSwitchLoading, setCCSwitchLoading] = useState(false)
  const [ccSwitchError, setCCSwitchError] = useState('')
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummary[]>([])
  const [nativeSessionId, setNativeSessionId] = useState('')
  const rememberedName = nativeSessions.find(item => item.id === nativeSessionId)?.managerDisplayName
  useEffect(() => {
    if (rememberedName) setDisplayName(rememberedName)
  }, [nativeSessionId, rememberedName])
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>('idle')
  const [discoveryError, setDiscoveryError] = useState('')
  const [environmentViews, setEnvironmentViews] = useState<Partial<Record<AgentKind, AgentEnvironmentView>>>({})
  const [installViews, setInstallViews] = useState<Partial<Record<AgentKind, AgentInstallView>>>({})
  const [npmRegistry, setNpmRegistry] = useState<NpmRegistryChoice>('configured')
  const environmentVersions = useRef<Partial<Record<AgentKind, number>>>({})
  const installOwner = useRef<AgentKind>()
  const environmentView = environmentViews[agentKind]
  const environmentMatches = environmentView?.candidate === executable.trim()
  const environment = environmentMatches ? environmentView?.environment : undefined
  const environmentState = environmentMatches ? environmentView?.state ?? 'idle' : 'idle'
  const environmentError = environmentMatches ? environmentView?.error ?? '' : ''
  const installView = installViews[agentKind]
  const installVerb = installView?.operation === 'update' ? '更新' : '安装'
  const environmentBusy = installView?.busy ?? false
  const installProgress = installView?.progress
  const installMessages = installView?.messages ?? []
  const anyEnvironmentBusy = Object.values(installViews).some((view) => view?.busy)
  const otherEnvironmentBusy = anyEnvironmentBusy && !environmentBusy
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [launcherTab, setLauncherTab] = useState<'new' | 'history' | 'external' | 'config'>('new')
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyScope, setHistoryScope] = useState<'global' | 'workspace'>('global')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const discoveryVersion = useRef(0)
  const discoveryContext = useRef('')

  useEffect(() => window.agentManager.subscribe((event) => {
    if (event.type !== 'agent-install-progress') return
    const progress = event.progress
    const owner = progress.agentKind ?? installOwner.current
    if (!owner) return
    setInstallViews((current) => {
      const previous = current[owner] ?? { busy: true, messages: [] }
      const message = progress.message
      const messages = !message || previous.messages.at(-1)?.text === message
        ? previous.messages
        : [...previous.messages, { text: message, level: progress.level ?? 'info' as const }].slice(-8)
      return {
        ...current,
        [owner]: {
          ...previous,
          busy: progress.phase !== 'completed' && progress.phase !== 'failed',
          progress,
          messages,
        },
      }
    })
  }), [])

  useEffect(() => {
    if (!initialImport) return
    const kind = initialImport.agentKind ?? 'codex'
    setAgentKind(kind)
    setExecutable(defaultExecutable(kind))
    setLauncherTab('external')
    if (initialImport.workspace) {
      setWorkspace(initialImport.workspace)
      void loadNativeSessions(kind, initialImport.workspace).then(() => {
        if (initialImport.nativeSessionId) setNativeSessionId(initialImport.nativeSessionId)
      })
    }
  }, [initialImport?.transactionId])

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

  const loadNativeSessions = async (kind: AgentKind, selectedWorkspace: string, global = false, preserveSelection = false): Promise<void> => {
    const version = ++discoveryVersion.current
    const context = `${kind}\0${global ? 'global' : selectedWorkspace}`
    const selected = preserveSelection && discoveryContext.current === context ? nativeSessionId : ''
    if (!selected) { setNativeSessionId(''); setNativeSessions([]) }
    setDiscoveryError('')
    if (kind === 'pi' || kind === 'generic' || kind === 'deepseek') {
      setDiscoveryState('unsupported')
      return
    }
    if (!global && !selectedWorkspace) { setDiscoveryState('idle'); return }
    setDiscoveryState('loading')
    try {
      const discovered = global && kind === 'codex'
        ? await window.agentManager.discoverRecentCodexSessions()
        : await window.agentManager.discoverSessions(kind, selectedWorkspace)
      if (version !== discoveryVersion.current) return
      discoveryContext.current = context
      if (selected && !discovered.some(item => item.id === selected)) setNativeSessionId('')
      setNativeSessions(discovered)
      setDiscoveryState('ready')
    } catch (reason) {
      if (version !== discoveryVersion.current) return
      setDiscoveryError(reason instanceof Error ? reason.message : String(reason))
      setDiscoveryState('error')
    }
  }

  useEffect(() => {
    if (open && launcherTab === 'history') void loadNativeSessions(agentKind, workspace, agentKind === 'codex' && historyScope === 'global', true)
  }, [open, launcherTab, agentKind, historyScope])

  const selectWorkspace = (selected: string): void => {
    setWorkspace(selected); setError('')
    // Relocating a selected history preserves the native ID. New sessions reset selection.
    if (launcherTab !== 'history') void loadNativeSessions(agentKind, selected)
    else if (historyScope === 'workspace' || agentKind !== 'codex') void loadNativeSessions(agentKind, selected)
  }
  const selectHistory = (id: string): void => {
    setNativeSessionId(id)
    const item = nativeSessions.find(candidate => candidate.id === id)
    if (item) { setWorkspace(item.workspace); setDisplayName(item.managerDisplayName ?? item.title.slice(0, 120)); setError('') }
  }

  const loadCCSwitchProviders = async (kind = agentKind): Promise<void> => {
    const request = ++ccSwitchRequest.current
    const selectedId = kind === agentKind ? ccSwitchProviderId : ''
    setCCSwitchProviders([]); setCCSwitchProviderId('')
    setCCSwitchLoading(true); setCCSwitchError('')
    if (kind !== 'codex' && kind !== 'claude') {
      setCCSwitchProviders([]); setCCSwitchProviderId(''); setCCSwitchLoading(false)
      setCCSwitchError('CCSwitch 当前仅支持 Codex 和 Claude Code')
      return
    }
    try {
      if (typeof window.agentManager.listCCSwitchProviders !== 'function') throw new Error('CCSwitch 功能需要重启 Manager 后启用')
      const providers = await window.agentManager.listCCSwitchProviders(kind)
      if (request !== ccSwitchRequest.current) return
      setCCSwitchProviders(providers)
      setCCSwitchProviderId(providers.find((item) => item.id === selectedId && !item.issue)?.id
        ?? providers.find((item) => item.isCurrent && !item.issue)?.id ?? '')
    } catch (reason) {
      if (request !== ccSwitchRequest.current) return
      setCCSwitchProviders([])
      setCCSwitchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (request === ccSwitchRequest.current) setCCSwitchLoading(false)
    }
  }

  const changeKind = (kind: AgentKind): void => {
    setAutoCompactTokens(undefined)
    ccSwitchRequest.current += 1
    setCCSwitchProviders([]); setCCSwitchProviderId(''); setCCSwitchLoading(false)
    setAgentKind(kind)
    setExecutable(defaultExecutable(kind))
    setArgs(kind === 'deepseek' ? DEEPSEEK_WEB_ARGS.join('\n') : '')
    if (launcherTab !== 'history') { if (workspace) void loadNativeSessions(kind, workspace); else { setNativeSessions([]); setNativeSessionId(''); setDiscoveryState('idle') } }
    if (configSource === 'ccswitch') void loadCCSwitchProviders(kind)
  }

  const detectEnvironment = async (kind = agentKind, candidate = executable): Promise<void> => {
    const normalizedCandidate = candidate.trim()
    if (kind === 'generic' || typeof window.agentManager.detectAgentEnvironment !== 'function') {
      setEnvironmentViews((current) => ({
        ...current,
        [kind]: { candidate: normalizedCandidate, state: 'idle', error: '' },
      }))
      return
    }
    const version = (environmentVersions.current[kind] ?? 0) + 1
    environmentVersions.current[kind] = version
    setEnvironmentViews((current) => ({
      ...current,
      [kind]: { candidate: normalizedCandidate, state: 'loading', error: '' },
    }))
    try {
      const result = await window.agentManager.detectAgentEnvironment(kind, normalizedCandidate)
      if (environmentVersions.current[kind] !== version) return
      setEnvironmentViews((current) => ({
        ...current,
        [kind]: { candidate: normalizedCandidate, state: 'ready', environment: result, error: '' },
      }))
    } catch (reason) {
      if (environmentVersions.current[kind] !== version) return
      setEnvironmentViews((current) => ({
        ...current,
        [kind]: {
          candidate: normalizedCandidate,
          state: 'error',
          error: reason instanceof Error ? reason.message : String(reason),
        },
      }))
    }
  }
  useEffect(() => {
    if (!open || agentKind === 'generic') return
    const timer = setTimeout(() => { void detectEnvironment() }, 300)
    return () => clearTimeout(timer)
  }, [agentKind, executable, open])

  const beginInstall = (kind: AgentKind, operation: 'install' | 'update' = 'install'): void => {
    installOwner.current = kind
    setInstallViews((current) => ({
      ...current,
      [kind]: { busy: true, messages: [], operation },
    }))
  }

  const finishInstall = (
    kind: AgentKind,
    progress: AgentInstallProgress,
    message: string,
    level: 'info' | 'error',
  ): void => {
    setInstallViews((current) => {
      const previous = current[kind] ?? { busy: false, messages: [] }
      const messages = previous.messages.at(-1)?.text === message
        ? previous.messages
        : [...previous.messages, { text: message, level }].slice(-8)
      return { ...current, [kind]: { ...previous, busy: false, progress: { ...progress, elapsedMs: progress.elapsedMs || previous.progress?.elapsedMs || 0 }, messages } }
    })
    if (installOwner.current === kind) installOwner.current = undefined
  }

  const installNode = async (): Promise<void> => {
    if (typeof window.agentManager.installNodeAndNpm !== 'function' || anyEnvironmentBusy) return
    const kind = agentKind
    const candidate = executable.trim()
    beginInstall(kind)
    try {
      await window.agentManager.installNodeAndNpm()
      const progress: AgentInstallProgress = { target: 'node', phase: 'completed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message: 'Node.js/npm 安装成功', level: 'info' }
      finishInstall(kind, progress, 'Node.js/npm 安装成功', 'info')
      await detectEnvironment(kind, candidate)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const progress: AgentInstallProgress = { target: 'node', phase: 'failed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message, level: 'error' }
      finishInstall(kind, progress, message, 'error')
    }
  }

  const installSelectedAgent = async (operation: 'install' | 'update' = 'install'): Promise<void> => {
    if (typeof window.agentManager.installAgent !== 'function' || anyEnvironmentBusy || installOwner.current) return
    const kind = agentKind
    const candidate = executable.trim()
    beginInstall(kind, operation)
    const verb = operation === 'update' ? '更新' : '安装'
    try {
      if (operation === 'update') await window.agentManager.installAgent(kind, npmRegistry, operation)
      else await window.agentManager.installAgent(kind, npmRegistry)
      const progress: AgentInstallProgress = { target: 'agent', agentKind: kind, phase: 'completed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message: 'Agent CLI ' + verb + '成功', level: 'info' }
      finishInstall(kind, progress, operation === 'update' ? 'npm 全局包更新成功，正在重新检测当前 CLI 版本。' : 'Agent CLI 安装成功，可以创建 Agent。', 'info')
      await detectEnvironment(kind, candidate)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const progress: AgentInstallProgress = { target: 'agent', agentKind: kind, phase: 'failed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message, level: 'error' }
      finishInstall(kind, progress, message, 'error')
    }
  }

  const installPiRipgrep = async (): Promise<void> => {
    if (typeof window.agentManager.installRipgrep !== 'function' || anyEnvironmentBusy) return
    const kind: AgentKind = 'pi'
    const candidate = executable.trim()
    beginInstall(kind)
    try {
      await window.agentManager.installRipgrep()
      const progress: AgentInstallProgress = { target: 'dependency', agentKind: kind, phase: 'completed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message: 'ripgrep 安装成功', level: 'info' }
      finishInstall(kind, progress, 'ripgrep 安装成功，Pi 下次启动不会重复下载。', 'info')
      await detectEnvironment(kind, candidate)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const progress: AgentInstallProgress = { target: 'dependency', agentKind: kind, phase: 'failed', elapsedMs: installViews[kind]?.progress?.elapsedMs ?? 0, message, level: 'error' }
      finishInstall(kind, progress, message, 'error')
    }
  }
  const chooseWorkspace = async (): Promise<void> => {
    setError('')
    try {
      const selected = await window.agentManager.chooseWorkspace()
      if (selected) selectWorkspace(selected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    if (nativeSessionId) {
      try {
        const existing = (await window.agentManager.listSessions()).find(item => item.agentKind === agentKind && item.nativeSessionId === nativeSessionId && !['stopped', 'failed', 'exited', 'completed'].includes(item.status))
        if (existing) { onCreated(existing.workspace, existing.sessionId); return }
      } catch { setError('无法确认会话运行状态，请刷新后重试'); setBusy(false); return }
    }
    if (agentKind !== 'generic' && typeof window.agentManager.detectAgentEnvironment === 'function') {
      try {
        const currentEnvironment = await window.agentManager.detectAgentEnvironment(agentKind, executable.trim())
        setEnvironmentViews((current) => ({
          ...current,
          [agentKind]: { candidate: executable.trim(), state: 'ready', environment: currentEnvironment, error: '' },
        }))
        if (!currentEnvironment.nodeAvailable || !currentEnvironment.npmAvailable) {
          setError('未检测到 Node.js/npm，请先点击“一键安装 Node.js/npm”'); setBusy(false); return
        }
        if (!currentEnvironment.agentInstalled) {
          setError('当前 Agent 尚未安装，请一键安装或在高级设置中选择可用的 Executable 文件'); setBusy(false); return
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setEnvironmentViews((current) => ({
          ...current,
          [agentKind]: { candidate: executable.trim(), state: 'error', error: message },
        }))
        setError('环境检测失败：' + message); setBusy(false); return
      }
    }
    const parsedArgs = agentKind === 'deepseek' && !args.trim() ? DEEPSEEK_WEB_ARGS : args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    const resumeArgs = nativeSessionId
      ? agentKind === 'codex'
        ? ['resume', nativeSessionId, ...parsedArgs]
        : agentKind === 'claude'
          ? ['--resume', nativeSessionId]
          : undefined
      : undefined
    const request: StartSessionRequest = {
      displayName, agentKind, workspace, executable, args: resumeArgs ?? parsedArgs, cols: 100, rows: 30,
      maxContinueRetries,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      agentConfig: configEnabled && configSource === 'ccswitch' ? {
        ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
        ...(Object.keys(networkRetry).length ? { networkRetry } : {}),
        enabled: true,
        source: 'ccswitch',
        providerId: ccSwitchProviderId,
        providerName: ccSwitchProviders.find((item) => item.id === ccSwitchProviderId)?.name,
      } : configEnabled ? {
        ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
        ...(Object.keys(networkRetry).length ? { networkRetry } : {}),
        enabled: true,
        source: 'custom',
        ...(configBaseUrl.trim() ? { baseUrl: configBaseUrl.trim() } : {}),
        ...(configApiKey.trim() ? { apiKey: configApiKey.trim() } : {}),
        ...(agentKind !== 'deepseek' && configModel.trim() ? { model: configModel.trim() } : {}),
        extraArgs: configArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      } : { enabled: false, source: 'local', ...(Object.keys(networkRetry).length ? { networkRetry } : {}), ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }) },
      agentProxy: proxyEnabled ? {
        enabled: true, protocol: 'http', host: proxyHost.trim(), port: proxyPort,
        ...(proxyUsername.trim() ? { username: proxyUsername.trim() } : {}),
        ...(proxyPassword ? { password: proxyPassword } : {}),
      } : { enabled: false, host: '127.0.0.1', port: 7897 },
    }
    if (resumeArgs) request.recovery = { executable, args: resumeArgs }
    else if (agentKind === 'deepseek') request.recovery = { executable, args: parsedArgs }
    try {
      const created = await window.agentManager.startSession(request)
      if (agentKind !== 'deepseek') rememberRecentWorkspace(created.workspace, window.agentManager.platform)
      onCreated(created.workspace, created.sessionId)
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  const chooseExecutable = async (): Promise<void> => {
    if (typeof window.agentManager.chooseExecutable !== 'function') return
    setEnvironmentViews((current) => ({
      ...current,
      [agentKind]: { candidate: executable.trim(), state: current[agentKind]?.state ?? 'idle', environment: current[agentKind]?.environment, error: '' },
    }))
    try {
      const selected = await window.agentManager.chooseExecutable(agentKind)
      if (selected) setExecutable(selected)
    } catch (reason) {
      setEnvironmentViews((current) => ({
        ...current,
        [agentKind]: { candidate: executable.trim(), state: 'error', error: reason instanceof Error ? reason.message : String(reason) },
      }))
    }
  }

  const filteredSessions = nativeSessions.filter((nativeSession) => {
    const query = historyQuery.trim().toLocaleLowerCase('zh-CN')
    return !query || nativeSession.title.toLocaleLowerCase('zh-CN').includes(query)
      || nativeSession.id.toLocaleLowerCase('en-US').includes(query)
      || nativeSession.workspace.toLocaleLowerCase('zh-CN').includes(query)
      || Boolean(nativeSession.subtitle?.toLocaleLowerCase('zh-CN').includes(query))
  })
  const agentOptions: Array<{ kind: AgentKind; logo: string; title: string; subtitle: string; disabled?: boolean }> = [
    { kind: 'codex', logo: 'C', title: 'Codex', subtitle: '深度适配 · 已安装' },
    { kind: 'claude', logo: 'CL', title: 'Claude Code', subtitle: '深度适配 · 已安装' },
    { kind: 'deepseek', logo: 'DS', title: 'DeepSeek Harness', subtitle: '官方 Web · 生命周期托管' },
    { kind: 'pi', logo: 'Pi', title: 'Pi', subtitle: '暂不可用 · 接入优化中', disabled: true },
    { kind: 'generic', logo: '+', title: '自定义命令', subtitle: '配置任意 CLI Agent' },
  ]

  return <div
    className={'launcher-scrim' + (open ? '' : ' launcher-scrim-hidden')}
    role='presentation'
    aria-hidden={!open}
    {...(!open ? { inert: '' } : {})}
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return
        armBackdropClose()
      }}
      onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}
    >
    <form className='agent-launcher' onMouseDown={resetBackdropClose} onSubmit={(event) => { void submit(event) }}>
      <header className='launcher-head'><h1>添加 Agent</h1><button type='button' className='icon-button' onClick={onClose} aria-label='关闭'>×</button></header>
      <div className='launcher-workspace-row'><label htmlFor='workspace'>工作区</label><div className='workspace-picker'><input id='workspace' className='launcher-field' required={agentKind !== 'deepseek'} disabled={agentKind === 'deepseek'} readOnly placeholder='请选择工作区' value={agentKind === 'deepseek' ? '在 Harness Web 内选择' : workspace} /><button type='button' className='button-secondary' disabled={busy || agentKind === 'deepseek'} onClick={() => { void chooseWorkspace() }}>选择文件夹</button></div></div>
      <div className='launcher-content'>
        <FavoriteWorkspaces workspace={workspace} disabled={busy || agentKind === 'deepseek'} onSelect={selectWorkspace} />
        <nav className='launcher-tabs' aria-label='会话方式'><button type='button' className={`launcher-tab${launcherTab === 'new' ? ' active' : ''}`} onClick={() => { setLauncherTab('new'); setNativeSessionId('') }}>新会话</button><button type='button' className={`launcher-tab${launcherTab === 'history' ? ' active' : ''}`} onClick={() => setLauncherTab('history')}>恢复历史</button><button type='button' className={`launcher-tab${launcherTab === 'config' ? ' active' : ''}`} onClick={() => setLauncherTab('config')}>独立配置</button></nav>
        <label className='sr-only' htmlFor='agent-kind'>Agent 类型</label><select className='sr-only' id='agent-kind' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='deepseek'>DeepSeek Harness</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select>
        <label className='sr-only' htmlFor='native-session'>历史会话</label><select className='sr-only' id='native-session' value={nativeSessionId} disabled={discoveryState === 'loading' || discoveryState === 'unsupported'} onChange={(event) => selectHistory(event.target.value)}><option value=''>新建会话</option>{nativeSessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select>
        {launcherTab === 'new' && <section className='launcher-panel'><div className='launcher-section-title'><h2>选择 Agent</h2><span>选择本机 CLI</span></div><div className='launcher-agent-options'>{agentOptions.map((option) => <button type='button' key={option.kind} disabled={option.disabled} className={`launcher-agent-option${agentKind === option.kind ? ' active' : ''}`} onClick={() => changeKind(option.kind)}><AgentLogo kind={option.kind} className={`launcher-option-logo option-${option.kind}`} label={option.title} /><span><strong>{option.title}</strong><span>{option.subtitle}</span></span></button>)}</div>
           {agentKind === 'deepseek' && <div className='launcher-agent-capability-note' role='note'><strong>DeepSeek Harness 官方当前没有交互式 TUI</strong><span>Manager 会启动并托管官方 Web 界面，负责配置、停止、重启和重连。工作区、工具审批、自动批准及会话操作仍在 Harness Web 内完成，暂不进入 Manager 处理中心或全自动模式。</span></div>}
           {discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}
           {discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}
           {agentKind !== 'generic' && <div className='launcher-environment' aria-live='polite'>
             <div className='launcher-section-title'><h2>运行环境检测</h2><button type='button' className='button-secondary mini-button' disabled={environmentBusy || environmentState === 'loading'} onClick={() => { void detectEnvironment() }}>{environmentState === 'loading' ? '检测中…' : '重新检测'}</button></div>
             {environmentState === 'loading' && <p className='launcher-state'>正在检测 Node.js、npm 和 {agentKind}…</p>}
             {(environmentState === 'error' || environmentError) && <p className='launcher-state error'>{environmentError}</p>}
             {environmentState === 'ready' && environment && <div className='launcher-environment-checks'>
               <span className={environment.nodeAvailable ? 'ok' : 'bad'}>● Node.js　{environment.nodeVersion ?? '未安装'}</span>
               <span className={environment.npmAvailable ? 'ok' : 'bad'}>● npm　{environment.npmVersion ?? '未安装'}</span>
               <span className={environment.agentInstalled ? 'ok' : 'bad'}>● Agent CLI　{environment.executableVersion ?? '未安装'}</span>
               {agentKind === 'pi' && <span className={environment.ripgrepAvailable ? 'ok' : 'bad'}>● ripgrep　{environment.ripgrepVersion ?? '未安装'}</span>}
             </div>}
             {environmentState === 'ready' && environment && (!environment.nodeAvailable || !environment.npmAvailable) && <div className='launcher-environment-install'><span>{agentKind === 'deepseek' && environment.nodeVersion ? 'DeepSeek Harness 需要 Node.js 22.19+ 或 24+，请升级 Node.js/npm。' : '需要先安装 Node.js/npm。'}</span><button type='button' className='button-secondary mini-button' disabled={anyEnvironmentBusy} onClick={() => { void installNode() }}>{environmentBusy ? '安装中…' : otherEnvironmentBusy ? '其他 Agent 安装中…' : '一键安装 Node.js/npm'}</button></div>}
             {environmentState === 'ready' && environment?.npmAvailable && <div className='launcher-environment-install launcher-environment-install-agent'><span>{environment.agentInstalled ? '更新 npm 全局安装的 CLI；请先停止同类型 Agent。自定义路径或其他安装渠道请使用原渠道更新。' : '未检测到 Agent CLI，暂时不能创建。'}</span><label>安装源<select className='launcher-field' aria-label='npm 安装源' disabled={anyEnvironmentBusy} value={npmRegistry} onChange={(event) => setNpmRegistry(event.target.value as NpmRegistryChoice)}><option value='configured'>跟随本机 npm 配置</option><option value='npmmirror'>npmmirror（国内）</option><option value='tencent'>腾讯云（国内）</option><option value='huawei'>华为云（国内）</option><option value='official'>npm 官方源</option></select></label><button type='button' className='button-secondary mini-button' disabled={anyEnvironmentBusy} onClick={() => { void installSelectedAgent(environment.agentInstalled ? 'update' : 'install') }}>{environmentBusy ? installVerb + '中…' : otherEnvironmentBusy ? '其他 Agent 安装/更新中…' : environment.agentInstalled ? '一键更新 Agent CLI' : '一键安装 Agent CLI'}</button></div>}
             {agentKind === 'pi' && environmentState === 'ready' && environment?.agentInstalled && !environment.ripgrepAvailable && <div className='launcher-environment-install'><span>Pi 缺少 ripgrep，启动时会重复尝试从 GitHub 下载。</span><button type='button' className='button-secondary mini-button' disabled={anyEnvironmentBusy} onClick={() => { void installPiRipgrep() }}>{environmentBusy ? '安装中…' : otherEnvironmentBusy ? '其他 Agent 安装中…' : '一键安装 ripgrep'}</button></div>}
             {(environmentBusy || installProgress) && <div className={`launcher-install-progress phase-${installProgress?.phase ?? 'starting'}`}>
               <div className='launcher-install-progress-head'><strong>{installProgress?.phase === 'completed' ? installVerb + '完成' : installProgress?.phase === 'failed' ? installVerb + '失败' : '正在' + installVerb}</strong><time>{Math.floor((installProgress?.elapsedMs ?? 0) / 60_000).toString().padStart(2, '0')}:{Math.floor(((installProgress?.elapsedMs ?? 0) % 60_000) / 1_000).toString().padStart(2, '0')}</time></div>
               <div className='launcher-install-pulse' aria-hidden='true'><span /></div>
               <div className='launcher-install-output'>{installMessages.length ? installMessages.map((item, index) => <span key={`${index}-${item.text}`} className={item.level}>{item.text}</span>) : <span>正在等待{installVerb}程序输出…</span>}</div>
             </div>}
             {environmentState === 'ready' && environment?.nodeAvailable && environment.npmAvailable && environment.agentInstalled && <p className='launcher-state success'>环境已就绪，可以创建 Agent。</p>}
           </div>}
          <div className='launcher-form-grid'><label htmlFor='session-name'>显示名称</label><input id='session-name' className='launcher-field' required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><label htmlFor='approval-mode'>审批策略</label><select id='approval-mode' className='launcher-field' defaultValue='workspace'><option value='workspace'>使用工作区默认策略</option><option value='manual'>全部手动确认</option><option value='builtin'>仅使用内置安全规则</option></select></div><div className='launcher-command-preview'>{executable || '<custom-command>'}<small>工作区：{workspace || '请选择工作区'}</small></div>
           <AnimatedDetails title='高级设置' className='advanced-settings'><div><label>程序路径<div className='workspace-picker'><input required value={executable} onChange={(event) => setExecutable(event.target.value)} /><button type='button' className='button-secondary' onClick={() => { void chooseExecutable() }}>选择文件</button></div></label><small>如果 CLI 没有加入 PATH，可选择完整的可执行文件路径；修改后会自动重新检测。</small><label>参数（每行一个）<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label><label>自动 continue 最大次数<input type='number' min={1} max={10} required value={maxContinueRetries} onChange={(event) => setMaxContinueRetries(Number(event.target.value))} /></label><small>遇到明确的临时错误时，每隔 3 秒重试一次。正常结束或手动中断不会重试。</small></div></AnimatedDetails></section>}
        {launcherTab === 'history' && <section className='launcher-panel'><div className='launcher-filter-row'><input className='launcher-field' value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder='搜索标题、工作区或会话 ID' aria-label='搜索历史会话' /><select className='launcher-field' value={agentKind} onChange={(event) => changeKind(event.target.value as AgentKind)}><option value='codex'>Codex</option><option value='claude'>Claude Code</option><option value='deepseek'>DeepSeek Harness</option><option value='pi'>Pi</option><option value='generic'>通用终端</option></select></div><div className='launcher-section-title'><h2>{agentKind === 'codex' && historyScope === 'global' ? '最近 50 个会话 · 全部工作区' : '该工作区的历史会话'}</h2><button type='button' disabled={discoveryState === 'loading'} onClick={() => { void loadNativeSessions(agentKind, workspace, agentKind === 'codex' && historyScope === 'global') }}>刷新历史</button></div>{agentKind === 'codex' && <label className='history-scope'>历史范围<select aria-label='历史范围' value={historyScope} onChange={event => setHistoryScope(event.target.value as 'global' | 'workspace')}><option value='global'>全部工作区 · 最近 50 个</option><option value='workspace'>当前工作区</option></select></label>}
          {discoveryState === 'idle' && <p className='launcher-state'>请选择工作区以读取历史会话</p>}{discoveryState === 'loading' && <p className='launcher-state'>正在读取历史会话…</p>}{discoveryState === 'unsupported' && <p className='launcher-state'>该 Agent 暂不支持自动读取历史会话</p>}{discoveryState === 'error' && <p className='launcher-state error'>读取失败：{discoveryError}，仍可新建会话。</p>}{discoveryState === 'ready' && filteredSessions.length === 0 && <p className='launcher-state'>没有找到可恢复的历史会话</p>}<div className='launcher-session-list'>{filteredSessions.map((item) => <button type='button' aria-pressed={nativeSessionId === item.id} key={item.id} className={`launcher-session-item${nativeSessionId === item.id ? ' active' : ''}`} onClick={() => selectHistory(nativeSessionId === item.id ? '' : item.id)}><AgentLogo kind={agentKind} className={`launcher-option-logo option-${agentKind}`} label={agentKind} /><span><strong>{item.title}</strong><span title={item.workspace}>{item.workspace}</span>{item.managedSessionId && <em>已在 Manager 中运行</em>}<small>{agentKind === 'claude' ? 'Claude Code' : agentKind.toUpperCase()} · {item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}</div></section>}
        {launcherTab === 'external' && <section className='launcher-panel'><div className='launcher-external-note'>{initialImport?.issue ?? '先在外部终端正常退出当前 Agent，再从下方选择原生会话。Manager 会通过 Agent 自带的 resume 接管；不会复制终端画面或改变原生会话数据。'}</div><div className='launcher-section-title'><h2>可迁入的原生会话</h2><span>{discoveryState === 'ready' ? filteredSessions.length + ' 个' : '请先选择工作区'}</span></div>
          {discoveryState === 'loading' && <p className='launcher-state'>正在检测原生会话…</p>}{discoveryState === 'unsupported' && <p className='launcher-state'>当前 Agent 暂不支持原生会话迁入</p>}{discoveryState === 'error' && <p className='launcher-state error'>检测失败：{discoveryError}</p>}{discoveryState === 'ready' && filteredSessions.length === 0 && <p className='launcher-state'>该工作区没有可迁入的原生会话</p>}
          <div className='launcher-session-list'>{filteredSessions.map((item) => <button type='button' aria-pressed={nativeSessionId === item.id} key={item.id} className={`launcher-session-item external-session-item${nativeSessionId === item.id ? ' active' : ''}`} onClick={() => setNativeSessionId((current) => current === item.id ? '' : item.id)}><AgentLogo kind={agentKind} className={`launcher-option-logo option-${agentKind}`} label={agentKind} /><span><strong>{item.title}</strong><span>{item.subtitle || item.workspace}</span><small>{item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}</div>
          {nativeSessionId && <div className='external-migration-steps'><strong>准备迁入</strong><span>1. 确认外部 Agent 已正常退出　2. 点击底部“迁入 Manager”　3. 若原会话仍被占用，Manager 会保留当前表单并提示重试</span></div>}
        </section>}
        {launcherTab === 'config' && <section className='launcher-panel launcher-config-panel'>
          <div className='launcher-config-intro'><strong>默认继承本机配置</strong><span>关闭时与普通终端启动方式完全一致，不读取或修改任何 Agent 的本机配置文件。</span></div>
          <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用独立配置</strong><small>为此 Agent 单独选择服务地址、密钥和模型。</small></span><input type='checkbox' role='switch' aria-label='启用独立配置' checked={configEnabled} onChange={(event) => setConfigEnabled(event.target.checked)} /></label>
          <div className={`launcher-config-fields${configEnabled ? '' : ' disabled'}`}>
            <div className='launcher-section-title'><h2>配置来源</h2><span>只影响当前 Agent</span></div>
            <div className='launcher-config-sources'><button type='button' className={configSource === 'custom' ? 'active' : ''} disabled={!configEnabled} onClick={() => setConfigSource('custom')}><strong>手动配置</strong><small>服务地址、API Key 和模型</small></button><button type='button' className={configSource === 'ccswitch' ? 'active' : ''} disabled={!configEnabled} onClick={() => { setConfigSource('ccswitch'); void loadCCSwitchProviders() }}><strong>CCSwitch</strong><small>选择已保存的服务配置</small></button></div>
            {configSource === 'custom' ? <><div className='launcher-config-form'>
              <label>服务地址（Base URL）<input className='launcher-field' disabled={!configEnabled} value={configBaseUrl} onChange={(event) => setConfigBaseUrl(event.target.value)} placeholder={agentKind === 'claude' ? 'https://api.anthropic.com' : agentKind === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'} /></label>
              <label>API Key<input className='launcher-field' disabled={!configEnabled} type='password' autoComplete='off' value={configApiKey} onChange={(event) => setConfigApiKey(event.target.value)} placeholder='仅加密保存在本机' /></label>
              <ProviderModelField baseUrl={configBaseUrl} apiKey={configApiKey} disabled={!configEnabled} deepseek={agentKind === 'deepseek'} value={configModel} onChange={setConfigModel} />
              <label>启动参数（每行一个）<textarea className='launcher-field' disabled={!configEnabled} rows={4} value={configArgs} onChange={(event) => setConfigArgs(event.target.value)} placeholder={'--feature\nvalue'} /></label>
            </div>
</> : <CCSwitchProviderList providers={ccSwitchProviders} selectedId={ccSwitchProviderId} loading={ccSwitchLoading} error={ccSwitchError} disabled={!configEnabled} onSelect={(provider) => setCCSwitchProviderId(provider.id)} onRefresh={() => { void loadCCSwitchProviders() }} />}
          </div>
          <NetworkRetryControls agentKind={agentKind} value={networkRetry} onChange={setNetworkRetry} />
          <AutoCompactControls kind={agentKind} value={autoCompactTokens} onChange={setAutoCompactTokens} />
          <div className='launcher-proxy-section'>
            <div className='launcher-section-title'><h2>HTTP 代理</h2><span>独立于模型配置</span></div>
            <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用代理</strong><small>为此 Agent 单独设置代理。</small></span><input type='checkbox' role='switch' aria-label='启用 HTTP 代理' checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} /></label>
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
      <footer className='launcher-foot'><span>{nativeSessionId ? launcherTab === 'external' ? '将通过原生 resume 迁入所选会话' : '将在新终端中恢复已选择的历史会话' : launcherTab === 'external' ? '选择一个已正常退出的原生会话' : launcherTab === 'config' ? configEnabled ? '独立配置只应用于这个 Agent' : '当前继续继承本机配置' : `将启动新的 ${agentOptions.find((option) => option.kind === agentKind)?.title ?? 'Agent'} 会话`}</span><button type='button' className='button-secondary' onClick={onClose}>取消</button>{(launcherTab !== 'external' || nativeSessionId) && <button type='submit' className='button-primary' disabled={busy || environmentBusy || (agentKind !== 'deepseek' && !workspace) || (launcherTab === 'external' && !nativeSessionId) || (configEnabled && configSource === 'ccswitch' && !ccSwitchProviderId)}>{busy ? '请稍后…' : launcherTab === 'external' ? '迁入 Manager' : nativeSessions.find(item => item.id === nativeSessionId)?.managedSessionId ? '切换到 Agent' : nativeSessionId ? '恢复会话' : '启动 Agent'}</button>}</footer>
    </form>
  </div>
}

function EditAgentForm({ open, session, onClose, onSaved }: { open: boolean; session: SessionSummary; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [displayName, setDisplayName] = useState(session.displayName)
  const [editTab, setEditTab] = useState<'basic' | 'config'>('basic')
  const [configEnabled, setConfigEnabled] = useState(session.agentConfig?.enabled ?? false)
  const [networkRetry, setNetworkRetry] = useState<NetworkRetrySettings>(session.agentConfig?.networkRetry ?? {})
  const [autoCompactTokens, setAutoCompactTokens] = useState(session.agentConfig?.autoCompactTokens)
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
    { kind: 'deepseek', logo: 'DS', title: 'DeepSeek Harness' },
    { kind: 'pi', logo: 'Pi', title: 'Pi' }, { kind: 'generic', logo: '+', title: '自定义命令' },
  ]

  useEffect(() => {
    setDisplayName(session.displayName)
    setConfigEnabled(session.agentConfig?.enabled ?? false)
    setNetworkRetry(session.agentConfig?.networkRetry ?? {})
    setAutoCompactTokens(session.agentConfig?.autoCompactTokens)
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
        ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
        ...(Object.keys(networkRetry).length ? { networkRetry } : {}),
        enabled: true,
        source: 'ccswitch',
        providerId: ccSwitchProviderId,
        providerName: ccSwitchProviders.find((item) => item.id === ccSwitchProviderId)?.name ?? session.agentConfig?.providerName,
      } : configEnabled ? {
        ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
        ...(Object.keys(networkRetry).length ? { networkRetry } : {}),
        enabled: true,
        source: 'custom',
        ...(configBaseUrl.trim() ? { baseUrl: configBaseUrl.trim() } : {}),
        ...(configApiKey.trim() ? { apiKey: configApiKey.trim() } : {}),
        ...(session.agentKind !== 'deepseek' && configModel.trim() ? { model: configModel.trim() } : {}),
        extraArgs: configArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      } : { enabled: false, source: 'local', ...(Object.keys(networkRetry).length ? { networkRetry } : {}), ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }) })
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

  return <div className={'launcher-scrim' + (open ? '' : ' launcher-scrim-hidden')} role='presentation' aria-hidden={!open} {...(!open ? { inert: '' } : {})}
    onMouseDown={(event) => { if (event.target === event.currentTarget) armClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetClose(); onClose() } }}>
    <form className='agent-launcher agent-editor' onMouseDown={resetClose} onSubmit={(event) => { void submit(event) }}>
      <header className='launcher-head'><h1>编辑 Agent</h1><button type='button' className='icon-button' onClick={onClose} aria-label='关闭'>×</button></header>
      <div className='launcher-workspace-row'><label>工作区</label><div className='workspace-picker'><input className='launcher-field' disabled value={session.workspace} readOnly /><button type='button' className='button-secondary' disabled>选择文件夹</button></div></div>
      <div className='launcher-content'>
        <nav className='launcher-tabs' aria-label='编辑范围'><button type='button' className={`launcher-tab${editTab === 'basic' ? ' active' : ''}`} onClick={() => setEditTab('basic')}>基本信息</button><button type='button' className={`launcher-tab${editTab === 'config' ? ' active' : ''}`} onClick={() => { setEditTab('config'); if (configEnabled && configSource === 'ccswitch') void loadCCSwitchProviders() }}>独立配置</button></nav>
        {editTab === 'basic' && <section className='launcher-panel'><div className='launcher-section-title'><h2>Agent 类型</h2><span>类型和工作区暂不可修改</span></div><div className='launcher-agent-options'>{options.map((option) => <button type='button' disabled key={option.kind} className={`launcher-agent-option${session.agentKind === option.kind ? ' active' : ''}`}><AgentLogo kind={option.kind} className={`launcher-option-logo option-${option.kind}`} label={option.title} /><span><strong>{option.title}</strong><span>{session.agentKind === option.kind ? '当前类型' : '不可修改'}</span></span></button>)}</div>
          <div className='launcher-form-grid'><label htmlFor='edit-session-name'>显示名称</label><input id='edit-session-name' className='launcher-field' required maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><label>审批策略</label><select className='launcher-field' disabled defaultValue='workspace'><option value='workspace'>使用工作区默认策略</option></select></div>
          <div className='launcher-command-preview'>{defaultExecutable(session.agentKind)}<small>会话 ID：{session.nativeSessionId ?? session.sessionId}</small></div>
          <AnimatedDetails title='高级设置' className='advanced-settings'><div><label>程序路径<input disabled value={defaultExecutable(session.agentKind)} readOnly /></label><label>模型<input disabled value='跟随本机配置' readOnly /></label><label>参数<textarea disabled rows={3} value='当前版本不可修改' readOnly /></label></div></AnimatedDetails>
        </section>}
        {editTab === 'config' && <section className='launcher-panel launcher-config-panel'>
          <div className='launcher-config-intro'><strong>{session.agentConfig?.enabled ? '当前使用独立配置' : '当前继承本机配置'}</strong><span>保存不会重启正在运行的 Agent；新配置会在下次重新启动或恢复会话时生效。</span></div>
          <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用独立配置</strong><small>开启时使用下方配置；关闭时使用本机 Agent 的默认配置。保存后重启生效。</small></span><input type='checkbox' role='switch' aria-label='编辑独立配置' checked={configEnabled} onChange={(event) => setConfigEnabled(event.target.checked)} /></label>
          <div className={`launcher-config-fields${configEnabled ? '' : ' disabled'}`}>
            <div className='launcher-config-sources'><button type='button' className={configSource === 'custom' ? 'active' : ''} disabled={!configEnabled} onClick={() => setConfigSource('custom')}><strong>手动配置</strong><small>服务地址、API Key 和模型</small></button><button type='button' className={configSource === 'ccswitch' ? 'active' : ''} disabled={!configEnabled} onClick={() => { setConfigSource('ccswitch'); void loadCCSwitchProviders() }}><strong>CCSwitch</strong><small>选择已保存的服务配置</small></button></div>
            {configSource === 'custom' ? <><div className='launcher-config-form'>
              <label>服务地址（Base URL）<input className='launcher-field' disabled={!configEnabled} value={configBaseUrl} onChange={(event) => setConfigBaseUrl(event.target.value)} /></label>
              <label>API Key<input className='launcher-field' disabled={!configEnabled} type='password' autoComplete='off' value={configApiKey} onChange={(event) => { setConfigApiKey(event.target.value); if (event.target.value) setClearApiKey(false) }} placeholder={session.agentConfig?.hasApiKey ? '已安全保存，留空保持不变' : '仅加密保存在本机'} /></label>
              {session.agentConfig?.hasApiKey && <label className='launcher-clear-secret'><input type='checkbox' disabled={!configEnabled} checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setConfigApiKey('') }} />清除已保存的 API Key</label>}
              <ProviderModelField baseUrl={configBaseUrl} apiKey={configApiKey} sessionId={session.sessionId} clearApiKey={clearApiKey} disabled={!configEnabled} deepseek={session.agentKind === 'deepseek'} value={configModel} onChange={setConfigModel} />
              <label>启动参数（每行一个）<textarea className='launcher-field' disabled={!configEnabled} rows={4} value={configArgs} onChange={(event) => setConfigArgs(event.target.value)} /></label>
            </div>
            </> : <CCSwitchProviderList providers={ccSwitchProviders} selectedId={ccSwitchProviderId} loading={ccSwitchLoading} error={ccSwitchError} disabled={!configEnabled} onSelect={(provider) => setCCSwitchProviderId(provider.id)} onRefresh={() => { void loadCCSwitchProviders() }} />}
          </div>
          <NetworkRetryControls agentKind={session.agentKind} value={networkRetry} onChange={setNetworkRetry} />
          <AutoCompactControls kind={session.agentKind} value={autoCompactTokens} onChange={setAutoCompactTokens} />
          <div className='launcher-proxy-section'>
            <div className='launcher-section-title'><h2>HTTP 代理</h2><span>下次启动或恢复时生效</span></div>
            <label className='launcher-config-toggle'><span><strong>为这个 Agent 使用代理</strong><small>保存后重启该 Agent 生效，不修改系统代理。</small></span><input type='checkbox' role='switch' aria-label='编辑 HTTP 代理' checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} /></label>
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
  const [showSessionSafety, setShowSessionSafety] = useState(false)
  const [showAppearance, setShowAppearance] = useState(false)
  const [showTerminalSettings, setShowTerminalSettings] = useState(false)
  const [showAttentionSoundSettings, setShowAttentionSoundSettings] = useState(false)
  const [showDingTalkSettings, setShowDingTalkSettings] = useState(false)
  const [showLlmReviewSettings, setShowLlmReviewSettings] = useState(false)
  const [llmReviewInitialView, setLlmReviewInitialView] = useState<'settings' | 'results'>('settings')
  const [showEditor, setShowEditor] = useState(false)
  const [continuationSource, setContinuationSource] = useState<SessionSummary>()
  const [bindingTarget, setBindingTarget] = useState<{ session: SessionSummary; mode: 'history' | 'fresh' }>()
  const [recoveryChoiceId, setRecoveryChoiceId] = useState<string>()
  const dismissedRecoveryChoices = useRef(new Set<string>())
  const [editingSessionId, setEditingSessionId] = useState<string>()
  const [navigationMenuOpen, setNavigationMenuOpen] = useState(false)
  const [fullAutoSessionId, setFullAutoSessionId] = useState<string>()
  const [view, setView] = useState<'overview' | 'attention' | 'audit' | 'tokens'>('overview')
  const [overviewMode, setOverviewMode] = useState<'wall' | 'list'>(initialOverviewPreferences.current.overviewMode)
  const [arrangement, setArrangement] = useState<OverviewArrangement>(initialOverviewPreferences.current.arrangement ?? 'grid')
  const [groupByWorkspace, setGroupByWorkspace] = useState(initialOverviewPreferences.current.groupByWorkspace)
  const [listActiveId, setListActiveId] = useState<string>()
  const [wallActiveId, setWallActiveId] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<SessionDisplayStatus[]>(initialOverviewPreferences.current.statusFilter ?? [])
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>(initialOverviewPreferences.current.activeWorkspace)
  const [sessionOrder, setSessionOrder] = useState<string[]>(initialOverviewPreferences.current.sessionOrder ?? [])
  const [draggingSessionId, setDraggingSessionId] = useState<string>()
  const [listDraggingId, setListDraggingId] = useState<string>()
  const [detachBusy, setDetachBusy] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [externalDrag, setExternalDrag] = useState<ExternalTerminalDragProjection | null>(null)
  const [externalImport, setExternalImport] = useState<ExternalImportIntent>()
  useEffect(() => {
    writeOverviewPreferences({ overviewMode, arrangement, groupByWorkspace, ...(activeWorkspace ? { activeWorkspace } : {}), sessionOrder, statusFilter })
  }, [activeWorkspace, groupByWorkspace, overviewMode, arrangement, sessionOrder, statusFilter])
  const recoveryChoice = sessions.find(session => session.sessionId === recoveryChoiceId && session.startupRecoveryRequired)
  useEffect(() => {
    if (recoveryChoiceId && !sessions.some(session => session.sessionId === recoveryChoiceId && session.startupRecoveryRequired)) setRecoveryChoiceId(undefined)
  }, [sessions, recoveryChoiceId])
  useEffect(() => {
    if (bindingTarget || recoveryChoiceId || showForm || showEditor || showApprovalRules || showContinueKeywords || showSessionSafety || showDingTalkSettings || showLlmReviewSettings || showAttentionSoundSettings || showTerminalSettings || showAppearance || fullAutoSessionId || continuationSource || navigationMenuOpen) return
    const failed = sessions.find(session => session.startupRecoveryRequired && ['codex', 'claude'].includes(session.agentKind)
      && !dismissedRecoveryChoices.current.has(session.sessionId + ':' + session.activitySince))
    if (failed) setRecoveryChoiceId(failed.sessionId)
  }, [sessions, bindingTarget, recoveryChoiceId, showForm, showEditor, showApprovalRules, showContinueKeywords, showSessionSafety, showDingTalkSettings, showLlmReviewSettings, showAttentionSoundSettings, showTerminalSettings, showAppearance, fullAutoSessionId, continuationSource, navigationMenuOpen])
  const dismissRecoveryChoice = (): void => {
    if (recoveryChoice) dismissedRecoveryChoices.current.add(recoveryChoice.sessionId + ':' + recoveryChoice.activitySince)
    setRecoveryChoiceId(undefined)
  }
  const closeOtherOverlays = useCallback((except: OverlayKind | 'navigation'): void => {
    setBindingTarget(undefined)
    setRecoveryChoiceId(undefined)
    if (except !== 'continuation') setContinuationSource(undefined)
    if (except !== 'agent-form') setShowForm(false)
    if (except !== 'agent-editor') setShowEditor(false)
    if (except !== 'approval-rules') setShowApprovalRules(false)
    if (except !== 'continue-keywords') setShowContinueKeywords(false)
    if (except !== 'session-safety') setShowSessionSafety(false)
    if (except !== 'appearance') setShowAppearance(false)
    if (except !== 'terminal-settings') setShowTerminalSettings(false)
    if (except !== 'attention-sound') setShowAttentionSoundSettings(false)
    if (except !== 'dingtalk') setShowDingTalkSettings(false)
    if (except !== 'llm-review') setShowLlmReviewSettings(false)
    if (except !== 'full-auto') setFullAutoSessionId(undefined)
  }, [])
  const openAgentForm = (): void => {
    closeOtherOverlays('agent-form')
    setFormMounted(true)
    setShowForm(true)
  }
  const openAgentEditor = (sessionId: string): void => {
    closeOtherOverlays('agent-editor')
    setEditingSessionId(sessionId)
    setShowEditor(true)
  }
  const openFullAuto = (sessionId: string): void => {
    closeOtherOverlays('full-auto')
    setFullAutoSessionId(sessionId)
  }
  const reloadInFlight = useRef<Promise<void>>()
  const reloadRequested = useRef(false)
  const sessionStateRevision = useRef(0)
  const reload = useCallback(async () => {
    reloadRequested.current = true
    if (reloadInFlight.current) return reloadInFlight.current
    const pending = (async () => {
      try {
        while (reloadRequested.current) {
          reloadRequested.current = false
          const revision = sessionStateRevision.current
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
          if (sessionStateRevision.current === revision) {
            setSessions(nextSessions)
            setApprovals(nextApprovals)
          }
        }
      } finally {
        reloadInFlight.current = undefined
      }
    })()
    reloadInFlight.current = pending
    return pending
  }, [])

  useEffect(() => window.agentManager.onAttentionSound?.(playAttentionAudio), [])

  useEffect(() => {
    void reload()
    return window.agentManager.subscribe((event) => {
      if (event.type === 'sessions-changed') {
        const nextSession = event.session
        const nextApprovals = event.approvals
        if (nextSession !== undefined && nextApprovals !== undefined) {
          sessionStateRevision.current += 1
          setSessions((current) => {
            if (nextSession === null) return current.filter((item) => item.sessionId !== event.sessionId)
            const index = current.findIndex((item) => item.sessionId === event.sessionId)
            if (index < 0) return [...current, nextSession]
            const next = [...current]
            next[index] = nextSession
            return next
          })
          setApprovals((current) => [
            ...current.filter((request) => request.sessionId !== event.sessionId),
            ...nextApprovals,
          ].sort((left, right) => left.createdAt - right.createdAt))
        } else {
          void reload()
        }
      }
      if (event.type === 'external-terminal-drag') setExternalDrag(event.projection)
    })
  }, [reload])

  const selected = sessions.find((session) => session.sessionId === selectedId)
  const editingSession = sessions.find((session) => session.sessionId === editingSessionId)
  const orderedSessions = useMemo(() => {
    const positions = new Map(sessionOrder.map((id, index) => [id, index]))
    return sessions.map((session, index) => ({ session, index })).sort((left, right) => {
      const leftPosition = positions.get(left.session.sessionId) ?? sessionOrder.length + left.index
      const rightPosition = positions.get(right.session.sessionId) ?? sessionOrder.length + right.index
      return leftPosition - rightPosition
    }).map(({ session }) => session)
  }, [sessionOrder, sessions])
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, { workspace: string; sessions: SessionSummary[] }>()
    for (const session of orderedSessions) {
      const key = workspaceKey(session.workspace)
      const group = groups.get(key) ?? { workspace: session.workspace, sessions: [] }
      group.sessions.push(session)
      groups.set(key, group)
    }
    return [...groups.values()]
  }, [orderedSessions])
  const currentWorkspace = activeWorkspace && workspaceGroups.some((group) => workspaceKey(group.workspace) === workspaceKey(activeWorkspace))
    ? activeWorkspace
    : workspaceGroups[0]?.workspace
  useEffect(() => {
    if (externalDrag?.phase !== 'dropped') return
    closeOtherOverlays('agent-form')
    setExternalImport({ transactionId: externalDrag.transactionId, ...(externalDrag.suggestedWorkspace ?? currentWorkspace ? { workspace: externalDrag.suggestedWorkspace ?? currentWorkspace } : {}), ...(externalDrag.suggestedAgentKind ? { agentKind: externalDrag.suggestedAgentKind } : {}), ...(externalDrag.suggestedNativeSessionId ? { nativeSessionId: externalDrag.suggestedNativeSessionId } : {}), ...(externalDrag.issue ? { issue: externalDrag.issue } : {}) })
    setFormMounted(true)
    setShowForm(true)
    setExternalDrag(null)
  }, [closeOtherOverlays, externalDrag?.phase, externalDrag?.transactionId])
  const visibleSessions = useMemo(() => orderedSessions.filter((session) => currentWorkspace && workspaceKey(session.workspace) === workspaceKey(currentWorkspace)), [currentWorkspace, orderedSessions])
  const scopedSessions = groupByWorkspace ? visibleSessions : orderedSessions
  const stoppedGrace = useStoppedSessionGrace(sessions)
  const overviewSessions = useMemo(() => scopedSessions.filter((session) => statusFilter.length === 0
    || statusFilter.includes(sessionDisplayStatus(session))
    || (stoppedGrace.has(session.sessionId) && statusFilter.includes(stoppedGrace.get(session.sessionId)!))), [scopedSessions, statusFilter, stoppedGrace])
  const overviewSessionIds = useMemo(() => new Set(overviewSessions.map((session) => session.sessionId)), [overviewSessions])
  const listSessions = overviewSessions
  const activeListSessionId = listSessions.some((session) => session.sessionId === listActiveId) ? listActiveId : listSessions[0]?.sessionId
  const hasAttentionOverlay = showForm || showEditor || showApprovalRules || showContinueKeywords || showSessionSafety
    || showDingTalkSettings || showLlmReviewSettings || showAttentionSoundSettings || showTerminalSettings || showAppearance || Boolean(fullAutoSessionId || continuationSource) || navigationMenuOpen || Boolean(bindingTarget || recoveryChoice)
  const candidateSoundSessionId = view !== 'overview' || hasAttentionOverlay ? undefined : selected?.sessionId
    ?? (overviewMode === 'list' ? activeListSessionId : wallActiveId && overviewSessionIds.has(wallActiveId) ? wallActiveId : undefined)
  const runningCount = useMemo(() => overviewSessions.filter((session) => sessionDisplayStatus(session) === 'running').length, [overviewSessions])
  const manualApprovals = useMemo(() => approvals.filter(request => { const owner = sessions.find(session => session.sessionId === request.sessionId); return !owner || approvalModeOf(owner) === 'manual' }), [approvals, sessions])
  const pendingCount = useMemo(() => manualApprovals.filter((request) => currentWorkspace && workspaceKey(request.workspace) === workspaceKey(currentWorkspace)).length
    + visibleSessions.filter((session) => session.status === 'needs_attention').length, [manualApprovals, currentWorkspace, visibleSessions])
  const totalPendingCount = useMemo(() => manualApprovals.length + sessions.filter((session) => session.status === 'needs_attention').length, [manualApprovals, sessions])
  const overviewPendingCount = groupByWorkspace ? pendingCount : totalPendingCount
  const terminalSessionIds = useMemo(() => orderedSessions.map(session => session.sessionId), [orderedSessions])
  const visibleTerminalIds = useMemo(() => [
    // Only Codex has a Host-side terminal protocol responder. Other TUIs still
    // need their renderer to answer probes even before their first visible frame.
    ...orderedSessions.filter(session => session.agentKind !== 'codex').map(session => session.sessionId),
    ...(selected ? [selected.sessionId] : overviewMode === 'list' ? (activeListSessionId ? [activeListSessionId] : [])
      : overviewSessions.map(session => session.sessionId)),
  ], [orderedSessions, selected?.sessionId, overviewMode, activeListSessionId, overviewSessions])
  const retainedTerminals = useTerminalRetention(terminalSessionIds, visibleTerminalIds)
  const freeMode = view === 'overview' && overviewMode === 'wall' && !selected && arrangement === 'free'
  const freeVisibleIds = useMemo(() => overviewSessions.map(session => session.sessionId), [overviewSessions])
  const freeLayout = useFreeOverviewLayout(terminalSessionIds, freeVisibleIds, freeMode)
  const visibleFreeActiveId = useVisibleFreeSession(freeLayout.containerRef, candidateSoundSessionId, freeMode)
  const activeSoundSessionId = freeMode ? visibleFreeActiveId : candidateSoundSessionId
  useEffect(() => {
    if (freeMode && candidateSoundSessionId) freeLayout.bringToFront(candidateSoundSessionId)
  }, [freeMode, candidateSoundSessionId, freeLayout.bringToFront])
  useEffect(() => {
    void window.agentManager.setActiveSession?.(activeSoundSessionId ?? null)?.catch(() => undefined)
  }, [activeSoundSessionId])

  const navigate = (action: NavigationAction): void => {
    closeOtherOverlays('navigation')
    if (action === 'overview' || action === 'attention' || action === 'audit' || action === 'tokens') { setSelectedId(undefined); setView(action); return }
    if (action === 'approval-rules') setShowApprovalRules(true)
    else if (action === 'continue-keywords') setShowContinueKeywords(true)
    else if (action === 'session-safety') setShowSessionSafety(true)
    else if (action === 'appearance') setShowAppearance(true)
    else if (action === 'terminal-settings') setShowTerminalSettings(true)
    else if (action === 'attention-sound') setShowAttentionSoundSettings(true)
    else if (action === 'dingtalk') setShowDingTalkSettings(true)
    else if (action === 'llm-review') { setLlmReviewInitialView('settings'); setShowLlmReviewSettings(true) }
  }
  const fullAutoSession = sessions.find((session) => session.sessionId === fullAutoSessionId)
  const moveDraggedBefore = (targetId: string, draggedId = draggingSessionId, after = false): void => {
    if (!draggedId || draggedId === targetId) return
    setSessionOrder(() => {
      const ids = orderedSessions.map((session) => session.sessionId).filter((id) => id !== draggedId)
      const targetIndex = ids.indexOf(targetId)
      ids.splice(targetIndex < 0 ? ids.length : targetIndex + (after ? 1 : 0), 0, draggedId)
      return ids
    })
  }
  const detachDragged = async (): Promise<void> => {
    if (!draggingSessionId || detachBusy) return
    const session = sessions.find((item) => item.sessionId === draggingSessionId)
    if (!session) return
    if (!session.nativeSessionId || (session.agentKind !== 'codex' && session.agentKind !== 'claude')) {
      setHandoffError('这个 Agent 尚未建立可恢复的 Codex/Claude 原生会话，不能拖出。')
      setDraggingSessionId(undefined)
      return
    }
    setDetachBusy(true); setHandoffError('')
    try {
      await window.agentManager.detachSession(session.sessionId)
      setSelectedId(undefined)
      await reload()
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDetachBusy(false)
      setDraggingSessionId(undefined)
    }
  }

  return (
    <main className={`app-shell platform-${window.agentManager.platform}${selected ? ' detail-shell' : ''}`} style={motionVariables}>
      {selected ? <div className='detail-toolbar'>
        <button type='button' className='button-secondary' onClick={() => setSelectedId(undefined)} aria-label='返回总览'>← 返回总览</button>
        <strong>{selected.displayName}</strong>
        <span>{selected.agentKind.toUpperCase()} · {selected.workspace}</span>
        <div className='topbar-spacer' /><button type='button' className={'full-auto-toolbar-button' + (selected.fullAutoEnabled || selected.unattended?.enabled ? ' active' : '')} onClick={() => openFullAuto(selected.sessionId)}>{APPROVAL_MODE_LABEL[approvalModeOf(selected)]}</button><button type='button' className='button-secondary button-compact' onClick={() => openAgentEditor(selected.sessionId)}>编辑 Agent</button>
      </div> : <header className='topbar'>
        <div className='brand-block'><img src={managerLogoUrl} alt='Agent TUI Manager' /></div>
        <TopNavigation view={view} pendingCount={totalPendingCount} onNavigate={navigate} onMenuOpenChange={setNavigationMenuOpen} />
        <button className='button-primary topbar-new-agent' type='button' onClick={openAgentForm}>＋ 新建 Agent</button>
      </header>}
      <div className={`workspace-layout${selected ? ' workspace-layout-detail' : ''}`}>
        <section className='workspace-main'>
          <div className='sectionbar'>{selected ? <span aria-hidden='true' /> : <><h1>{view === 'overview' ? 'Agent 总览' : view === 'attention' ? '处理中心' : view === 'audit' ? '活动审计' : 'Token 用量'}</h1><span>{view === 'overview' ? `${runningCount} 运行 · ${overviewPendingCount} 待处理 · ${overviewSessions.length} 总计` : view === 'attention' ? `${totalPendingCount} 个待处理项` : view === 'audit' ? '所有会话活动记录' : '按 Agent、服务配置和模型查看 Token 用量'}</span><div className='topbar-spacer' />{view === 'overview' && <SessionStatusFilter value={statusFilter} onChange={setStatusFilter} />}{view === 'overview' && <div className='overview-mode-switch' role='group' aria-label='Agent 显示模式'><button type='button' aria-pressed={overviewMode === 'wall'} title='总览模式' onClick={() => setOverviewMode('wall')}>▦ 总览</button><button type='button' aria-pressed={overviewMode === 'list'} title='列表模式' onClick={() => setOverviewMode('list')}>☰ 列表</button></div>}{view === 'overview' && overviewMode === 'wall' && <OverviewLayoutControls value={arrangement} onChange={setArrangement} onArrange={freeLayout.arrange} />}{view === 'overview' && <button className='workspace-scope-toggle' type='button' role='switch' aria-checked={groupByWorkspace} onClick={() => setGroupByWorkspace((enabled) => !enabled)}><i />按工作区划分</button>}{view === 'overview' && groupByWorkspace && <label className='workspace-scope-picker'><span className='sr-only'>切换工作区</span><select aria-label='切换工作区' title={currentWorkspace} value={currentWorkspace ? workspaceKey(currentWorkspace) : ''} onChange={event => { const group = workspaceGroups.find(item => workspaceKey(item.workspace) === event.target.value); if (group) setActiveWorkspace(group.workspace) }}>{!workspaceGroups.length && <option value=''>尚未选择工作区</option>}{workspaceGroups.map(group => <option key={workspaceKey(group.workspace)} value={workspaceKey(group.workspace)}>{group.workspace.split(/[\\/]/).filter(Boolean).at(-1)} · {group.sessions.length}</option>)}</select></label>}</>}</div>
          <div className={`workspace-overview-shell${view === 'overview' ? '' : ' workspace-view-hidden'}`}>{sessions.length === 0 && externalDrag?.phase !== 'hovering'
            ? <section className='empty-state'><div className='empty-icon'>›_</div><h2>还没有 Agent</h2><p>选择工作区并启动你的第一个终端 Agent。</p><button className='button-primary' type='button' onClick={openAgentForm}>新增 Agent</button></section>
            : <section className={`agent-overview-workbench${overviewMode === 'list' && !selected ? ' agent-overview-workbench-list' : ''}${selected ? ' agent-overview-workbench-detail' : ''}`}>
              {overviewMode === 'list' && !selected && <CollapsiblePanel name='Agent 列表' storageId='agents' anchorVersion={activeListSessionId} keepOpen={Boolean(listDraggingId)} badge={overviewPendingCount}><aside className='agent-session-list' aria-label='Agent 列表'>{listSessions.map((session) => <button type='button' className={session.sessionId === activeListSessionId ? 'active' : ''} aria-pressed={session.sessionId === activeListSessionId} aria-label={`切换到 ${session.displayName}`} key={session.sessionId}
                draggable title='拖动调整顺序'
                onDragStart={(event) => {
                  setListActiveId(activeListSessionId)
                  setListDraggingId(session.sessionId)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('application/x-agent-tui-session', session.sessionId)
                }}
                onDragOver={(event) => { if (listDraggingId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                onDrop={(event) => {
                  if (!listDraggingId) return
                  event.preventDefault()
                  event.stopPropagation()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  moveDraggedBefore(session.sessionId, listDraggingId, bounds.height > 0 && event.clientY > bounds.top + bounds.height / 2)
                  setListDraggingId(undefined)
                }}
                onDragEnd={() => setListDraggingId(undefined)}
                onClick={() => setListActiveId(session.sessionId)}><AgentLogo kind={session.agentKind} className={`agent-dot agent-${session.agentKind}`} label={session.agentKind} /><span><strong>{session.displayName}</strong><small title={session.workspace}>{session.workspace}</small></span><em className={`status-${sessionDisplayStatus(session)}`}>{SESSION_STATUS_LABEL[sessionDisplayStatus(session)]}</em></button>)}</aside></CollapsiblePanel>}
              <section ref={freeLayout.containerRef} key='terminal-grid' className={`terminal-grid${freeMode ? ' terminal-grid-free' : ''} terminal-grid-count-${Math.min(selected ? 1 : overviewSessions.length + (externalDrag?.phase === 'hovering' ? 1 : 0), 6)}${overviewMode === 'list' && !selected ? ' terminal-grid-list' : ''}${selected ? ' terminal-grid-detail' : ''}`}>{orderedSessions.map((session) => <TerminalTile
                key={session.sessionId}
                session={session}
                approval={approvals.find((request) => request.sessionId === session.sessionId)}
                active={activeSoundSessionId === session.sessionId}
                onActivate={() => { setWallActiveId(session.sessionId); if (freeMode) freeLayout.bringToFront(session.sessionId) }}
                detail={Boolean(selected)}
                embedded={overviewMode === 'list' && !selected}
                hidden={selected ? session.sessionId !== selected.sessionId : !overviewSessionIds.has(session.sessionId) || overviewMode === 'list' && session.sessionId !== activeListSessionId}
                retained={retainedTerminals.has(session.sessionId)}
                freeLayout={freeMode && freeLayout.windows[session.sessionId] ? { rect: freeLayout.windows[session.sessionId]!, start: (edge, event) => freeLayout.start(session.sessionId, edge, event), keyAdjust: (edge, event) => freeLayout.keyAdjust(session.sessionId, edge, event) } : undefined}
                onOpen={() => setSelectedId(session.sessionId)}
                onEdit={() => openAgentEditor(session.sessionId)} onBinding={mode => {
                  closeOtherOverlays('navigation'); setBindingTarget({ session, mode })
                }}
                onContinuation={() => { closeOtherOverlays('continuation'); setContinuationSource(session) }}
                onFullAuto={() => openFullAuto(session.sessionId)}
                draggable={!selected && overviewMode === 'wall' && !freeMode}
                dragging={draggingSessionId === session.sessionId}
                onDragStart={() => { setDraggingSessionId(session.sessionId); setHandoffError('') }}
                onDragEnd={() => { if (!detachBusy) setDraggingSessionId(undefined) }}
                onDragOver={() => moveDraggedBefore(session.sessionId)}
              />)}{freeMode && <div className='free-layout-spacer' data-free-layout-spacer aria-hidden='true' style={freeLayout.extent} />}{!selected && overviewSessions.length === 0 && <div className='overview-filter-empty' role='status'>没有符合当前状态的 Agent</div>}{externalDrag?.phase === 'hovering' && view === 'overview' && !selected && <div className='external-handoff-placeholder' data-testid='handoff-placeholder' aria-live='polite'>请稍后…</div>}</section>
              {draggingSessionId && <div
                className={'native-terminal-dropzone' + (detachBusy ? ' busy' : '')}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                onDrop={(event) => { event.preventDefault(); void detachDragged() }}
              ><strong>{detachBusy ? '请稍后…' : '拖到这里，在原生终端继续'}</strong><span>Manager 会先安全释放会话，再用原生 resume 打开普通 cmd。</span></div>}
              {handoffError && <div className='handoff-error' role='alert'>{handoffError}</div>}
            </section>}</div>
          {view === 'attention' && <AttentionCenter sessions={sessions} approvals={approvals} onReload={reload} onOpenSession={(sessionId) => { setSelectedId(sessionId); setView('overview') }} />}
          {view === 'tokens' && <TokenUsagePage sessions={sessions} />}
          {view === 'audit' && <AuditPage sessions={sessions} onOpenLlmReviewResults={() => { closeOtherOverlays('llm-review'); setLlmReviewInitialView('results'); setShowLlmReviewSettings(true) }} />}
        </section>
      </div>
      <MotionPresence open={Boolean(formMounted)}>{formMounted && <NewAgentForm open={showForm} initialImport={externalImport} onClose={() => setShowForm(false)} onCreated={(workspace, sessionId) => { setActiveWorkspace(workspace); if (sessionId) { setListActiveId(sessionId); setWallActiveId(sessionId); setSelectedId(sessionId); setView('overview') } setShowForm(false); setFormMounted(false); setExternalImport(undefined); void reload() }} />}</MotionPresence>
      <MotionPresence open={Boolean(editingSession)}>{editingSession && <EditAgentForm open={showEditor} session={editingSession} onClose={() => setShowEditor(false)} onSaved={() => { setShowEditor(false); void reload() }} />}</MotionPresence>
      <MotionPresence open={Boolean(continuationSource)}>{continuationSource && <SessionContinuationDialog source={continuationSource} onClose={() => setContinuationSource(undefined)} onCreated={session => { setActiveWorkspace(session.workspace); setListActiveId(session.sessionId); void reload() }} onRemoved={() => { void reload() }} />}</MotionPresence>
      <MotionPresence open={Boolean(bindingTarget)}>{bindingTarget && <SessionBindingDialog key={bindingTarget.session.sessionId + ':' + bindingTarget.mode} session={bindingTarget.session} mode={bindingTarget.mode} onClose={() => setBindingTarget(undefined)} onChanged={() => { void reload() }} />}</MotionPresence>
      <MotionPresence open={Boolean(recoveryChoice)}>{recoveryChoice && <SessionRecoveryDialog session={recoveryChoice} onClose={dismissRecoveryChoice}
        onChoose={choice => {
          const target = recoveryChoice
          dismissRecoveryChoice()
          if (choice === 'retry') void window.agentManager.restartSession(target.sessionId).catch(() => undefined).finally(() => { void reload() })
          else setBindingTarget({ session: target, mode: choice })
        }} />}</MotionPresence>
      <MotionPresence open={Boolean(showApprovalRules)}>{showApprovalRules && <ApprovalRulesDialog onClose={() => setShowApprovalRules(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(showContinueKeywords)}>{showContinueKeywords && <ContinueKeywordDialog onClose={() => setShowContinueKeywords(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(showSessionSafety)}>{showSessionSafety && <SessionSafetyDialog onClose={() => setShowSessionSafety(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(showDingTalkSettings)}>{showDingTalkSettings && <DingTalkSettingsDialog onClose={() => setShowDingTalkSettings(false)} />}</MotionPresence>
      <MotionPresence open={showAppearance}>{showAppearance && <AppearanceSettingsDialog onClose={() => setShowAppearance(false)} />}</MotionPresence>
      <MotionPresence open={showTerminalSettings}>{showTerminalSettings && <TerminalSettingsDialog onClose={() => setShowTerminalSettings(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(showAttentionSoundSettings)}>{showAttentionSoundSettings && <AttentionSoundSettingsDialog onClose={() => setShowAttentionSoundSettings(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(showLlmReviewSettings)}>{showLlmReviewSettings && <LlmReviewSettingsDialog initialView={llmReviewInitialView} onClose={() => setShowLlmReviewSettings(false)} />}</MotionPresence>
      <MotionPresence open={Boolean(fullAutoSession)}>{fullAutoSession && <ApprovalModeDialog onConfigureReviewer={() => { setFullAutoSessionId(undefined); setLlmReviewInitialView('settings'); setShowLlmReviewSettings(true) }} session={fullAutoSession} onClose={() => setFullAutoSessionId(undefined)} onChanged={() => { void reload() }} />}</MotionPresence>
    </main>
  )
}
