import axios from 'axios'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmReviewerPoolError, LlmSecurityReviewer } from '../../electron/llm-security-reviewer'
import { CliSecurityReviewer } from '../../electron/cli-security-reviewer'
import { LlmReviewSettingsStore, type StoredLlmReviewer, type StoredLlmReviewSettings } from '../../electron/llm-review-settings-store'
import { importLlmReviewer } from '../../electron/llm-reviewer-import'
import { listLlmReviewModels } from '../../electron/llm-model-catalog'
import type { ApprovalRequest, LlmReviewSettingsInput } from '../../src/shared/manager-api'

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn(), isAxiosError: (value: unknown) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError) } }))
const codec = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() }
const base: StoredLlmReviewSettings = { enabled: true, level: 'high', retryCount: 3, timeoutSeconds: 30, overallTimeoutSeconds: 120,
  scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24, proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897 }
const entry = (id: string, overrides: Partial<StoredLlmReviewer> = {}): StoredLlmReviewer => ({ id, name: id, enabled: true, backend: 'api', protocol: 'openai-chat',
  baseUrl: `https://${id}.example/v1`, apiKey: `fictional-key-${id}`, model: `model-${id}`, ...overrides })
const request: ApprovalRequest = { requestId: 'r', sessionId: 's', displayName: 'fixture', agentKind: 'codex', workspace: '/fictional-workspace',
  source: 'codex-hook', risk: 'unknown', reason: 'fixture', createdAt: 1, canBulkApprove: false, command: 'echo ok' }
const allowed = { verdict: 'allow', riskScore: 1, summary: 'safe fixture', reasons: [], hazards: [], assumptions: [] }
const chat = (value: unknown) => ({ status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] } })

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())

describe('ordered reviewer pool', () => {
  it('fails over service and malformed output A -> B -> C, skipping disabled entries without retrying A', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response: { status: 503, data: 'fictional-key-A' } })
      .mockResolvedValueOnce(chat({ invalid: true })).mockResolvedValueOnce(chat(allowed))
    const result = await new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A'), entry('disabled', { enabled: false }), entry('B'), entry('C')] })
    expect(result).toMatchObject({ verdict: 'allow', model: 'model-C', requiresHumanApproval: false })
    expect(result).toMatchObject({ reviewerId: 'C', reviewerName: 'C', attempts: [
      { reviewerId: 'A', status: 'failed', failure: 'http' },
      { reviewerId: 'B', status: 'failed', failure: 'invalid-response' },
      { reviewerId: 'C', status: 'completed' },
    ] })
    expect(vi.mocked(axios.post).mock.calls.map(call => call[0])).toEqual(['https://a.example/v1/chat/completions', 'https://b.example/v1/chat/completions', 'https://c.example/v1/chat/completions'])
  })
  it.each(['deny', 'manual', 'uncertain'])('stops on a valid %s, with exactly one final denial', async verdict => {
    vi.mocked(axios.post).mockResolvedValue(chat({ ...allowed, verdict }))
    const result = await new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B')] })
    expect(result).toMatchObject({ verdict: 'deny', requiresHumanApproval: false })
    expect(axios.post).toHaveBeenCalledTimes(1)
  })
  it('supports API to CLI failover', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('fictional service down'))
    const cli = new CliSecurityReviewer()
    vi.spyOn(cli, 'complete').mockResolvedValue(JSON.stringify(allowed))
    const result = await new LlmSecurityReviewer(cli).reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B', { backend: 'codex-cli', cliModel: 'cli-review-model' })] })
    expect(result.model).toBe('codex-cli:cli-review-model')
  })
  it('does not approve a legacy allow that also requests human authorization', async () => {
    vi.mocked(axios.post).mockResolvedValue(chat({ ...allowed, requiresHumanApproval: true }))
    expect(await new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B')] })).toMatchObject({ verdict: 'deny', requiresHumanApproval: false })
    expect(axios.post).toHaveBeenCalledTimes(1)
  })
  it('releases cancelled API slots so the third service remains usable after two timeouts', async () => {
    vi.useFakeTimers()
    vi.mocked(axios.post).mockImplementationOnce(() => new Promise(() => {})).mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(chat(allowed))
    const result = new LlmSecurityReviewer().reviewApproval(request, { ...base, timeoutSeconds: 1, overallTimeoutSeconds: 5, reviewers: [entry('A'), entry('B'), entry('C')] })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(result).resolves.toMatchObject({ verdict: 'allow', model: 'model-C' })
    expect(axios.post).toHaveBeenCalledTimes(3)
  })
  it('bounds the entire review even when a CLI does not finish its shutdown', async () => {
    vi.useFakeTimers()
    const cli = new CliSecurityReviewer()
    const complete = vi.spyOn(cli, 'complete').mockImplementation(() => new Promise(() => {}))
    const result = new LlmSecurityReviewer(cli).reviewApproval(request, { ...base, timeoutSeconds: 3, overallTimeoutSeconds: 5,
      reviewers: [entry('A', { backend: 'codex-cli' }), entry('B', { backend: 'claude-cli' }), entry('C')] })
    const rejected = expect(result).rejects.toThrow('时限')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls.every(call => call[5]?.aborted)).toBe(true)
    expect(axios.post).not.toHaveBeenCalled()
  })
  it('has bounded overall time even when transports ignore cancellation and discards late allows', async () => {
    vi.useFakeTimers()
    const completions: ((value: unknown) => void)[] = []
    vi.mocked(axios.post).mockImplementation(() => new Promise(resolve => completions.push(resolve)))
    const reviewer = new LlmSecurityReviewer()
    const pending = reviewer.reviewApproval(request, { ...base, timeoutSeconds: 5, overallTimeoutSeconds: 8, reviewers: [entry('A'), entry('B'), entry('C')] })
    const rejected = expect(pending).rejects.toThrow(/时限/)
    await vi.advanceTimersByTimeAsync(5000)
    expect(axios.post).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    completions.forEach(resolve => resolve(chat(allowed)))
    await vi.runAllTimersAsync()
    expect(axios.post).toHaveBeenCalledTimes(2)
  })
  it('aborts immediately and never advances to the next service after cancellation', async () => {
    const cancel = new AbortController()
    vi.mocked(axios.post).mockImplementation(() => new Promise(() => {}))
    const pending = new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B')] }, undefined, cancel.signal)
    cancel.abort()
    await expect(pending).rejects.toThrow('取消')
    expect(axios.post).not.toHaveBeenCalled()
  })
  it('queues concurrent API reviews in FIFO order instead of exhausting their pools', async () => {
    vi.useFakeTimers()
    const completions: ((response: unknown) => void)[] = []
    vi.mocked(axios.post).mockImplementation(() => new Promise(resolve => completions.push(resolve)))
    const reviewer = new LlmSecurityReviewer()
    const calls = ['first', 'second', 'third', 'fourth'].map(command => reviewer.reviewApproval({ ...request, command }, { ...base, reviewers: [entry('A'), entry('B')] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(axios.post).toHaveBeenCalledTimes(2)
    completions[0]!(chat(allowed))
    await vi.advanceTimersByTimeAsync(0)
    expect(axios.post).toHaveBeenCalledTimes(3)
    completions[1]!(chat(allowed))
    await vi.advanceTimersByTimeAsync(0)
    expect(axios.post).toHaveBeenCalledTimes(4)
    expect(vi.mocked(axios.post).mock.calls.map(call => JSON.parse((call[1] as { messages: { content: string }[] }).messages[1]!.content).command)).toEqual(['first', 'second', 'third', 'fourth'])
    completions[2]!(chat(allowed)); completions[3]!(chat(allowed))
    expect((await Promise.all(calls)).every(result => result.verdict === 'allow' && result.attempts?.length === 1)).toBe(true)
  })
  it('includes queued waiting in the overall deadline and removes cancelled waiters', async () => {
    vi.useFakeTimers()
    const completions: ((response: unknown) => void)[] = []
    vi.mocked(axios.post).mockImplementation(() => new Promise(resolve => completions.push(resolve)))
    const reviewer = new LlmSecurityReviewer()
    const occupying = [1, 2].map(() => reviewer.reviewApproval(request, { ...base, reviewers: [entry('A')] }))
    const cancel = new AbortController()
    const cancelled = reviewer.reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B')] }, undefined, cancel.signal)
    const cancelledCheck = expect(cancelled).rejects.toThrow('取消')
    const expiring = reviewer.reviewApproval(request, { ...base, timeoutSeconds: 1, overallTimeoutSeconds: 3, reviewers: [entry('A'), entry('B')] })
    const expiredCheck = expect(expiring).rejects.toMatchObject({ code: 'deadline', attempts: [expect.objectContaining({ reviewerId: 'A', failure: 'timeout' })] })
    await vi.advanceTimersByTimeAsync(0)
    cancel.abort()
    await cancelledCheck
    await vi.advanceTimersByTimeAsync(3000)
    await expiredCheck
    expect(axios.post).toHaveBeenCalledTimes(2)
    completions.forEach(resolve => resolve(chat(allowed)))
    await Promise.all(occupying)
    await vi.advanceTimersByTimeAsync(0)
    expect(axios.post).toHaveBeenCalledTimes(2)
  })
  it('returns a safe all-failed error and does not include upstream bodies or secrets', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('fictional-key-A response body'))
    const error = await new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A'), entry('B')] }).catch(error => error)
    expect(error.message).toContain('全部 2 个审核服务均失败')
    expect(error).toBeInstanceOf(LlmReviewerPoolError)
    expect(JSON.stringify(error)).not.toMatch(/fictional-key|response body/)
  })
  it('does not treat an oversized request as a service failure', async () => {
    await expect(new LlmSecurityReviewer().reviewApproval({ ...request, command: 'x'.repeat(140_000) }, { ...base, reviewers: [entry('A'), entry('B')] })).rejects.toThrow('大小限制')
    expect(axios.post).not.toHaveBeenCalled()
  })
})

describe('reviewer protocols and connection validation', () => {
  it('uses Responses instructions/input and parses completed output', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(allowed) }] }] } })
    const result = await new LlmSecurityReviewer().reviewApproval(request, { ...base, ...entry('A', { protocol: 'openai-responses', baseUrl: 'https://a.example/v1/responses' }), retryCount: 0 })
    expect(result.verdict).toBe('allow')
    expect(axios.post).toHaveBeenCalledWith('https://a.example/v1/responses', expect.objectContaining({ store: false, instructions: expect.any(String), input: expect.any(Array) }), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fictional-key-A' }), maxRedirects: 0 }))
  })
  it('uses Anthropic headers for messages and model listing', async () => {
    const config = { ...base, ...entry('A', { protocol: 'anthropic-messages', baseUrl: 'https://a.example/v1/messages' }), retryCount: 0 }
    vi.mocked(axios.post).mockResolvedValue({ data: { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(allowed) }] } })
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'claude-fixture' }] } })
    expect((await new LlmSecurityReviewer().reviewApproval(request, config)).verdict).toBe('allow')
    await expect(listLlmReviewModels(config)).resolves.toEqual(['claude-fixture'])
    for (const call of [vi.mocked(axios.post).mock.calls[0]![2], vi.mocked(axios.get).mock.calls[0]![1]]) {
      expect(call?.headers).toMatchObject({ 'x-api-key': 'fictional-key-A', 'anthropic-version': '2023-06-01' })
      expect(call?.headers).not.toHaveProperty('Authorization')
    }
    expect(vi.mocked(axios.get).mock.calls[0]![0]).toBe('https://a.example/v1/models')
  })
  it('supports imported Anthropic bearer authentication without also sending x-api-key', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'model-x' }] } })
    await listLlmReviewModels({ ...base, ...entry('A', { protocol: 'anthropic-messages', anthropicAuth: 'bearer' }) })
    expect(vi.mocked(axios.get).mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer fictional-key-A', 'anthropic-version': '2023-06-01', Accept: 'application/json' })
  })
  it('filters all pool credentials from model metadata and refuses a credential-bearing review model label', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'fictional-key-B' }, { id: 'safe-model' }] } })
    await expect(listLlmReviewModels({ ...base, ...entry('A'), reviewers: [entry('B')] })).resolves.toEqual(['safe-model'])
    vi.mocked(axios.post).mockResolvedValue(chat(allowed))
    await expect(new LlmSecurityReviewer().reviewApproval(request, { ...base, ...entry('A', { model: 'fictional-key-A' }), retryCount: 0 })).rejects.toThrow('受保护凭据')
  })
  it.each([
    ['openai-responses', { status: 'incomplete', output: [] }],
    ['anthropic-messages', { type: 'message', stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify(allowed) }] }],
  ] as const)('rejects truncated %s responses and tries the next service', async (protocol, data) => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data }).mockResolvedValueOnce(chat(allowed))
    const result = await new LlmSecurityReviewer().reviewApproval(request, { ...base, reviewers: [entry('A', { protocol }), entry('B')] })
    expect(result.model).toBe('model-B')
  })
  it('tests the actual model protocol without returning response bodies', async () => {
    vi.mocked(axios.post).mockResolvedValue(chat({ ok: true }))
    const result = await new LlmSecurityReviewer().testConnection({ ...base, ...entry('A') })
    expect(result).toEqual({ model: 'model-A' })
    expect(axios.get).not.toHaveBeenCalled()
  })
  it('tests exactly the selected draft reviewer, with no fallback to other saved entries', async () => {
    const store = await LlmReviewSettingsStore.load(join(await mkdtemp(join(tmpdir(), 'reviewer-test-fixture-')), 'settings.json'), codec)
    const input = { ...base, reviewers: [entry('A'), entry('B')] }
    await store.update(input)
    vi.mocked(axios.post).mockRejectedValue(new Error('fixture down'))
    await expect(new LlmSecurityReviewer().testConnection(store.preview(input, 'B'))).rejects.toThrow()
    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toBe('https://b.example/v1/chat/completions')
  })
})

describe('encrypted reviewer migration and import', () => {
  it('preserves migrated singleton HTTP retries and per-request timeout within the overall budget', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reviewer-retry-fixture-')), 'settings.json')
    const legacy = { ...base, ...entry('retry'), retryCount: 1, timeoutSeconds: 5, overallTimeoutSeconds: 20, reviewers: undefined }
    await writeFile(path, JSON.stringify({ version: 1, ciphertext: codec.encryptString(JSON.stringify(legacy)).toString('base64') }))
    const store = await LlmReviewSettingsStore.load(path, codec)
    expect(store.getRuntimeSettings().reviewers).toHaveLength(1)
    vi.useFakeTimers()
    vi.mocked(axios.post).mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject({ isAxiosError: true, code: 'ECONNABORTED' }), 5000))).mockResolvedValueOnce(chat(allowed))
    const result = new LlmSecurityReviewer().reviewApproval(request, store.getRuntimeSettings())
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(result).resolves.toMatchObject({ verdict: 'allow' })
    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(vi.mocked(axios.post).mock.calls.every(call => call[2]?.timeout === 5000)).toBe(true)
  })
  it('does not let singleton retries exceed the overall deadline', async () => {
    vi.useFakeTimers()
    vi.mocked(axios.post).mockRejectedValue({ isAxiosError: true, response: { status: 503 } })
    const result = new LlmSecurityReviewer().reviewApproval(request, { ...base, retryCount: 10, overallTimeoutSeconds: 3, reviewers: [entry('A')] })
    const rejected = expect(result).rejects.toMatchObject({ code: 'deadline' })
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    const calls = vi.mocked(axios.post).mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.mocked(axios.post).mock.calls.length).toBe(calls)
  })
  it('migrates legacy credentials then preserves ID-bound secrets across rename and reorder', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reviewer-pool-fixture-')), 'settings.json')
    const legacy = { ...base, ...entry('legacy'), reviewers: undefined }
    await writeFile(path, JSON.stringify({ version: 1, ciphertext: codec.encryptString(JSON.stringify(legacy)).toString('base64') }))
    const store = await LlmReviewSettingsStore.load(path, codec)
    expect(store.getSummary().reviewers).toEqual([expect.objectContaining({ id: 'legacy-reviewer', hasApiKey: true })])
    await store.importReviewer(entry('B'))
    const summary = store.getSummary()
    const pool = summary.reviewers!.slice().reverse().map(({ hasApiKey: _hasApiKey, ...item }) => ({ ...item, name: `renamed-${item.id}` }))
    await store.update({ ...base, reviewers: pool })
    const reloaded = await LlmReviewSettingsStore.load(path, codec)
    expect(reloaded.getRuntimeSettings().reviewers?.map(item => item.apiKey)).toEqual(['fictional-key-B', 'fictional-key-legacy'])
    expect(JSON.stringify(reloaded.getSummary())).not.toContain('fictional-key')
    expect(await readFile(path, 'utf8')).not.toContain('fictional-key')
  })
  it('prevents moving a saved key to a new origin or sharing it with a new ID', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reviewer-pool-fixture-')), 'settings.json')
    const store = await LlmReviewSettingsStore.load(path, codec)
    await store.update({ ...base, reviewers: [entry('A')] })
    const withoutSecret = { ...entry('A'), apiKey: undefined }
    expect(() => store.preview({ ...base, reviewers: [{ ...withoutSecret, baseUrl: 'https://other.example' }] })).toThrow('重新输入 API Key')
    expect(store.preview({ ...base, reviewers: [{ ...withoutSecret, id: 'new' }] }).apiKey).toBeUndefined()
    await expect(store.update({ ...base, reviewers: [{ ...withoutSecret, id: 'new' }] })).rejects.toThrow('API Key')
  })
  it('imports strictly by selected ID in main, stores a disabled encrypted snapshot, and never returns its secret', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reviewer-pool-fixture-')), 'settings.json')
    const store = await LlmReviewSettingsStore.load(path, codec)
    const reader = { import: vi.fn(async () => ({ enabled: true, source: 'ccswitch' as const, baseUrl: 'https://import.example', apiKey: 'fictional-import-key', model: 'model-x', providerName: 'Imported fixture' })) }
    const summary = await importLlmReviewer({ agentKind: 'claude', providerId: 'chosen-id' }, reader, store)
    expect(reader.import).toHaveBeenCalledWith('claude', 'chosen-id')
    expect(summary.reviewers).toEqual([expect.objectContaining({ name: 'Imported fixture', enabled: false, protocol: 'anthropic-messages', hasApiKey: true })])
    expect(JSON.stringify(summary)).not.toContain('fictional-import-key')
    expect(await readFile(path, 'utf8')).not.toContain('fictional-import-key')
  })
  it('sanitizes import errors and rejects duplicate IDs and an enabled empty pool', async () => {
    const store = await LlmReviewSettingsStore.load(join(await mkdtemp(join(tmpdir(), 'reviewer-pool-fixture-')), 'settings.json'), codec)
    await expect(importLlmReviewer({ agentKind: 'codex', providerId: 'selected' }, { import: vi.fn(async () => { throw new Error('fictional-secret') }) }, store)).rejects.not.toThrow('fictional-secret')
    await expect(store.update({ ...base, reviewers: [entry('A'), entry('A')] })).rejects.toThrow('不能重复')
    await expect(store.update({ ...base, reviewers: [] } as LlmReviewSettingsInput)).rejects.toThrow('至少启用')
  })
  it('redacts credentials embedded in historical model and audit labels before IPC', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reviewer-redaction-fixture-')), 'settings.json')
    const store = await LlmReviewSettingsStore.load(path, codec)
    await store.update({ ...base, reviewers: [entry('A', { name: 'label-fictional-key-A', model: 'fictional-key-A' })] })
    await store.recordRuleAudit({ reviewedAt: 1, model: 'fictional-key-A', ruleCount: 0, summary: 'fictional-key-A', findings: [] })
    expect(JSON.stringify(store.getSummary())).not.toContain('fictional-key-A')
    expect(store.getRuntimeSettings().reviewers?.[0]?.apiKey).toBe('fictional-key-A')
  })
})
