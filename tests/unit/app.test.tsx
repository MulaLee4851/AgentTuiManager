// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentManagerApi, NativeSessionSummary, SessionSummary } from '../../src/shared/manager-api'

const terminalMocks = vi.hoisted(() => ({
  open: vi.fn(), write: vi.fn(), dispose: vi.fn(), onData: vi.fn(() => ({ dispose: vi.fn() })),
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
      stopSession: vi.fn(), approveSession: vi.fn(), chooseWorkspace: vi.fn(async () => 'B:\\chosen\\workspace'), subscribe: vi.fn(() => () => undefined),
      discoverSessions: vi.fn(async () => [{ id: 'codex-1', title: '修复登录流程', updatedAt: 1_786_000_000_000, workspace: 'B:\\chosen\\workspace' }]),
    }
    window.agentManager = api
  })

  it('shows one real session tile and navigates to a single detail view', async () => {
    render(<App />)
    expect(await screen.findByText('Codex API 重构')).toBeInTheDocument()
    expect(screen.getByText('B:\\projects\\api')).toBeInTheDocument()
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

  it('chooses the workspace through the system directory picker', async () => {
    render(<App />)
    await screen.findByText('Codex API 重构')
    fireEvent.click(screen.getByRole('button', { name: /新增 Agent/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /新增 Agent/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /新增 Agent/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /新增 Agent/ }))
    const choose = screen.getByRole('button', { name: '选择文件夹' })
    fireEvent.click(choose)
    await waitFor(() => expect(api.discoverSessions).toHaveBeenCalledWith('codex', 'B:\\old'))
    fireEvent.click(choose)
    expect(await screen.findByText(/新的工作区任务/)).toBeInTheDocument()
    resolveOld?.([{ id: 'old', title: '旧结果不应出现', updatedAt: 1, workspace: 'B:\\old' }])
    await waitFor(() => expect(screen.queryByText(/旧结果不应出现/)).not.toBeInTheDocument())
  })
})
