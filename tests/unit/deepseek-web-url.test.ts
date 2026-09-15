import { expect, it } from 'vitest'
import { deepSeekWebUrl } from '../../src/shared/deepseek-web-url'
import { createAgentAdapter } from '../../electron/agent-adapters'

it('retains the official token exchange URL and waits for split output to finish', () => {
  const adapter = createAgentAdapter('deepseek')
  const url = 'http://127.0.0.1:43127/?token=' + 'a'.repeat(43)
  expect(adapter.observeOutput('dsh web: ' + url.slice(0, -10)).webUrl).toBeUndefined()
  expect(adapter.observeOutput(url.slice(-10) + '\r\n').webUrl).toBe(url)
  expect(deepSeekWebUrl('http://127.0.0.1:43127')).toBe('http://127.0.0.1:43127')
})

it('rejects external, malformed and non-root URLs', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:3@evil.test/', 'http://127.0.0.1:70000',
    'http://127.0.0.1:0', 'http://127.0.0.1:3333/redirect', 'http://127.0.0.1:3333/?next=https://evil.test']) {
    expect(deepSeekWebUrl(url)).toBeUndefined()
  }
})
