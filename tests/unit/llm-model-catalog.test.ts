import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listLlmReviewModels, LlmModelCatalogError, resolveLlmApiEndpoint, safeLlmApiError } from '../../electron/llm-model-catalog'
import type { StoredLlmReviewSettings } from '../../electron/llm-review-settings-store'

vi.mock('axios', () => ({ default: {
  get: vi.fn(),
  isAxiosError: (value: unknown) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError),
} }))

// Deliberately fake credentials. No environment, credential files or network access.
const settings: StoredLlmReviewSettings = {
  enabled: false, level: 'high', baseUrl: 'https://model.example/v1', apiKey: 'fake-catalog-api-key',
  retryCount: 0, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
  proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
}

describe('LLM model catalog', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'review-model' }] } })
  })

  it.each([
    ['https://model.example', 'https://model.example/v1/models'],
    ['https://model.example/', 'https://model.example/v1/models'],
    ['https://model.example/api', 'https://model.example/api/models'],
    ['https://model.example/chat/completions', 'https://model.example/models'],
    ['https://model.example/models/', 'https://model.example/models'],
    ['https://model.example/v1///', 'https://model.example/v1/models'],
    ['https://model.example/v1/chat/completions/', 'https://model.example/v1/models'],
    ['https://model.example/custom/models/', 'https://model.example/custom/models'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/models'],
  ])('fetches from the configured API prefix: %s', async (baseUrl, expected) => {
    await expect(listLlmReviewModels({ ...settings, baseUrl })).resolves.toEqual(['review-model'])
    expect(axios.get).toHaveBeenCalledWith(expected, expect.objectContaining({
      headers: { Authorization: 'Bearer fake-catalog-api-key', Accept: 'application/json' },
      proxy: false, timeout: 30_000, maxContentLength: 512 * 1024, maxBodyLength: 512 * 1024, maxRedirects: 0,
    }))
  })

  it('normalizes the matching chat endpoint for callers sharing the same prefix', () => {
    expect(resolveLlmApiEndpoint('https://model.example/v1/models', 'chat/completions')).toBe('https://model.example/v1/chat/completions')
    expect(resolveLlmApiEndpoint('https://model.example', 'chat/completions')).toBe('https://model.example/v1/chat/completions')
  })

  it.each([
    '', 'not-a-url', 'file:///tmp/models', 'https://fake-user:fake-password@model.example/v1',
    'https://model.example/v1?key=fake-query-key', 'https://model.example/v1#fake-fragment-key',
    'https://model.example/v1?', 'https://model.example/v1#', 'https://model.example/\nv1',
  ])('rejects unsafe or missing base URLs without sending credentials: %s', async baseUrl => {
    await expect(listLlmReviewModels({ ...settings, baseUrl })).rejects.toMatchObject({ code: 'configuration' })
    expect(axios.get).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   ', 'fake\r\nkey'])('requires a nonempty safe API key', async apiKey => {
    await expect(listLlmReviewModels({ ...settings, apiKey })).rejects.toMatchObject({ code: 'configuration' })
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('uses the configured HTTP proxy and keeps its credentials in the request only', async () => {
    await expect(listLlmReviewModels({
      ...settings, proxyEnabled: true, proxyHost: 'proxy.example', proxyPort: 8080,
      proxyUsername: 'fake-proxy-user', proxyPassword: 'fake-proxy-password',
    })).resolves.toEqual(['review-model'])
    expect(axios.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ proxy: {
      protocol: 'http', host: 'proxy.example', port: 8080,
      auth: { username: 'fake-proxy-user', password: 'fake-proxy-password' },
    } }))
  })

  it.each([
    { proxyHost: 'fake-user:fake-password@proxy.example' }, { proxyHost: 'proxy.example/path' },
    { proxyHost: 'proxy.example?fake-secret' }, { proxyHost: 'proxy.example:8080' }, { proxyHost: 'proxy.example:80' },
    { proxyPort: 0 }, { proxyPort: 65_536 },
  ])('rejects invalid proxy settings before issuing a request', async overrides => {
    await expect(listLlmReviewModels({ ...settings, proxyEnabled: true, ...overrides })).rejects.toMatchObject({ code: 'configuration' })
    expect(axios.get).not.toHaveBeenCalled()
  })

  it.each([[600, 60_000], [0, 1_000], [Number.NaN, 30_000]])('bounds catalog timeout for %s seconds', async (timeoutSeconds, timeout) => {
    await listLlmReviewModels({ ...settings, timeoutSeconds })
    expect(axios.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout }))
  })

  it('returns only unique valid model IDs, preserving provider order', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [
      { id: 'review-b', other: 'untrusted-provider-content' }, { id: ' review-a ' }, { id: 'review-b' },
      { id: '' }, { id: '   ' }, { id: 'bad\nmodel' }, { id: 'bad\u007fmodel' }, { id: 'bad\u0085model' },
      { id: 'bad\u202emodel' }, { id: 'bad\u2028model' }, { id: 'x'.repeat(201) }, { id: 123 }, {}, null, ['model'],
    ], apiKey: 'fake-catalog-api-key' } })
    await expect(listLlmReviewModels(settings)).resolves.toEqual(['review-b', 'review-a'])
  })

  it('filters echoed API/proxy credentials including substrings and trimmed or encoded variants', async () => {
    const apiKey = '  fake/key:for-test  '
    const proxyPassword = '  fake/proxy:for-test  '
    const echoed = [apiKey, apiKey.trim(), `model-${apiKey.trim()}`, proxyPassword, proxyPassword.trim(),
      `prefix-${proxyPassword.trim()}-suffix`, encodeURIComponent(apiKey.trim()),
      Buffer.from(proxyPassword.trim()).toString('base64'), Buffer.from(`fake-user:${proxyPassword}`).toString('base64')]
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [...echoed.map(id => ({ id })), { id: 'safe-model' }] } })
    await expect(listLlmReviewModels({ ...settings, apiKey, proxyUsername: 'fake-user', proxyPassword })).resolves.toEqual(['safe-model'])
  })

  it.each([null, '', [], {}, { models: [] }, { data: {} }, { data: Array.from({ length: 2_001 }, () => ({ id: 'model' })) }])(
    'rejects malformed or oversized catalogs with a fixed error', async data => {
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data })
      await expect(listLlmReviewModels(settings)).rejects.toMatchObject({ code: 'invalid-response' })
    },
  )

  it('allows an empty catalog', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [] } })
    await expect(listLlmReviewModels(settings)).resolves.toEqual([])
  })

  it.each([[302, 'http'], [401, 'authentication'], [403, 'authentication'], [429, 'rate-limit'], [500, 'http']])(
    'rejects HTTP %s without returning body, redirect location, or credentials', async (status, code) => {
      vi.mocked(axios.get).mockResolvedValue({ status, data: { message: 'fake-catalog-api-key' }, headers: { location: 'https://other.example/fake-catalog-api-key' } })
      const error: unknown = await listLlmReviewModels(settings).catch(value => value)
      expect(error).toMatchObject({ code })
      expect(String(error)).not.toContain('fake-catalog-api-key')
      expect(error).not.toHaveProperty('response')
      expect(error).not.toHaveProperty('cause')
      expect(axios.get).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    [{ isAxiosError: true, code: 'ECONNABORTED' }, 'timeout'],
    [{ isAxiosError: true, code: 'ETIMEDOUT' }, 'timeout'],
    [{ isAxiosError: true, response: { status: 401, data: 'fake-catalog-api-key' } }, 'authentication'],
    [{ isAxiosError: true, code: 'ENOTFOUND' }, 'network'],
    [new Error('fake-catalog-api-key'), 'network'],
  ])('never propagates upstream error details', async (failure, code) => {
    vi.mocked(axios.get).mockRejectedValue(Object.assign(failure, {
      message: 'fake-catalog-api-key fake-proxy-password', config: { headers: { Authorization: 'Bearer fake-catalog-api-key' } },
    }))
    const error: unknown = await listLlmReviewModels(settings).catch(value => value)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toMatch(/fake-catalog-api-key|fake-proxy-password/u)
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('cause')
  })

  it('rebuilds even recognized errors so mutated messages cannot escape through shared sanitization', () => {
    const upstream = new LlmModelCatalogError('http')
    upstream.message = 'fake-catalog-api-key'
    const safe = safeLlmApiError(upstream)
    expect(safe).toMatchObject({ code: 'http' })
    expect(safe.message).not.toContain('fake-catalog-api-key')
    expect(safe).not.toBe(upstream)
  })
})
