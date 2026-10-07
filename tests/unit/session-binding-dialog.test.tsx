// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SessionBindingDialog from '../../src/SessionBindingDialog'
import type { SessionSummary } from '../../src/shared/manager-api'

afterEach(cleanup)
const session = { sessionId: 'window', displayName: 'My Agent', workspace: 'B:\\work', agentKind: 'claude', status: 'failed' } as SessionSummary
it('requires confirmation before clearing the binding', async () => {
  const replaceSessionBinding = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { replaceSessionBinding } })
  const onClose = vi.fn()
  render(<SessionBindingDialog session={session} mode='fresh' onClose={onClose} onChanged={vi.fn()} />)
  expect(replaceSessionBinding).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('确认开启新会话'))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(replaceSessionBinding).toHaveBeenCalledWith('window', null)
})
it('lists and filters same-workspace history and preserves the dialog on startup failure', async () => {
  const listBindingSessions = vi.fn().mockResolvedValue([{ id: 'new-id', title: 'backend work', workspace: session.workspace, updatedAt: 1 }])
  const replaceSessionBinding = vi.fn().mockRejectedValue(new Error('启动失败，可重试'))
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { replaceSessionBinding, listBindingSessions } })
  const onClose = vi.fn()
  render(<SessionBindingDialog session={session} mode='history' onClose={onClose} onChanged={vi.fn()} />)
  fireEvent.click(await screen.findByText('backend work'))
  fireEvent.click(screen.getByText('关联并启动'))
  await screen.findByText('启动失败，可重试')
  expect(onClose).not.toHaveBeenCalled()
  expect(replaceSessionBinding).toHaveBeenCalledWith('window', 'new-id')
  fireEvent.change(screen.getByLabelText('搜索历史会话'), { target: { value: 'nothing' } })
  expect(screen.queryByText('backend work')).toBeNull()
})

it('requires a separate fresh-session confirmation after leaving the history picker', async () => {
  const replaceSessionBinding = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { replaceSessionBinding, listBindingSessions: vi.fn(async () => []) } })
  render(<SessionBindingDialog session={session} mode='history' onClose={vi.fn()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '按原配置开启新会话' }))
  expect(replaceSessionBinding).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认开启新会话' }))
  await waitFor(() => expect(replaceSessionBinding).toHaveBeenCalledWith('window', null))
})

it('keeps a failed missing-API operation open and contains keyboard focus', async () => {
  Object.defineProperty(window, 'agentManager', { configurable: true, value: {} })
  const onClose = vi.fn()
  render(<SessionBindingDialog session={session} mode='fresh' onClose={onClose} onChanged={vi.fn()} />)
  const confirm = screen.getByRole('button', { name: '确认开启新会话' })
  confirm.focus()
  fireEvent.keyDown(confirm, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭会话切换' }))
  fireEvent.click(confirm)
  await screen.findByRole('alert')
  expect(onClose).not.toHaveBeenCalled()
})

it('offers explicit binding changes without a terminal-only retry for a live abnormal Agent', async () => {
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { listBindingSessions: vi.fn(async () => []) } })
  render(<SessionBindingDialog session={{ ...session, status: 'needs_attention' }} mode='history' onClose={vi.fn()} onChanged={vi.fn()} />)
  expect(screen.queryByRole('button', { name: '继续重试' })).toBeNull()
  expect(screen.getByRole('button', { name: '按原配置开启新会话' })).toBeDefined()
})
