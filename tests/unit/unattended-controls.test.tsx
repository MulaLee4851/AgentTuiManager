// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UnattendedControls from '../../src/UnattendedControls'
import type { SessionSummary } from '../../src/shared/manager-api'

afterEach(cleanup)
describe('unattended risk consent', () => {
  it('saves without enabling and restores the numbers when reopened', async () => {
    const saveUnattendedSettings = vi.fn(async (_id: string, _settings: SessionSummary['unattended']) => undefined)
    const setUnattendedMode = vi.fn(async () => undefined)
    Object.defineProperty(window, 'agentManager', { configurable: true, value: { saveUnattendedSettings, setUnattendedMode } })
    const session = { sessionId: 'a', agentKind: 'codex' } as SessionSummary
    const first = render(<UnattendedControls session={session} onChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('审批后补按 Enter 延迟（秒）'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Enter 发送次数'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('异常恢复尝试次数'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('每轮重试间隔（分钟）'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('配置已保存。点击“开启无监管模式”后开始使用。')
    expect(saveUnattendedSettings).toHaveBeenCalledWith('a', expect.objectContaining({ enabled: false, approvalEnterDelaySeconds: 7, approvalEnterCount: 3, errorRecoveryAttempts: 4, errorRecoveryCooldownMinutes: 2 }))
    expect(setUnattendedMode).not.toHaveBeenCalled()
    first.unmount()
    render(<UnattendedControls session={{ ...session, unattended: saveUnattendedSettings.mock.calls[0]![1] }} onChanged={vi.fn()} />)
    expect(screen.getByLabelText('审批后补按 Enter 延迟（秒）')).toHaveValue(7)
    expect(screen.getByLabelText('Enter 发送次数')).toHaveValue(3)
    expect(screen.getByLabelText('异常恢复尝试次数')).toHaveValue(4)
    expect(screen.getByLabelText('每轮重试间隔（分钟）')).toHaveValue(2)
  })
  it('requires separate high-risk consent and sends settings for this session only', async () => {
    const setUnattendedMode = vi.fn(async () => undefined)
    Object.defineProperty(window, 'agentManager', { configurable: true, value: { setUnattendedMode } })
    render(<UnattendedControls session={{ sessionId: 'a', agentKind: 'codex' } as SessionSummary} onChanged={vi.fn()} />)
    expect(screen.getByRole('button', { name: '开启无监管模式' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Agent 结束词'), { target: { value: 'MY-DONE\n\nALL-DONE\nMY-DONE' } })
    fireEvent.change(screen.getByLabelText('继续提示中使用的结束词'), { target: { value: 'ALL-DONE' } })
    fireEvent.click(screen.getByRole('button', { name: '开启无监管模式' }))
    await waitFor(() => expect(setUnattendedMode).toHaveBeenCalledWith('a', { enabled: true, endWord: 'MY-DONE', endWords: ['MY-DONE', 'ALL-DONE'], recoveryEndWord: 'ALL-DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 5, approvalEnterCount: 1, errorRecoveryAttempts: 3, errorRecoveryCooldownMinutes: 1 }))
  })
})
