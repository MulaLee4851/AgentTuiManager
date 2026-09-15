// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UnattendedControls from '../../src/UnattendedControls'
import type { SessionSummary } from '../../src/shared/manager-api'

afterEach(cleanup)
describe('unattended risk consent', () => {
  it('saves without enabling and restores the numbers when reopened', async () => {
    const saveUnattendedSettings = vi.fn(async () => undefined)
    const setUnattendedMode = vi.fn(async () => undefined)
    Object.defineProperty(window, 'agentManager', { configurable: true, value: { saveUnattendedSettings, setUnattendedMode } })
    const session = { sessionId: 'a', agentKind: 'codex' } as SessionSummary
    const first = render(<UnattendedControls session={session} onChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('审批后补按 Enter 延迟（秒）'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Enter 发送次数'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('配置已保存，未开启无监管。关闭再打开设置仍会保留。')
    expect(saveUnattendedSettings).toHaveBeenCalledWith('a', expect.objectContaining({ enabled: false, approvalEnterDelaySeconds: 7, approvalEnterCount: 3 }))
    expect(setUnattendedMode).not.toHaveBeenCalled()
    first.unmount()
    render(<UnattendedControls session={{ ...session, unattended: { enabled: false, endWord: 'TASK-DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 7, approvalEnterCount: 3 } }} onChanged={vi.fn()} />)
    expect(screen.getByLabelText('审批后补按 Enter 延迟（秒）')).toHaveValue(7)
    expect(screen.getByLabelText('Enter 发送次数')).toHaveValue(3)
  })
  it('requires separate high-risk consent and sends settings for this session only', async () => {
    const setUnattendedMode = vi.fn(async () => undefined)
    Object.defineProperty(window, 'agentManager', { configurable: true, value: { setUnattendedMode } })
    render(<UnattendedControls session={{ sessionId: 'a', agentKind: 'codex' } as SessionSummary} onChanged={vi.fn()} />)
    expect(screen.getByRole('button', { name: '开启无监管模式' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Agent 结束词'), { target: { value: 'MY-DONE\n\nALL-DONE\nMY-DONE' } })
    fireEvent.change(screen.getByLabelText('拼接到恢复提示的结束词'), { target: { value: 'ALL-DONE' } })
    fireEvent.click(screen.getByRole('button', { name: '开启无监管模式' }))
    await waitFor(() => expect(setUnattendedMode).toHaveBeenCalledWith('a', { enabled: true, endWord: 'MY-DONE', endWords: ['MY-DONE', 'ALL-DONE'], recoveryEndWord: 'ALL-DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 5, approvalEnterCount: 1 }))
  })
})
