import { describe, expect, it } from 'vitest'

import { assertLlmResponseHasNoCredentials } from '../../electron/llm-response-privacy'

const credentials = { apiKey: 'fake-review-key', proxyUsername: 'fake-user', proxyPassword: 'fake-proxy-password' }

describe('parsed LLM response credential protection', () => {
  it.each([
    '{"summary":"\\u0066ake-review-key"}',
    '{"findings":[{"recommendation":"prefix-\\u0066ake-proxy-password-suffix"}]}',
    '{"reasons":["\\u0066\\u0061ke-review-key"]}',
    '{"\\u0066ake-review-key":"other text"}',
  ])('rejects decoded credentials even when JSON escaping hides their raw spelling', content => {
    expect(content).not.toContain(credentials.apiKey)
    expect(content).not.toContain(credentials.proxyPassword)
    expect(() => assertLlmResponseHasNoCredentials(JSON.parse(content), credentials)).toThrow('受保护凭据')
  })

  it('accepts ordinary review fields and does not mutate them', () => {
    const value = { verdict: 'allow', riskScore: 0, summary: '目标明确', reasons: ['只读操作'], hazards: [], assumptions: [] }
    const before = JSON.stringify(value)
    expect(() => assertLlmResponseHasNoCredentials(value, credentials)).not.toThrow()
    expect(JSON.stringify(value)).toBe(before)
  })

  it.each([
    'fake/key:test', 'prefix-fake/key:test-suffix', encodeURIComponent('fake/key:test'),
    Buffer.from('fake/key:test').toString('base64'), Buffer.from('fake-user:fake/key:test').toString('base64'),
  ])('blocks trimmed and encoded known credentials in nested parsed strings', echoed => {
    expect(() => assertLlmResponseHasNoCredentials({ findings: [{ issue: echoed }] }, {
      proxyUsername: 'fake-user', proxyPassword: '  fake/key:test  ',
    })).toThrow('受保护凭据')
  })

  it('returns only a fixed error without attaching the response or credentials', () => {
    let failure: unknown
    try { assertLlmResponseHasNoCredentials({ summary: credentials.apiKey }, credentials) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(credentials.apiKey)
    expect(failure).not.toHaveProperty('cause')
    expect(failure).not.toHaveProperty('response')
    expect(failure).not.toHaveProperty('config')
  })

  it('handles absent secrets and repeated object references', () => {
    const value: { child?: unknown; summary: string } = { summary: 'plain response' }
    value.child = value
    expect(() => assertLlmResponseHasNoCredentials(value, {})).not.toThrow()
    expect(() => assertLlmResponseHasNoCredentials(value, credentials)).not.toThrow()
  })
})
