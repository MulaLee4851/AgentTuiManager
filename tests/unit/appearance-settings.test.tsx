// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppearanceSettingsDialog from '../../src/AppearanceSettingsDialog'
import { AppearanceProvider } from '../../src/appearance-settings'
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../src/shared/appearance-settings'
import type { AgentManagerApi } from '../../src/shared/manager-api'

let changed: (settings: AppearanceSettings) => void
beforeEach(() => {
  window.agentManager = {
    getAppearanceSettings: vi.fn(async () => ({ ...DEFAULT_APPEARANCE_SETTINGS })),
    updateAppearanceSettings: vi.fn(async settings => settings),
    onAppearanceSettingsChanged: vi.fn(listener => { changed = listener; return () => undefined }),
  } as unknown as AgentManagerApi
})
afterEach(() => { cleanup(); document.documentElement.style.fontSize = ''; delete document.documentElement.dataset.uiSize })
const open = async (): Promise<void> => {
  render(<AppearanceProvider><AppearanceSettingsDialog onClose={vi.fn()} /></AppearanceProvider>)
  await waitFor(() => expect(screen.getByRole('radio', { name: /标准/ })).toBeEnabled())
}
describe('appearance settings', () => {
  it('previews and saves independent sizes, and restores both defaults', async () => {
    await open()
    fireEvent.click(screen.getByRole('radio', { name: /紧凑/ }))
    expect(document.documentElement.style.fontSize).toBe('13.6px')
    await waitFor(() => expect(window.agentManager.updateAppearanceSettings).toHaveBeenLastCalledWith({ uiSize: 'compact', terminalFontSize: 'auto' }))
    fireEvent.click(screen.getByRole('radio', { name: /大号/ }))
    expect(document.documentElement.style.fontSize).toBe('20px')
    fireEvent.change(screen.getByLabelText('终端文字大小'), { target: { value: '16' } })
    await waitFor(() => expect(window.agentManager.updateAppearanceSettings).toHaveBeenLastCalledWith({ uiSize: 'large', terminalFontSize: 16 }))
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(window.agentManager.updateAppearanceSettings).toHaveBeenLastCalledWith(DEFAULT_APPEARANCE_SETTINGS))
    expect(document.documentElement.style.fontSize).toBe('16px')
  })
  it('keeps the latest preview while older saves complete and ignores their events', async () => {
    let finish!: (settings: AppearanceSettings) => void
    vi.mocked(window.agentManager.updateAppearanceSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await open()
    fireEvent.click(screen.getByRole('radio', { name: /大号/ }))
    await waitFor(() => expect(window.agentManager.updateAppearanceSettings).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('radio', { name: /舒适/ }))
    act(() => changed({ uiSize: 'large', terminalFontSize: 'auto' }))
    expect(screen.getByRole('radio', { name: /舒适/ })).toBeChecked()
    await act(async () => finish({ uiSize: 'large', terminalFontSize: 'auto' }))
    await waitFor(() => expect(window.agentManager.updateAppearanceSettings).toHaveBeenCalledTimes(2))
    expect(document.documentElement.style.fontSize).toBe('17.6px')
  })
  it('offers retry after a save failure without silently claiming persistence', async () => {
    vi.mocked(window.agentManager.updateAppearanceSettings).mockRejectedValueOnce(new Error('fixture disk unavailable'))
    await open()
    fireEvent.click(screen.getByRole('radio', { name: /大号/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('当前仅为预览')
    fireEvent.click(screen.getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument())
  })
  it('blocks changes after a failed load, then retries reading', async () => {
    vi.mocked(window.agentManager.getAppearanceSettings).mockRejectedValueOnce(new Error('fixture load failure'))
    render(<AppearanceProvider><AppearanceSettingsDialog onClose={vi.fn()} /></AppearanceProvider>)
    await screen.findByRole('alert')
    expect(screen.getByRole('radio', { name: /大号/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /大号/ })).toBeEnabled())
    expect(window.agentManager.updateAppearanceSettings).not.toHaveBeenCalled()
  })
})
