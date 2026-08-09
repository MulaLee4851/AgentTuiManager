// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentManagerApi, SessionSummary } from '../../src/shared/manager-api'

const terminalMocks = vi.hoisted(() => ({
  open: vi.fn(), write: vi.fn(), dispose: vi.fn(), onData: vi.fn(() => ({ dispose: vi.fn() })),
}))

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminalMocks) }))

import App from '../../src/App'

const session: SessionSummary = {
  sessionId: 'session-1', displayName: 'Codex API 重构', agentKind: 'codex', workspace: 'B:\\projects\\api',
  status: 'running', recoveryAttempts: 0, userStopRequested: false,
}

describe('App terminal wall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const api: AgentManagerApi = {
      listSessions: vi.fn(async () => [session]), startSession: vi.fn(), write: vi.fn(), resize: vi.fn(),
      stopSession: vi.fn(), subscribe: vi.fn(() => () => undefined),
    }
    window.agentManager = api
  })

  it('shows one real session tile and navigates to a single detail view', async () => {
    render(<App />)
    expect(await screen.findByText('Codex API 重构')).toBeInTheDocument()
    expect(screen.getByText('B:\\projects\\api')).toBeInTheDocument()
    const tile = screen.getByTestId('terminal-tile-session-1')
    expect(within(tile).getByText('运行中')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看 Codex API 重构' }))
    expect(screen.getByRole('button', { name: '返回总览' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent 总览' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Agent 总览' })).toBeInTheDocument())
  })
})
