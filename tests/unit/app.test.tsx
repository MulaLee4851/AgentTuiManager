// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentManagerApi, NativeSessionSummary, SessionSummary } from '../../src/shared/manager-api'

const terminalMocks = vi.hoisted(() => ({
  cols: 80, rows: 24, open: vi.fn(), write: vi.fn(), resize: vi.fn(), paste: vi.fn(), dispose: vi.fn(),
  options: { fontSize: 12 },
  modes: { bracketedPasteMode: true }, hasSelection: vi.fn(() => false), getSelection: vi.fn(() => ''),
  scrollToBottom: vi.fn(), scrollLines: vi.fn(), scrollToLine: vi.fn(),
  buffer: { active: { type: 'normal', baseY: 0, viewportY: 0 } },
  attachCustomKeyEventHandler: vi.fn(), attachCustomWheelEventHandler: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })), onScroll: vi.fn(() => ({ dispose: vi.fn() })),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminalMocks) }))

import { Terminal } from '@xterm/xterm'
import App from '../../src/App'
import { isTerminalProtocolResponse } from '../../src/TerminalTile'

const session: SessionSummary = {
  sessionId: 'session-1', displayName: 'Codex API 重构', agentKind: 'codex', workspace: 'B:\\projects\\api',
  status: 'running', recoveryAttempts: 0, userStopRequested: false,
}

describe('App terminal wall', () => {
  it('recognizes terminal protocol replies that Codex Host already answered', () => {
    expect(isTerminalProtocolResponse('\x1b[1;1R')).toBe(true)
    expect(isTerminalProtocolResponse('\x1b[?1;2c')).toBe(true)
    expect(isTerminalProtocolResponse('continue\r')).toBe(false)
  })

  afterEach(cleanup)
  let api: AgentManagerApi

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    api = {
      listSessions: vi.fn(async () => [session]), startSession: vi.fn(), write: vi.fn(), resize: vi.fn(),
      terminalReplay: vi.fn(async () => ({ data: '', sequence: 0 })),
      listAuditEntries: vi.fn(async () => []),
      exportAuditEntries: vi.fn(async () => undefined),
      listPendingApprovals: vi.fn(async () => []), approveRequest: vi.fn(), approveAndRememberRequest: vi.fn(), rejectRequest: vi.fn(),
      approveAllPending: vi.fn(async () => ({ approved: 0, skipped: 0, failed: 0, skippedRequestIds: [] })),
      stopSession: vi.fn(), approveSession: vi.fn(), chooseWorkspace: vi.fn(async () => 'B:\\chosen\\workspace'), subscribe: vi.fn(() => () => undefined),
      restartSession: vi.fn(), continueSession: vi.fn(), tryRecoveryOnce: vi.fn(), removeSession: vi.fn(), detachSession: vi.fn(),
      renameSession: vi.fn(),
      updateSessionConfig: vi.fn(),
      updateSessionProxy: vi.fn(),
      setFullAutoMode: vi.fn(),
      listCCSwitchProviders: vi.fn(async () => []),
      getContinueKeywordSettings: vi.fn(async () => ({ enabled: false, quietSeconds: 10, keywords: [] })),
      updateContinueKeywordSettings: vi.fn(async (settings) => settings),
      getSessionSafetySettings: vi.fn(async () => ({ preserveWorkspaceOnCrash: true })),
      updateSessionSafetySettings: vi.fn(async (settings) => settings),
      getDingTalkSettings: vi.fn(async () => ({ enabled: false, hasClientSecret: false, allowedWorkspaces: [], commandsPerMinute: 20, bindingKey: 'key', agentModeEnabled: false, hasAgentApiKey: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897, hasAgentProxyPassword: false, connectionStatus: 'disabled' as const })),
      updateDingTalkSettings: vi.fn(async (settings) => ({ ...settings, hasClientSecret: Boolean(settings.clientSecret), connectionStatus: settings.enabled ? 'connected' : 'disabled' })),
      resetDingTalkBinding: vi.fn(async () => ({ enabled: false, hasClientSecret: false, allowedWorkspaces: [], commandsPerMinute: 20, bindingKey: 'new-key', agentModeEnabled: false, hasAgentApiKey: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897, hasAgentProxyPassword: false })),
      acceptRecoverySuggestion: vi.fn(), dismissRecoverySuggestion: vi.fn(),
      acceptApprovalSuggestion: vi.fn(), dismissApprovalSuggestion: vi.fn(),
      listApprovalRules: vi.fn(async () => ['git log --oneline']), addApprovalRule: vi.fn(), removeApprovalRule: vi.fn(),
      readClipboardText: vi.fn(async () => 'const pasted = true'),
      writeClipboardText: vi.fn(async () => undefined),
      discoverSessions: vi.fn(async () => [{ id: 'codex-1', title: '修复登录流程', updatedAt: 1_786_000_000_000, workspace: 'B:\\chosen\\workspace' }]),
      detectAgentEnvironment: vi.fn(async (agentKind, executable) => ({
        agentKind, executable, packageName: '@openai/codex', nodeAvailable: true, npmAvailable: true,
        nodeVersion: 'v22.0.0', npmVersion: '10.0.0', agentInstalled: true, executableVersion: 'codex 1.0.0',
      })),
      chooseExecutable: vi.fn(async () => 'B:\\tools\\codex.cmd'),
      installNodeAndNpm: vi.fn(),
      installAgent: vi.fn(),
    }
    window.agentManager = api
  })

  it('shows one real session tile and navigates to a single detail view', async () => {
    render(<App />)
    expect(await screen.findByText('Codex API 重构')).toBeInTheDocument()
    expect(screen.getByText('B:\\projects\\api')).toBeInTheDocument()
    expect(document.querySelector('.app-title small')).toHaveTextContent('全部工作区')
    const tile = screen.getByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('运行中')).toBeInTheDocument()
    await waitFor(() => expect(Terminal).toHaveBeenCalledTimes(1))
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)

    fireEvent.click(tile)
    expect(screen.getByRole('button', { name: '返回总览' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent 总览' })).not.toBeInTheDocument()
    expect(Terminal).toHaveBeenCalledTimes(1)
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument())
    expect(Terminal).toHaveBeenCalledTimes(1)
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)
    expect(terminalMocks.scrollToBottom).not.toHaveBeenCalled()
  })

  it('switches Agent list mode without recreating mounted terminals', async () => {
    const claudeSession: SessionSummary = {
      ...session,
      sessionId: 'session-2',
      displayName: 'Claude 文档整理',
      agentKind: 'claude',
      status: 'needs_approval',
      workspace: 'B:\\projects\\docs',
    }
    vi.mocked(api.listSessions).mockResolvedValue([session, claudeSession])
    render(<App />)
    const firstTile = await screen.findByTestId('terminal-tile-session-1')
    const secondTile = await screen.findByTestId('terminal-tile-session-2')
    expect(Terminal).toHaveBeenCalledTimes(2)
    expect(firstTile).not.toHaveClass('terminal-card-hidden')
    expect(secondTile).not.toHaveClass('terminal-card-hidden')
    expect(within(document.querySelector('.sidebar') as HTMLElement).queryByRole('button', { name: /api/ })).not.toBeInTheDocument()

    const modeSwitch = screen.getByRole('group', { name: 'Agent 显示模式' })
    fireEvent.click(within(modeSwitch).getByRole('button', { name: /列表/ }))
    expect(firstTile).not.toHaveClass('terminal-card-hidden')
    expect(secondTile).toHaveClass('terminal-card-hidden')
    expect(screen.getByLabelText('Agent 列表')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '切换到 Claude 文档整理' }))
    expect(firstTile).toHaveClass('terminal-card-hidden')
    expect(secondTile).not.toHaveClass('terminal-card-hidden')
    expect(Terminal).toHaveBeenCalledTimes(2)

    const workspaceSwitch = screen.getByRole('switch', { name: '按工作区划分' })
    fireEvent.click(workspaceSwitch)
    expect(workspaceSwitch).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: '切换到 Claude 文档整理' })).not.toBeInTheDocument()
    expect(firstTile).not.toHaveClass('terminal-card-hidden')
    expect(secondTile).toHaveClass('terminal-card-hidden')
    expect(within(document.querySelector('.sidebar') as HTMLElement).getByRole('button', { name: /api/ })).toBeInTheDocument()
    expect(Terminal).toHaveBeenCalledTimes(2)

    fireEvent.click(workspaceSwitch)
    expect(screen.getByRole('button', { name: '切换到 Claude 文档整理' })).toBeInTheDocument()
    expect(Terminal).toHaveBeenCalledTimes(2)

    fireEvent.click(within(modeSwitch).getByRole('button', { name: /总览/ }))
    expect(firstTile).not.toHaveClass('terminal-card-hidden')
    expect(secondTile).not.toHaveClass('terminal-card-hidden')
    expect(Terminal).toHaveBeenCalledTimes(2)
  })

  it('shows one compact placeholder while an external terminal hovers over the overview', async () => {
    const listeners: Array<Parameters<AgentManagerApi['subscribe']>[0]> = []
    vi.mocked(api.subscribe).mockImplementation((listener) => { listeners.push(listener); return () => undefined })
    render(<App />)
    await screen.findByText('Codex API 重构')

    act(() => {
      for (const listener of listeners) listener({
        type: 'external-terminal-drag',
        projection: {
          transactionId: 'native-drop-1',
          phase: 'hovering',
          terminalTitle: 'Codex',
          terminalKind: 'windows-terminal',
          suggestedAgentKind: 'codex',
        },
      })
    })

    expect(screen.getAllByTestId('handoff-placeholder')).toHaveLength(1)
    expect(screen.getByTestId('handoff-placeholder')).toHaveTextContent('请稍后…')
  })

  it('opens a prefilled migration drawer when automatic external handoff needs confirmation', async () => {
    const listeners: Array<Parameters<AgentManagerApi['subscribe']>[0]> = []
    vi.mocked(api.subscribe).mockImplementation((listener) => { listeners.push(listener); return () => undefined })
    render(<App />)
    await screen.findByText('Codex API 重构')

    act(() => {
      for (const listener of listeners) listener({
        type: 'external-terminal-drag',
        projection: {
          transactionId: 'native-drop-2',
          phase: 'dropped',
          terminalTitle: 'Codex',
          terminalKind: 'windows-terminal',
          suggestedAgentKind: 'codex',
          suggestedWorkspace: 'B:\\chosen\\workspace',
          suggestedNativeSessionId: 'codex-1',
          issue: '来源窗口安全校验未通过，请在原终端正常退出后确认迁入',
        },
      })
    })

    expect(await screen.findByRole('heading', { name: '添加 Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '迁移外部会话' })).toHaveClass('active')
    expect(screen.getByText('来源窗口安全校验未通过，请在原终端正常退出后确认迁入')).toBeInTheDocument()
    expect(screen.getByDisplayValue('B:\\chosen\\workspace')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '迁入 Manager' })).toBeEnabled())
  })

  it('restores the overview mode, workspace grouping, and selected workspace after remount', async () => {
    const claudeSession: SessionSummary = {
      ...session,
      sessionId: 'session-2',
      displayName: 'Claude 文档整理',
      agentKind: 'claude',
      workspace: 'B:/projects/docs/',
    }
    vi.mocked(api.listSessions).mockResolvedValue([session, claudeSession])
    render(<App />)
    await screen.findByText('Codex API 重构')

    fireEvent.click(within(screen.getByRole('group', { name: 'Agent 显示模式' })).getByRole('button', { name: /列表/ }))
    fireEvent.click(screen.getByRole('switch', { name: '按工作区划分' }))
    fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByRole('button', { name: /docs/ }))
    await waitFor(() => expect(window.localStorage.getItem('agent-tui-manager:overview-preferences:v1')).toContain('B:/projects/docs/'))

    cleanup()
    render(<App />)
    await screen.findByRole('button', { name: '切换到 Claude 文档整理' })
    expect(within(screen.getByRole('group', { name: 'Agent 显示模式' })).getByRole('button', { name: /列表/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('switch', { name: '按工作区划分' })).toHaveAttribute('aria-checked', 'true')
    expect(document.querySelector('.app-title small')).toHaveTextContent('B:/projects/docs/')
    expect(screen.getByLabelText('Agent 列表')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '切换到 Codex API 重构' })).not.toBeInTheDocument()
  })

  it('approves a pending Agent directly from its overview tile', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([{
      ...session, status: 'needs_approval',
    }])
    render(<App />)
    const tile = await screen.findByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('待授权')).toBeInTheDocument()
    fireEvent.click(within(tile).getByRole('button', { name: '批准' }))
    expect(api.approveSession).toHaveBeenCalledWith('session-1')
    expect(screen.getByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument()
  })

  it('edits the Agent display name while keeping identity fields locked', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: '编辑 Codex API 重构' }))
    expect(screen.getByRole('heading', { name: '编辑 Agent' })).toBeInTheDocument()
    const name = screen.getByLabelText('显示名称')
    expect(name).toBeEnabled()
    expect(screen.getByDisplayValue('B:\\projects\\api')).toBeDisabled()
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Codex 当前类型/ })).toBeDisabled()
    fireEvent.change(name, { target: { value: '新的 Agent 名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('session-1', '新的 Agent 名称'))
    expect(api.updateSessionConfig).toHaveBeenCalledWith('session-1', { enabled: false, source: 'local' })
  })

  it('allows saving the same Agent again after a successful edit', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: '编辑 Codex API 重构' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.updateSessionConfig).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '编辑 Agent' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '编辑 Codex API 重构' }))
    const save = screen.getByRole('button', { name: '保存修改' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(api.updateSessionConfig).toHaveBeenCalledTimes(2))
  })

  it('edits an independent Agent configuration without exposing the saved API key', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([{
      ...session,
      agentConfig: {
        enabled: true, source: 'custom', profileId: 'profile-1', baseUrl: 'https://gateway.example/v1',
        model: 'model-old', extraArgs: ['--compact'], hasApiKey: true,
      },
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: '编辑 Codex API 重构' }))
    fireEvent.click(screen.getByRole('button', { name: '独立配置' }))
    expect(screen.getByLabelText('编辑独立配置')).toBeChecked()
    expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', '已安全保存，留空保持不变')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-new' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.updateSessionConfig).toHaveBeenCalledWith('session-1', {
      enabled: true,
      source: 'custom',
      baseUrl: 'https://gateway.example/v1',
      model: 'model-new',
      extraArgs: ['--compact'],
    }))
  })

  it('opens a notification popover without leaving the current view and approves one request', async () => {
    vi.mocked(api.listPendingApprovals).mockResolvedValue([{
      requestId: 'approval-1',
      sessionId: session.sessionId,
      displayName: session.displayName,
      agentKind: session.agentKind,
      workspace: session.workspace,
      source: 'claude-hook',
      risk: 'write',
      toolName: 'Edit',
      command: 'tool:Edit',
      inputSummary: 'B:/projects/api/src/App.tsx',
      reason: '需要人工确认',
      createdAt: 1,
      canBulkApprove: true,
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')

    fireEvent.mouseEnter(screen.getByRole('button', { name: '通知' }))
    const popover = await screen.findByRole('dialog', { name: '通知' })
    expect(screen.getByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument()
    expect(within(popover).getByText('Edit · B:/projects/api/src/App.tsx')).toBeInTheDocument()
    expect(within(popover).queryByRole('button', { name: '关闭通知' })).not.toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(popover).not.toHaveClass('is-visible')
    fireEvent.focus(screen.getByRole('button', { name: '通知' }))
    expect(popover).toHaveClass('is-visible')
    fireEvent.click(within(popover).getByRole('button', { name: '批准' }))
    await waitFor(() => expect(api.approveRequest).toHaveBeenCalledWith('approval-1'))
  })

  it('rejects a request directly from the notification popover', async () => {
    vi.mocked(api.listPendingApprovals).mockResolvedValue([{
      requestId: 'approval-reject', sessionId: session.sessionId, displayName: session.displayName,
      agentKind: session.agentKind, workspace: session.workspace, source: 'claude-hook',
      risk: 'write', toolName: 'Edit', command: 'tool:Edit', reason: '需要人工确认',
      createdAt: 1, canBulkApprove: true,
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.mouseEnter(screen.getByRole('button', { name: '通知' }))
    const popover = await screen.findByRole('dialog', { name: '通知' })
    fireEvent.click(within(popover).getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(api.rejectRequest).toHaveBeenCalledWith('approval-reject'))
  })

  it('requires explicit risk confirmation before enabling full-auto mode', async () => {
    render(<App />)
    const tile = await screen.findByTestId('terminal-tile-session-1')
    fireEvent.click(within(tile).getByRole('button', { name: '全自动' }))
    const dialog = screen.getByRole('dialog', { name: '开启全自动模式' })
    const enable = within(dialog).getByRole('button', { name: '开启全自动模式' })
    expect(enable).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(enable).toBeEnabled()
    fireEvent.click(enable)
    await waitFor(() => expect(api.setFullAutoMode).toHaveBeenCalledWith('session-1', true))
  })

  it('approves and remembers a safe custom tool from the global attention center', async () => {
    vi.mocked(api.listPendingApprovals).mockResolvedValue([{
      requestId: 'inspect-1',
      sessionId: session.sessionId,
      displayName: session.displayName,
      agentKind: 'claude',
      workspace: session.workspace,
      source: 'claude-hook',
      risk: 'unknown',
      toolName: 'InspectResource',
      command: 'tool:InspectResource',
      inputSummary: 'resource: project metadata',
      reason: '工具尚未被识别',
      createdAt: 1,
      canBulkApprove: false,
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /处理中心/ }))
    fireEvent.click(await screen.findByRole('button', { name: '作为安全命令批准' }))
    await waitFor(() => expect(api.approveAndRememberRequest).toHaveBeenCalledWith('inspect-1'))
  })

  it('requires two backdrop clicks to close the Agent drawer and preserves its form', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '保留的 Agent 名称' } })
    const backdrop = document.querySelector('.launcher-scrim')
    expect(backdrop).not.toBeNull()

    fireEvent.mouseDown(backdrop!)
    expect(screen.getByText('再点击一次空白处关闭，已填写内容会保留')).toBeInTheDocument()
    fireEvent.mouseDown(backdrop!)
    expect(screen.getByRole('heading', { name: '添加 Agent' })).toBeInTheDocument()
    fireEvent.doubleClick(backdrop!)
    expect(screen.queryByRole('heading', { name: '添加 Agent' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    expect(screen.getByLabelText('显示名称')).toHaveValue('保留的 Agent 名称')
  })

  it('starts one Agent with an opt-in manual independent configuration', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => expect(screen.getByLabelText('工作区')).toHaveValue('B:\\chosen\\workspace'))
    fireEvent.click(screen.getByRole('button', { name: '独立配置' }))
    fireEvent.click(screen.getByRole('switch', { name: '启用独立配置' }))
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-value' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-x' } })
    fireEvent.change(screen.getByLabelText('启动参数（每行一个）'), { target: { value: '--reasoning\nhigh' } })
    fireEvent.click(screen.getByRole('button', { name: '启动 Agent' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: {
        enabled: true,
        source: 'custom',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'secret-value',
        model: 'model-x',
        extraArgs: ['--reasoning', 'high'],
      },
    })))
  })

  it('offers one-click installation for a missing Agent CLI and rechecks the environment', async () => {
    const detect = vi.mocked(api.detectAgentEnvironment!)
    detect.mockResolvedValueOnce({
      agentKind: 'codex', executable: 'codex', packageName: '@openai/codex',
      nodeAvailable: true, npmAvailable: true, nodeVersion: 'v22.0.0', npmVersion: '10.0.0', agentInstalled: false,
    }).mockResolvedValue({
      agentKind: 'codex', executable: 'codex', packageName: '@openai/codex',
      nodeAvailable: true, npmAvailable: true, nodeVersion: 'v22.0.0', npmVersion: '10.0.0',
      agentInstalled: true, executableVersion: 'codex 1.0.0',
    })
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(await screen.findByRole('button', { name: '一键安装 Agent CLI' }))
    await waitFor(() => expect(api.installAgent).toHaveBeenCalledWith('codex', 'configured'))
    expect(await screen.findByText('环境已就绪，可以创建 Agent。')).toBeInTheDocument()
  })

  it('uses the system picker for an Agent executable outside PATH', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByText('高级设置'))
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    await waitFor(() => expect(api.chooseExecutable).toHaveBeenCalledWith('codex'))
    expect(screen.getByDisplayValue('B:\\tools\\codex.cmd')).toBeInTheDocument()
  })

  it('starts one Agent with an independent HTTP proxy while keeping model configuration local', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => expect(screen.getByLabelText('工作区')).not.toHaveValue(''))
    fireEvent.click(screen.getByRole('button', { name: '独立配置' }))
    expect(screen.getByRole('switch', { name: '启用独立配置' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: '启用 HTTP 代理' }))
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: '启动 Agent' }))

    await waitFor(() => expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: { enabled: false, source: 'local' },
      agentProxy: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 8080 },
    })))
  })

  it('opens and saves disabled-by-default Continue keyword rules', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue 规则' })[0]!)
    expect(await screen.findByRole('heading', { name: 'Continue 关键词' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '启用关键词 Continue' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: '启用关键词 Continue' }))
    fireEvent.change(screen.getByLabelText('Continue 关键词列表'), { target: { value: 'model busy\nconnection lost' } })
    fireEvent.change(screen.getByLabelText('Continue 静默等待秒数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(api.updateContinueKeywordSettings).toHaveBeenCalledWith({
      enabled: true,
      quietSeconds: 8,
      keywords: ['model busy', 'connection lost'],
    }))
  })

  it('selects a CCSwitch provider without exposing its key to the renderer', async () => {
    vi.mocked(api.listCCSwitchProviders).mockResolvedValue([{
      id: 'cc-provider-1', name: 'Team Gateway', agentKind: 'codex',
      baseUrl: 'https://gateway.example/v1', model: 'gpt-5.6',
      isCurrent: true, hasApiKey: true,
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => expect(screen.getByLabelText('工作区')).toHaveValue('B:\\chosen\\workspace'))
    fireEvent.click(screen.getByRole('button', { name: '独立配置' }))
    fireEvent.click(screen.getByRole('switch', { name: '启用独立配置' }))
    fireEvent.click(screen.getByRole('button', { name: /CCSwitch 只读选择本机 Provider/ }))
    expect(await screen.findByText('Team Gateway')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret-value')
    fireEvent.click(screen.getByRole('button', { name: '启动 Agent' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalled())
    expect(vi.mocked(api.startSession).mock.calls.at(-1)?.[0].agentConfig).toEqual({
      enabled: true,
      source: 'ccswitch',
      providerId: 'cc-provider-1',
      providerName: 'Team Gateway',
    })
  })

  it('pastes clipboard text without forwarding Ctrl+V and copies a terminal selection', async () => {
    terminalMocks.hasSelection.mockReturnValue(true)
    terminalMocks.getSelection.mockReturnValue('selected output')
    render(<App />)
    await screen.findByText('Codex API 重构')
    const handler = terminalMocks.attachCustomKeyEventHandler.mock.calls[0]?.[0] as ((event: KeyboardEvent) => boolean)

    expect(handler({ type: 'keydown', key: 'v', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent)).toBe(false)
    await waitFor(() => expect(api.write).toHaveBeenCalledWith('session-1', '\x1b[200~const pasted = true\x1b[201~'))
    expect(terminalMocks.paste).not.toHaveBeenCalled()

    expect(handler({ type: 'keydown', key: 'c', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true } as KeyboardEvent)).toBe(false)
    await waitFor(() => expect(api.writeClipboardText).toHaveBeenCalledWith('selected output'))

    fireEvent.click(screen.getByRole('button', { name: '复制终端内容' }))
    await waitFor(() => expect(api.writeClipboardText).toHaveBeenLastCalledWith('selected output'))

    vi.mocked(api.write).mockClear()
    const largeBlock = '大段文本'.repeat(2_000)
    vi.mocked(api.readClipboardText).mockResolvedValue(largeBlock)
    expect(handler({ type: 'keydown', key: 'v', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent)).toBe(false)
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.write).mock.calls.map((call) => call[1]).join('')).toBe(`\x1b[200~${largeBlock}\x1b[201~`)
  })

  it('preserves the latest Agent scrollback segment when replay contains repeated ED(3) redraws', async () => {
    terminalMocks.write.mockImplementation((...args: unknown[]) => {
      const callback = args[1]
      if (typeof callback === 'function') callback()
    })
    vi.mocked(api.terminalReplay).mockResolvedValue({
      data: 'stale-redraw\x1b[3Jhistory-before\x1b[03Jvisible-screen',
      sequence: 0,
    })

    render(<App />)
    await screen.findByText('Codex API 重构')
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalled())

    const rendered = String(terminalMocks.write.mock.calls[0]?.[0])
    expect(rendered).toContain('stale-redraw\x1b[3J')
    expect(rendered).toContain('history-before')
    expect(rendered).toContain('visible-screen')
    expect(rendered).not.toContain('\x1b[03J')
  })

  it('uses raw PTY replay as the only terminal content source', async () => {
    terminalMocks.write.mockImplementation((...args: unknown[]) => {
      const callback = args[1]
      if (typeof callback === 'function') callback()
    })
    vi.mocked(api.terminalReplay).mockResolvedValue({ data: '\x1b[32m工具调用 · Read\x1b[0m', sequence: 7 })
    render(<App />)
    await screen.findByText('Codex API 重构')
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalled())

    const tile = screen.getByTestId('terminal-tile-session-1')
    expect(tile.querySelector('.terminal-native-history')).toBeNull()
    expect(String(terminalMocks.write.mock.calls[0]?.[0])).toContain('\x1b[32m工具调用 · Read\x1b[0m')
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
  })

  it('scrolls xterm scrollback directly without refreshing history or moving an outer container', async () => {
    terminalMocks.buffer.active.baseY = 40
    terminalMocks.buffer.active.viewportY = 40
    render(<App />)
    await screen.findByText('Codex API 重构')
    const host = screen.getByTestId('terminal-tile-session-1').querySelector('.terminal-live-host')
    expect(host).not.toBeNull()

    host!.dispatchEvent(new WheelEvent('wheel', { deltaY: -72, bubbles: true, cancelable: true }))
    expect(terminalMocks.scrollToLine).toHaveBeenCalledWith(38)
    terminalMocks.buffer.active.baseY = 0
    terminalMocks.buffer.active.viewportY = 0
  })

  it('keeps a user-selected scrollback line pinned while Codex continues repainting', async () => {
    terminalMocks.buffer.active.baseY = 100
    terminalMocks.buffer.active.viewportY = 100
    terminalMocks.write.mockImplementation((...args: unknown[]) => {
      const callback = args[1]
      if (typeof callback === 'function') callback()
    })
    render(<App />)
    await screen.findByText('Codex API 重构')
    const host = screen.getByTestId('terminal-tile-session-1').querySelector('.terminal-live-host')
    host!.dispatchEvent(new WheelEvent('wheel', { deltaY: -72, bubbles: true, cancelable: true }))
    terminalMocks.scrollToLine.mockClear()

    const listeners = vi.mocked(api.subscribe).mock.calls.map((call) => call[0])
    act(() => listeners.at(-1)?.({ type: 'output', sessionId: 'session-1', sequence: 1, data: 'Codex repaint' }))
    await waitFor(() => expect(terminalMocks.scrollToLine).toHaveBeenCalledWith(98))
    terminalMocks.buffer.active.baseY = 0
    terminalMocks.buffer.active.viewportY = 0
  })

  it('reloads the newest approval when another state event arrives during a session read', async () => {
    const listeners: Array<Parameters<AgentManagerApi['subscribe']>[0]> = []
    let resolveIntermediate: ((sessions: SessionSummary[]) => void) | undefined
    vi.mocked(api.subscribe).mockImplementation((listener) => {
      listeners.push(listener)
      return () => undefined
    })
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([session])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveIntermediate = resolve }))
      .mockResolvedValueOnce([{ ...session, status: 'needs_approval', pendingApprovalCommand: 'tool:Write' }])

    render(<App />)
    await screen.findByText('Codex API 重构')
    act(() => listeners.forEach((listener) => listener({ type: 'sessions-changed', sessionId: session.sessionId })))
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2))
    act(() => listeners.forEach((listener) => listener({ type: 'sessions-changed', sessionId: session.sessionId })))
    await act(async () => { resolveIntermediate?.([session]) })

    const tile = await screen.findByTestId('terminal-tile-session-1')
    await waitFor(() => expect(within(tile).getByText('待授权')).toBeInTheDocument())
    expect(api.listSessions).toHaveBeenCalledTimes(3)
  })

  it('accepts or dismisses an approval rule suggestion on the Agent tile', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([{
      ...session, approvalSuggestion: { command: 'git log --oneline', approvalCount: 3 },
    }])
    render(<App />)
    const tile = await screen.findByTestId('terminal-tile-session-1')
    const suggestion = within(tile).getByText(/已手动批准 3 次/)
    expect(suggestion).toBeInTheDocument()
    expect(suggestion).toHaveAttribute('data-tooltip', expect.stringContaining('命令：git log --oneline'))
    fireEvent.click(within(tile).getByRole('button', { name: '加入' }))
    expect(api.acceptApprovalSuggestion).toHaveBeenCalledWith('session-1')
    fireEvent.click(within(tile).getByRole('button', { name: '暂不' }))
    expect(api.dismissApprovalSuggestion).toHaveBeenCalledWith('session-1')
  })

  it('manages exact approval rules from the overview', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: '批准规则' }))
    expect(await screen.findByText('git log --oneline')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('新增批准命令'), { target: { value: 'git show --stat' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(api.addApprovalRule).toHaveBeenCalledWith('git show --stat'))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(api.removeApprovalRule).toHaveBeenCalledWith('git log --oneline'))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the approval rules drawer only on a real double-click of the backdrop', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: '批准规则' }))
    const backdrop = document.querySelector('.modal-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.mouseDown(backdrop!)
    fireEvent.mouseDown(backdrop!)
    expect(screen.getByRole('heading', { name: '自动批准规则' })).toBeInTheDocument()
    fireEvent.doubleClick(backdrop!)
    expect(screen.queryByRole('heading', { name: '自动批准规则' })).not.toBeInTheDocument()
  })

  it('chooses the workspace through the system directory picker', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    const workspace = screen.getByLabelText('工作区')
    expect(workspace).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => expect(workspace).toHaveValue('B:\\chosen\\workspace'))
    expect(window.agentManager.chooseWorkspace).toHaveBeenCalledTimes(1)
    expect(window.agentManager.discoverSessions).toHaveBeenCalledWith('codex', 'B:\\chosen\\workspace')
    expect(await screen.findByText(/修复登录流程/)).toBeInTheDocument()
  })

  it.each([
    ['codex', 'codex-1', ['resume', 'codex-1']],
    ['claude', 'claude-1', ['--resume', 'claude-1']],
  ] as const)('starts a selected %s native session with resume on both initial and recovery hosts', async (kind, id, resumeArgs) => {
    vi.mocked(api.discoverSessions).mockImplementation(async (agentKind, selectedWorkspace) => [{ id, title: `${agentKind} 历史任务`, updatedAt: 1_786_000_000_000, workspace: selectedWorkspace }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.change(screen.getByLabelText('Agent 类型'), { target: { value: kind } })
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() => expect(screen.getByLabelText('历史会话')).toHaveTextContent(`${kind} 历史任务`))
    fireEvent.change(screen.getByLabelText('参数（每行一个）'), { target: { value: '--advanced-must-not-pollute-resume' } })
    fireEvent.change(screen.getByLabelText('历史会话'), { target: { value: id } })
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
    expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: kind, nativeSessionId: id, args: resumeArgs,
      recovery: { executable: kind, args: resumeArgs },
    }))
  })

  it('keeps a selected history session while configuring the Agent', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复历史' }))
    const history = await screen.findByRole('button', { name: /修复登录流程/ })
    fireEvent.click(history)
    expect(history).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '独立配置' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'codex-1', args: ['resume', 'codex-1'] })))

  })

  it('toggles off a selected history session and starts a new session', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复历史' }))
    const sameHistory = await screen.findByRole('button', { name: /修复登录流程/ })
    fireEvent.click(sameHistory)
    fireEvent.click(sameHistory)
    expect(sameHistory).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: '启动 Agent' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSessionId: expect.anything() })))
  })

  it.each(['pi', 'generic'] as const)('explains that %s history discovery is unsupported', async (kind) => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    fireEvent.change(screen.getByLabelText('Agent 类型'), { target: { value: kind } })
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByText('该 Agent 暂不支持自动读取历史会话')).toBeInTheDocument()
  })

  it('does not let an older discovery request overwrite a newer workspace', async () => {
    let resolveOld: ((sessions: NativeSessionSummary[]) => void) | undefined
    vi.mocked(api.chooseWorkspace).mockResolvedValueOnce('B:\\old').mockResolvedValueOnce('B:\\new')
    vi.mocked(api.discoverSessions)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce([{ id: 'new', title: '新的工作区任务', updatedAt: 2, workspace: 'B:\\new' }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }))
    const choose = screen.getByRole('button', { name: '选择文件夹' })
    fireEvent.click(choose)
    await waitFor(() => expect(api.discoverSessions).toHaveBeenCalledWith('codex', 'B:\\old'))
    fireEvent.click(choose)
    expect(await screen.findByText(/新的工作区任务/)).toBeInTheDocument()
    resolveOld?.([{ id: 'old', title: '旧结果不应出现', updatedAt: 1, workspace: 'B:\\old' }])
    await waitFor(() => expect(screen.queryByText(/旧结果不应出现/)).not.toBeInTheDocument())
  })

  it('hides xterm after stop and offers restart or removal', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([{ ...session, status: 'stopped', userStopRequested: true }])
    render(<App />)
    const tile = await screen.findByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('Agent 已停止')).toBeInTheDocument()
    expect(Terminal).not.toHaveBeenCalled()
    const restart = within(tile).getByRole('button', { name: '重新启动' })
    fireEvent.click(restart)
    await waitFor(() => expect(restart).toBeEnabled())
    fireEvent.click(within(tile).getByRole('button', { name: '删除' }))
    expect(api.restartSession).toHaveBeenCalledWith('session-1')
    expect(api.removeSession).toHaveBeenCalledWith('session-1')
  })

  it('shows removal progress and a readable error on a stopped Agent', async () => {
    let rejectRemoval: ((reason: Error) => void) | undefined
    vi.mocked(api.listSessions).mockResolvedValue([{ ...session, status: 'stopped', userStopRequested: true }])
    vi.mocked(api.removeSession).mockImplementation(() => new Promise((_, reject) => { rejectRemoval = reject }))
    render(<App />)
    const tile = await screen.findByTestId('terminal-tile-session-1')
    fireEvent.click(within(tile).getByRole('button', { name: '删除' }))
    expect(within(tile).getByRole('button', { name: '请稍后…' })).toBeDisabled()
    await act(async () => rejectRemoval?.(new Error('删除失败，请重试')))
    expect(await within(tile).findByText('删除失败，请重试')).toHaveClass('terminal-ended-error')
    expect(within(tile).getByRole('button', { name: '删除' })).toBeEnabled()
  })

  it('opens the audit page alone and returns to the overview', async () => {
    vi.mocked(api.listAuditEntries).mockResolvedValue([
      {
        id: 'audit-1', timestamp: Date.now(), level: 'info', category: 'session',
        action: 'session_started', message: 'Codex API 重构 已启动', sessionId: 'session-1',
        details: { displayName: 'Codex API 重构', workspace: 'B:\\projects\\api', agentKind: 'codex' },
      },
      {
        id: 'audit-2', timestamp: Date.now() - 40 * 86_400_000, level: 'warning', category: 'rule',
        action: 'rule_removed', message: '已撤销自动批准规则',
      },
    ])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /审计$/ }))
    expect(await screen.findByRole('heading', { name: '活动审计' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent 总览' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Codex API 重构 已启动')).toHaveLength(2)
    expect(screen.getByText('已撤销自动批准规则')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '审计时间' }), { target: { value: '24h' } })
    expect(screen.queryByText('已撤销自动批准规则')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '审计 Agent' }), { target: { value: 'session-1' } })
    expect(screen.getAllByText('Codex API 重构 已启动')).toHaveLength(2)
    fireEvent.change(screen.getByRole('combobox', { name: '审计工作区' }), { target: { value: 'b:\\projects\\api' } })
    expect(screen.getByRole('combobox', { name: '审计工作区' })).toHaveValue('b:\\projects\\api')
    expect(screen.getAllByText('Codex API 重构 已启动')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Agent 总览/ }))
    expect(await screen.findByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument()
  })

  it('renders large audit histories in pages of fifty rows', async () => {
    vi.mocked(api.listAuditEntries).mockResolvedValue(Array.from({ length: 120 }, (_, index) => ({
      id: `audit-${index}`, timestamp: Date.now() - index, level: 'info' as const, category: 'session' as const,
      action: 'session_event', message: `审计事件 ${index}`,
    })))
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /审计$/ }))
    expect(await screen.findByText('共 120 条 · 第 1/3 页')).toBeInTheDocument()
    expect(screen.getAllByText('审计事件 0')).toHaveLength(2)
    expect(screen.queryByText('审计事件 50')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('共 120 条 · 第 2/3 页')).toBeInTheDocument()
    expect(screen.getAllByText('审计事件 50')).toHaveLength(2)
    expect(screen.queryByText('审计事件 0')).not.toBeInTheDocument()
  })
})
