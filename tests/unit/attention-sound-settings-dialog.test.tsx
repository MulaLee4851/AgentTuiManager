// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AttentionSoundSettingsDialog from '../../src/AttentionSoundSettingsDialog'
import type { AgentManagerApi } from '../../src/shared/manager-api'

let api: Pick<AgentManagerApi, 'getAttentionSoundSettings' | 'updateAttentionSoundSettings' | 'testAttentionSound'>
beforeEach(() => {
  api = { getAttentionSoundSettings: vi.fn(async () => ({ sound: 'soft' as const, volume: 40 })), updateAttentionSoundSettings: vi.fn(async settings => settings), testAttentionSound: vi.fn(async () => undefined) }
  window.agentManager = api as AgentManagerApi
})
afterEach(cleanup)

async function open(): Promise<ReturnType<typeof vi.fn>> {
  const close = vi.fn()
  render(<AttentionSoundSettingsDialog onClose={close} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
  return close
}

describe('attention sound settings dialog', () => {
  it('loads settings, previews unsaved choices and saves only when requested', async () => {
    const close = await open()
    expect(screen.getByLabelText('声音类型')).toHaveValue('soft')
    expect(screen.getByRole('slider')).toHaveValue('40')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    fireEvent.change(screen.getByLabelText('声音类型'), { target: { value: 'bell' } })
    fireEvent.change(screen.getByRole('slider'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: '试听' }))
    await waitFor(() => expect(api.testAttentionSound).toHaveBeenCalledWith({ sound: 'bell', volume: 25 }))
    expect(api.updateAttentionSoundSettings).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(api.updateAttentionSoundSettings).toHaveBeenCalledWith({ sound: 'bell', volume: 25 })
  })
  it('shows mute feedback and restores defaults as a draft', async () => {
    await open()
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '试听' }))
    await screen.findByText('当前音量为 0%，试听已静音。')
    expect(api.testAttentionSound).toHaveBeenCalledWith({ sound: 'soft', volume: 0 })
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(screen.getByLabelText('声音类型')).toHaveValue('classic')
    expect(screen.getByRole('slider')).toHaveValue('100')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(api.updateAttentionSoundSettings).not.toHaveBeenCalled()
  })
  it('keeps failed saves open with the selected settings', async () => {
    const close = await open()
    vi.mocked(api.updateAttentionSoundSettings).mockRejectedValueOnce(new Error('无法保存设置'))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存设置')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByLabelText('声音类型')).toHaveValue('soft')
  })
  it('prevents accidental overwrites after loading fails', async () => {
    vi.mocked(api.getAttentionSoundSettings).mockRejectedValueOnce(new Error('读取失败'))
    render(<AttentionSoundSettingsDialog onClose={vi.fn()} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '试听' })).toBeDisabled()
  })
})
