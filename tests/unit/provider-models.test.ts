import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { fetchProviderModels, modelsEndpoint } from '../../electron/provider-models'

vi.mock('axios', () => ({ default: { get: vi.fn(), isAxiosError: (e: unknown) => Boolean(e && typeof e === 'object' && 'isAxiosError' in e) } }))
describe('Provider 模型查询', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([
    ['https://example.com', 'https://example.com/v1/models'],
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['http://localhost:1234/api/v1', 'http://localhost:1234/api/v1/models'],
    ['https://example.com/v1/models', 'https://example.com/v1/models'],
    ['https://example.com/v1/chat/completions/', 'https://example.com/v1/models'],
  ])('normalizes %s', (base, expected) => expect(modelsEndpoint(base)).toBe(expected))
  it.each(['file:///tmp/key', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com?', 'https://example.com#', 'https://example.com/\nv1'])('rejects unsafe address %s', base => expect(() => modelsEndpoint(base)).toThrow())
  it('uses bounded authenticated request and deduplicates model ids', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }, {}] } })
    expect(await fetchProviderModels('https://example.com/v1', 'test-key')).toEqual(['a', 'z'])
    expect(axios.get).toHaveBeenCalledWith('https://example.com/v1/models', expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer test-key' }, timeout: 15000,
      maxRedirects: 0, maxContentLength: 512 * 1024, maxBodyLength: 512 * 1024,
    }))
  })
  it.each([undefined, '', '   '])('supports local unauthenticated catalogs with key %s', async apiKey => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'local-model' }] } })
    await expect(fetchProviderModels('http://localhost:1234', apiKey)).resolves.toEqual(['local-model'])
    expect(axios.get).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({ headers: { Accept: 'application/json' } }))
  })
  it.each(['fake\r\nkey', 'fake\u202ekey', 'x'.repeat(16_385)])('rejects an unsafe API key without issuing a request', async apiKey => {
    await expect(fetchProviderModels('https://example.com', apiKey)).rejects.toMatchObject({ code: 'configuration' })
    expect(axios.get).not.toHaveBeenCalled()
  })
  it('drops echoed credentials and unsafe or oversized model identifiers', async () => {
    const apiKey = '  fake/key:for-test  '
    const echoed = [apiKey, apiKey.trim(), 'model-' + apiKey.trim(), encodeURIComponent(apiKey.trim()), Buffer.from(apiKey.trim()).toString('base64')]
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [
      ...echoed.map(id => ({ id })), { id: 'bad\nmodel' }, { id: 'bad\u202emodel' }, { id: 'x'.repeat(201) }, { id: 'safe-model' },
    ] } })
    await expect(fetchProviderModels('https://example.com', apiKey)).resolves.toEqual(['safe-model'])
  })
  it('does not expose response bodies or secrets on failure', async () => {
    vi.mocked(axios.get).mockRejectedValue({ isAxiosError: true, response: { status: 401, data: 'secret' } })
    await expect(fetchProviderModels('https://example.com')).rejects.toMatchObject({ code: 'authentication' })
    await expect(fetchProviderModels('https://example.com')).rejects.not.toThrow('secret')
  })
  it.each([{}, { data: [] }, '<html>login</html>', { data: Array.from({ length: 2_001 }, () => ({ id: 'model' })) }])('rejects unsupported or empty lists', async data => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data })
    await expect(fetchProviderModels('https://example.com')).rejects.toThrow()
  })
  it.each([[302, 'http'], [401, 'authentication'], [429, 'rate-limit'], [500, 'http']])('sanitizes HTTP %s errors', async (status, code) => {
    vi.mocked(axios.get).mockResolvedValue({ status, data: 'fake-api-key', headers: { location: 'https://other.example/fake-api-key' } })
    const error: unknown = await fetchProviderModels('https://example.com', 'fake-api-key').catch(value => value)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('fake-api-key')
    expect(error).not.toHaveProperty('response')
    expect(error).not.toHaveProperty('cause')
  })
  it('never exposes unknown request errors', async () => {
    vi.mocked(axios.get).mockRejectedValue(Object.assign(new Error('fake-api-key'), { config: { headers: { Authorization: 'Bearer fake-api-key' } } }))
    const error: unknown = await fetchProviderModels('https://example.com', 'fake-api-key').catch(value => value)
    expect(error).toMatchObject({ code: 'network' })
    expect(String(error)).not.toContain('fake-api-key')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('cause')
  })
})
