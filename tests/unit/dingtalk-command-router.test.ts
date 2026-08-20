import { describe, expect, it, vi } from 'vitest'

import { DingTalkCommandRouter } from '../../electron/dingtalk-command-router'
import type { StoredDingTalkSettings } from '../../electron/dingtalk-settings-store'
import type { ApprovalRequest, SessionSummary } from '../../src/shared/manager-api'

const settings: StoredDingTalkSettings = {
  enabled: true,
  clientId: 'id',
  clientSecret: 'secret',
  allowedWorkspaces: ['B:/allowed'],
  commandsPerMinute: 20,
  boundStaffId: 'staff-1', agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false, agentProxyHost: '127.0.0.1', agentProxyPort: 7897,
}

function createRouter(overrides: Partial<{
  sessions: SessionSummary[]
  approvals: ApprovalRequest[]
  settings: StoredDingTalkSettings
}> = {}) {
  const sessions = overrides.sessions ?? [{ sessionId: 'session-12345678', displayName: 'Code Agent', status: 'running', agentKind: 'codex', workspace: 'B:/allowed' } as SessionSummary]
  const approvals = overrides.approvals ?? []
  const manager = {
    listSessions: vi.fn(() => sessions),
    listPendingApprovals: vi.fn(() => approvals),
    terminalReplay: vi.fn(() => ({ data: '\u001b[32mhello\u001b[0m\r\n', sequence: 1 })),
    approveRequest: vi.fn(),
    approveAllPending: vi.fn(() => ({ approved: 1, skipped: 0, failed: 0, skippedRequestIds: [] })),
    write: vi.fn(),
    stopSession: vi.fn(async () => undefined),
    restartSession: vi.fn(async () => undefined),
    setFullAutoMode: vi.fn(async () => undefined),
  }
  const audit = { list: vi.fn(() => []), record: vi.fn() }
  const bind = vi.fn(async () => true)
  const router = new DingTalkCommandRouter(manager, audit, () => overrides.settings ?? settings, bind)
  return { router, manager, audit, bind }
}

describe('DingTalkCommandRouter', () => {
  it('rejects non-command messages and unauthorized staff', async () => {
    const { router } = createRouter()
    await expect(router.execute('hello', { staffId: 'staff-1' })).resolves.toContain('只接受 /')
    await expect(router.execute('/agents', { staffId: 'other' })).resolves.toBe('没有权限使用此机器人。')
  })

  it('binds an unbound bot with /init and rejects ordinary commands before binding', async () => {
    const unbound = { ...settings, boundStaffId: undefined, bindingKey: 'abc' }
    const { router, bind } = createRouter({ settings: unbound })
    await expect(router.execute('/agents', { staffId: 'staff-1' })).resolves.toContain('尚未绑定')
    await expect(router.execute('/init abc', { staffId: 'staff-1', senderName: 'Tester' })).resolves.toContain('绑定成功')
    expect(bind).toHaveBeenCalledWith('abc', 'staff-1', 'Tester')
  })

  it('filters agents by workspace and supports status, tail, and send', async () => {
    const { router, manager } = createRouter({ sessions: [
      { sessionId: 'allowed-1234', displayName: 'Allowed', status: 'running', agentKind: 'codex', workspace: 'B:/allowed' } as SessionSummary,
      { sessionId: 'blocked-1234', displayName: 'Blocked Claude', status: 'running', agentKind: 'claude', workspace: 'B:/blocked' } as SessionSummary,
    ] })
    await expect(router.execute('/agents', { staffId: 'staff-1' })).resolves.toContain('Allowed')
    await expect(router.execute('/agents', { staffId: 'staff-1' })).resolves.toContain('Blocked Claude')
    await expect(router.execute('/status allowed-', { staffId: 'staff-1' })).resolves.toContain('状态：running')
    await expect(router.execute('/status blocked-', { staffId: 'staff-1' })).resolves.toContain('不在允许的工作区')
    await expect(router.execute('/tail Allowed', { staffId: 'staff-1' })).resolves.toContain('hello')
    await expect(router.execute('/send Allowed hi', { staffId: 'staff-1' })).resolves.toContain('已向 Allowed 发送消息')
    expect(manager.write).toHaveBeenNthCalledWith(1, 'allowed-1234', 'hi')
    expect(manager.write).toHaveBeenNthCalledWith(2, 'allowed-1234', '\r')
  })

  it('keeps approve-all delegated to the local policy and blocks foreign workspaces', async () => {
    const approval = { requestId: 'approval-1', sessionId: 'session-12345678', displayName: 'Code Agent', agentKind: 'codex', workspace: 'B:/allowed', source: 'terminal', risk: 'read', toolName: 'read', reason: '需要读取文件', createdAt: 1, canBulkApprove: true } as ApprovalRequest
    const { router, manager } = createRouter({ approvals: [approval] })
    await expect(router.execute('/approve approval-1', { staffId: 'staff-1' })).resolves.toContain('已批准')
    await expect(router.execute('/approve-all', { staffId: 'staff-1' })).resolves.toContain('批准完成')
    expect(manager.approveAllPending).toHaveBeenCalledTimes(1)

    const foreign = { ...approval, sessionId: 'foreign-1' }
    const blocked = createRouter({ approvals: [foreign] })
    await expect(blocked.router.execute('/approve-all', { staffId: 'staff-1' })).resolves.toContain('工作区白名单外')
    expect(blocked.manager.approveAllPending).not.toHaveBeenCalled()
  })

  it('turns full-auto mode on and off for a selected allowed Agent', async () => {
    const { router, manager } = createRouter()
    await expect(router.execute('/auto session- on', { staffId: 'staff-1' })).resolves.toContain('已为 Code Agent 开启全自动模式')
    await expect(router.execute('/auto Code Agent off', { staffId: 'staff-1' })).resolves.toContain('已为 Code Agent 关闭全自动模式')
    expect(manager.setFullAutoMode).toHaveBeenNthCalledWith(1, 'session-12345678', true)
    expect(manager.setFullAutoMode).toHaveBeenNthCalledWith(2, 'session-12345678', false)
  })

  it('enforces per-user rate limits', async () => {
    const { router } = createRouter({ settings: { ...settings, commandsPerMinute: 1 } })
    await router.execute('/help', { staffId: 'staff-1' })
    await expect(router.execute('/help', { staffId: 'staff-1' })).resolves.toContain('操作过于频繁')
  })

  it('uses Agent mode only for natural language and routes the result through fixed commands', async () => {
    const interpreter = { translate: vi.fn(async () => '/status Code Agent') }
    const { manager, audit } = createRouter()
    const router = new DingTalkCommandRouter(manager, audit, () => ({ ...settings, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentApiKey: 'secret', agentModel: 'model-x' }), undefined, interpreter as never)
    await expect(router.execute('看看代码 Agent 状态', { staffId: 'staff-1' })).resolves.toContain('状态：running')
    expect(interpreter.translate).toHaveBeenCalledTimes(1)
  })

  it('gives Agent mode the complete Codex and Claude inventory for list and count requests', async () => {
    const interpreter = { translate: vi.fn(async () => '/agents') }
    const sessions = [
      { sessionId: 'codex-12345678', displayName: 'Codex Agent', status: 'running', agentKind: 'codex', workspace: 'B:/allowed' } as SessionSummary,
      { sessionId: 'claude-1234567', displayName: 'Claude Agent', status: 'running', agentKind: 'claude', workspace: 'B:/outside' } as SessionSummary,
    ]
    const { manager, audit } = createRouter({ sessions })
    const router = new DingTalkCommandRouter(manager, audit, () => ({ ...settings, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentApiKey: 'secret', agentModel: 'model-x' }), undefined, interpreter as never)

    await expect(router.execute('现在有几个运行中的 agent', { staffId: 'staff-1' })).resolves.toContain('Claude Agent')
    expect(interpreter.translate).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ sessions }))
  })

  it('executes multiple Agent-mode operations from one natural-language message', async () => {
    const interpreter = { translate: vi.fn(async () => ({
      commands: ['/auto 40f5c044 on', '/auto Review Agent off'],
    })) }
    const sessions = [
      { sessionId: '40f5c044-de04-40ac-b8d3-9b8d98985b60', displayName: 'Code Agent', status: 'running', agentKind: 'codex', workspace: 'B:/allowed' } as SessionSummary,
      { sessionId: 'review-123456789', displayName: 'Review Agent', status: 'running', agentKind: 'claude', workspace: 'B:/allowed' } as SessionSummary,
    ]
    const { manager, audit } = createRouter({ sessions })
    const router = new DingTalkCommandRouter(manager, audit, () => ({ ...settings, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentApiKey: 'secret', agentModel: 'model-x' }), undefined, interpreter as never)

    const result = await router.execute('打开 40f5c044 的全自动模式，关闭 review agent 的全自动模式', { staffId: 'staff-1' })
    expect(result).toContain('已为 Code Agent 开启全自动模式')
    expect(result).toContain('已为 Review Agent 关闭全自动模式')
    expect(manager.setFullAutoMode).toHaveBeenNthCalledWith(1, sessions[0]!.sessionId, true)
    expect(manager.setFullAutoMode).toHaveBeenNthCalledWith(2, sessions[1]!.sessionId, false)
  })

  it('explains why Agent mode could not determine an operation before showing help', async () => {
    const interpreter = { translate: vi.fn(async () => ({
      commands: ['/help'],
      reason: '没有找到用户提到的 Agent',
    })) }
    const { manager, audit } = createRouter()
    const router = new DingTalkCommandRouter(manager, audit, () => ({ ...settings, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentApiKey: 'secret', agentModel: 'model-x' }), undefined, interpreter as never)

    await expect(router.execute('处理那个任务', { staffId: 'staff-1' })).resolves.toContain('未执行：没有找到用户提到的 Agent')
  })
})
