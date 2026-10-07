// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalSettingsDialog from '../../src/TerminalSettingsDialog'
import type { AgentManagerApi } from '../../src/shared/manager-api'

beforeEach(() => {
  window.agentManager = {
    getTerminalSettings: vi.fn(async () => ({ codexMode: 'native-fullscreen' })),
    updateTerminalSettings: vi.fn(async settings => settings),
  } as unknown as AgentManagerApi
})
afterEach(cleanup)
describe('terminal settings dialog', () => {
  it('edits a draft, persists on save and never restarts a running session', async () => {
    const close = vi.fn()
    render(<TerminalSettingsDialog onClose={close} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('Codex 原生模式（默认）')
    expect(screen.getByRole('button', { name: '高级设置' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用兼容模式' }))
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    expect(screen.getByRole('status')).toHaveTextContent('所选模式：兼容模式')
    expect(window.agentManager.updateTerminalSettings).not.toHaveBeenCalled()
    expect(screen.getByText(/正在运行的会话保持当前模式/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(window.agentManager.updateTerminalSettings).toHaveBeenCalledWith({ codexMode: 'scrollback' })
  })
  it('does not save on cancel and restores keyboard focus', async () => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
    const close = vi.fn()
    const view = render(<TerminalSettingsDialog onClose={close} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
    expect(screen.getByRole('dialog')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '保存设置' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(window.agentManager.updateTerminalSettings).not.toHaveBeenCalled()
    view.unmount(); expect(trigger).toHaveFocus(); trigger.remove()
  })
  it('keeps failed saves open and prevents overwrites after a load failure', async () => {
    vi.mocked(window.agentManager.getTerminalSettings).mockRejectedValueOnce(new Error('读取失败'))
    const first = render(<TerminalSettingsDialog onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled()
    first.unmount()
    vi.mocked(window.agentManager.updateTerminalSettings).mockRejectedValueOnce(new Error('保存失败'))
    const close = vi.fn(); render(<TerminalSettingsDialog onClose={close} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
    expect(close).not.toHaveBeenCalled()
  })
})
