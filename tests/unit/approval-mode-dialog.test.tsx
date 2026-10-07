// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApprovalModeDialog from '../../src/ApprovalModeDialog'
import type { ApprovalMode, SessionSummary } from '../../src/shared/manager-api'

afterEach(cleanup)
const session: SessionSummary = { sessionId: 'one', displayName: 'Test Agent', agentKind: 'codex', workspace: 'C:/project', status: 'running', recoveryAttempts: 0, userStopRequested: false, approvalMode: 'rules-auto' }
function setup(mode: ApprovalMode = 'rules-auto') {
  const setApprovalMode = vi.fn().mockResolvedValue(undefined)
  const setUnattendedMode = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { setApprovalMode, setUnattendedMode } })
  const onChanged = vi.fn(), onClose = vi.fn(), onConfigureReviewer = vi.fn()
  render(<ApprovalModeDialog session={{ ...session, approvalMode: mode }} onChanged={onChanged} onClose={onClose} onConfigureReviewer={onConfigureReviewer} />)
  return { setApprovalMode, setUnattendedMode, onChanged, onClose, onConfigureReviewer }
}
describe('runtime approval mode dialog', () => {
  it.each([['普通模式', 'manual'], ['Agent 审核', 'agent-review']] as const)('switches to %s without relaunching the Agent', async (label, value) => {
    const api = setup()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(label) }))
    fireEvent.click(screen.getByRole('button', { name: '切换为' + label }))
    await waitFor(() => expect(api.setApprovalMode).toHaveBeenCalledWith('one', value))
    expect(api.onChanged).toHaveBeenCalledOnce()
    expect(api.onClose).toHaveBeenCalledOnce()
  })
  it('keeps a failed mode change visible', async () => {
    const api = setup()
    api.setApprovalMode.mockRejectedValue(new Error('配置保存失败'))
    fireEvent.click(screen.getByRole('radio', { name: /普通模式/ }))
    fireEvent.click(screen.getByRole('button', { name: '切换为普通模式' }))
    expect((await screen.findByRole('alert')).textContent).toBe('配置保存失败')
    expect(api.onClose).not.toHaveBeenCalled()
  })
  it('only opens reviewer settings on an explicit configure action', () => {
    const api = setup()
    fireEvent.click(screen.getByRole('radio', { name: /Agent 审核/ }))
    fireEvent.click(screen.getByRole('button', { name: '配置审核器' }))
    expect(api.onConfigureReviewer).toHaveBeenCalledOnce()
    expect(api.setApprovalMode).not.toHaveBeenCalled()
  })
  it('selecting unattended alone does not enable it', () => {
    const api = setup()
    fireEvent.click(screen.getByRole('radio', { name: /无监管/ }))
    expect(screen.getByRole('button', { name: '开启无监管模式' }).hasAttribute('disabled')).toBe(true)
    expect(api.setUnattendedMode).not.toHaveBeenCalled()
    expect(api.setApprovalMode).not.toHaveBeenCalled()
  })
})
