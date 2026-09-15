// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DeepSeekStartupOutput, { startupOutputText } from '../../src/DeepSeekStartupOutput'
import type { AgentManagerApi } from '../../src/shared/manager-api'

afterEach(cleanup)

it('reads only when asked and preserves the DSH browser token', async () => {
  const replay = vi.fn(async () => ({ data: '\x1b[31mdsh web: http://127.0.0.1:1234/?token=private-token\x1b[0m\r\n', sequence: 1 }))
  window.agentManager = { terminalReplay: replay } as unknown as AgentManagerApi
  render(<DeepSeekStartupOutput sessionId='demo' />)
  expect(replay).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '查看启动输出' }))
  expect(await screen.findByLabelText('DeepSeek 启动输出')).toHaveTextContent('token=private-token')
  expect(replay).toHaveBeenCalledTimes(1)
  expect(replay).toHaveBeenCalledWith('demo')
})

it('limits diagnostic text and redacts credential lines', () => {
  expect(startupOutputText('API_KEY=secret\nAuthorization: Bearer secret')).not.toContain('secret')
  expect(startupOutputText('x'.repeat(20000))).toHaveLength(16000)
})
