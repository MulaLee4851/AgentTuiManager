// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentManagerApi, NativeSessionSummary, SessionSummary } from '../../src/shared/manager-api'

const terminalMocks = vi.hoisted(() => ({
  cols: 80, rows: 24, open: vi.fn(), write: vi.fn(), resize: vi.fn(), paste: vi.fn(), dispose: vi.fn(),
  options: { fontSize: 12 },
  modes: { bracketedPasteMode: true }, hasSelection: vi.fn(() => false), getSelection: vi.fn(() => ''),
  scrollToBottom: vi.fn(),
  buffer: { active: { type: 'normal', baseY: 0 } },
  attachCustomKeyEventHandler: vi.fn(), attachCustomWheelEventHandler: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminalMocks) }))

import { Terminal } from '@xterm/xterm'
import App from '../../src/App'

const session: SessionSummary = {
  sessionId: 'session-1', displayName: 'Codex API 重构', agentKind: 'codex', workspace: 'B:\\projects\\api',
  status: 'running', recoveryAttempts: 0, userStopRequested: false,
}

describe('App terminal wall', () => {
  afterEach(cleanup)
  let api: AgentManagerApi

  beforeEach(() => {
    vi.clearAllMocks()
    api = {
      listSessions: vi.fn(async () => [session]), startSession: vi.fn(), write: vi.fn(), resize: vi.fn(),
      terminalReplay: vi.fn(async () => ({ data: '', sequence: 0 })),
      terminalHistory: vi.fn(async () => ({ entries: [], truncated: false })),
      listAuditEntries: vi.fn(async () => []),
      stopSession: vi.fn(), approveSession: vi.fn(), chooseWorkspace: vi.fn(async () => 'B:\\chosen\\workspace'), subscribe: vi.fn(() => () => undefined),
      restartSession: vi.fn(), continueSession: vi.fn(), tryRecoveryOnce: vi.fn(), removeSession: vi.fn(),
      acceptRecoverySuggestion: vi.fn(), dismissRecoverySuggestion: vi.fn(),
      acceptApprovalSuggestion: vi.fn(), dismissApprovalSuggestion: vi.fn(),
      listApprovalRules: vi.fn(async () => ['git log --oneline']), addApprovalRule: vi.fn(), removeApprovalRule: vi.fn(),
      readClipboardText: vi.fn(async () => 'const pasted = true'),
      writeClipboardText: vi.fn(async () => undefined),
      discoverSessions: vi.fn(async () => [{ id: 'codex-1', title: '修复登录流程', updatedAt: 1_786_000_000_000, workspace: 'B:\\chosen\\workspace' }]),
    }
    window.agentManager = api
  })

  it('shows one real session tile and navigates to a single detail view', async () => {
    render(<App />)
    expect(await screen.findByText('Codex API 重构')).toBeInTheDocument()
    expect(screen.getAllByText('B:\\projects\\api')).toHaveLength(2)
    const tile = screen.getByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('运行中')).toBeInTheDocument()
    expect(Terminal).toHaveBeenCalledTimes(1)
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)

    fireEvent.click(tile)
    expect(screen.getByRole('button', { name: '返回总览' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent 总览' })).not.toBeInTheDocument()
    expect(Terminal).toHaveBeenCalledTimes(1)
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument())
    expect(Terminal).toHaveBeenCalledTimes(1)
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
    expect(window.agentManager.subscribe).toHaveBeenCalledTimes(2)
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

  it('renders native session history above the live terminal surface', async () => {
    vi.mocked(api.terminalHistory).mockResolvedValue({
      entries: [
        { role: 'user', title: '你', text: '检查滚动' },
        { role: 'agent', title: 'Codex', text: '已经完成' },
      ],
      truncated: false,
    })
    render(<App />)
    await screen.findByText('检查滚动', { exact: false })

    const tile = screen.getByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('检查滚动', { exact: false })).toHaveClass('terminal-history-content')
    expect(api.terminalHistory).toHaveBeenCalledWith('session-1')
    expect(terminalMocks.open).toHaveBeenCalledTimes(1)
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
    expect(within(tile).getByText(/已手动批准 3 次/)).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: '启动 Agent' }))
    await waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
    expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: kind, nativeSessionId: id, args: resumeArgs,
      recovery: { executable: kind, args: resumeArgs },
    }))
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
    fireEvent.click(within(tile).getByRole('button', { name: '重新启动' }))
    fireEvent.click(within(tile).getByRole('button', { name: '删除' }))
    expect(api.restartSession).toHaveBeenCalledWith('session-1')
    expect(api.removeSession).toHaveBeenCalledWith('session-1')
  })

  it('opens the audit page alone and returns to the overview', async () => {
    vi.mocked(api.listAuditEntries).mockResolvedValue([{
      id: 'audit-1', timestamp: 1_786_000_000_000, level: 'info', category: 'session',
      action: 'session_started', message: 'Codex API 重构 已启动', sessionId: 'session-1',
    }])
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /审计$/ }))
    expect(await screen.findByRole('heading', { name: '活动审计' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent 总览' })).not.toBeInTheDocument()
    expect(screen.getByText('Codex API 重构 已启动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /返回总览/ }))
    expect(await screen.findByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument()
  })
})
