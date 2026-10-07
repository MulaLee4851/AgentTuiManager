import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SecureConfigurationCodec } from '../../electron/agent-configuration-store'
import { LlmReviewSettingsStore } from '../../electron/llm-review-settings-store'

const codec: SecureConfigurationCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x4f),
  decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x4f)).toString('utf8'),
}

describe('LlmReviewSettingsStore', () => {
  const apiInput = { enabled: true, backend: 'api' as const, level: 'high' as const,
    baseUrl: 'https://review.example/v1', model: 'model-a', retryCount: 0, timeoutSeconds: 30,
    scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24, proxyEnabled: false }

  it('previews unsaved model-list settings with an existing key without saving or requiring a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-preview-'))
    const store = await LlmReviewSettingsStore.load(join(root,'settings.json'),codec)
    await store.update({...apiInput,apiKey:'fake-review-key'})
    expect(store.preview({...apiInput,model:undefined})).toMatchObject({apiKey:'fake-review-key',model:undefined})
    expect(store.getSummary().model).toBe('model-a')
    expect(store.preview({...apiInput,clearApiKey:true}).apiKey).toBeUndefined()
    expect(store.getSummary()).not.toHaveProperty('apiKey')
  })
  it('does not send a saved key to a new service unless it is explicitly entered again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-origin-'))
    const store = await LlmReviewSettingsStore.load(join(root,'settings.json'),codec)
    await store.update({...apiInput,apiKey:'fake-review-key'})
    expect(()=>store.preview({...apiInput,baseUrl:'https://another.example/v1'})).toThrow('重新输入 API Key')
    await expect(store.update({...apiInput,baseUrl:'https://another.example/v1'})).rejects.toThrow('重新输入 API Key')
    expect(store.preview({...apiInput,baseUrl:'https://review.example/custom'}).apiKey).toBe('fake-review-key')
    expect(store.preview({...apiInput,baseUrl:'https://another.example/v1',apiKey:'new-fake-key'}).apiKey).toBe('new-fake-key')
    expect(()=>store.preview({...apiInput,baseUrl:'https://review.example/v1?api_key=fake'})).toThrow()
  })
  it.each([
    { proxyHost: 'fake-proxy-b.example' }, { proxyPort: 9090 }, { proxyUsername: 'fake-user-b' }, { proxyUsername: undefined },
  ])('does not rebind an old proxy password through a disabled save', async changedTarget => {
    const root = await mkdtemp(join(tmpdir(), 'llm-proxy-binding-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    const proxyInput = { ...apiInput, proxyEnabled: true, proxyHost: 'fake-proxy-a.example', proxyPort: 8080, proxyUsername: 'fake-user-a' }
    await store.update({ ...proxyInput, apiKey: 'fake-review-key', proxyPassword: 'fake-proxy-password' })
    const changed = { ...proxyInput, ...changedTarget, proxyEnabled: false }
    expect(() => store.preview(changed)).toThrow('重新输入代理密码')
    await expect(store.update(changed)).rejects.toThrow('重新输入代理密码')
    expect(store.getRuntimeSettings()).toMatchObject({ proxyHost: 'fake-proxy-a.example', proxyPort: 8080, proxyUsername: 'fake-user-a' })
    await store.update({ ...changed, clearProxyPassword: true })
    expect(store.preview({ ...changed, proxyEnabled: true }).proxyPassword).toBeUndefined()
  })

  it('can disable and re-enable the same proxy, or explicitly replace its password for a new target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-proxy-replacement-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    const proxyInput = { ...apiInput, proxyEnabled: true, proxyHost: 'fake-proxy-a.example', proxyPort: 8080, proxyUsername: 'fake-user' }
    await store.update({ ...proxyInput, apiKey: 'fake-review-key', proxyPassword: 'fake-proxy-password' })
    await store.update({ ...proxyInput, proxyEnabled: false })
    expect(store.preview(proxyInput).proxyPassword).toBe('fake-proxy-password')
    await store.update({ ...proxyInput, proxyEnabled: false, proxyHost: 'fake-proxy-b.example', proxyPassword: 'new-fake-password' })
    expect(store.preview({ ...proxyInput, proxyHost: 'fake-proxy-b.example' }).proxyPassword).toBe('new-fake-password')
  })

  it.each([
    'https://fake-user:fake-inline-password@review.example/v1',
    'https://review.example/v1?api_key=fake-inline-key',
    'https://review.example/v1#fake-inline-key',
    'not-a-url-fake-inline-key',
  ])('clears unsafe legacy URLs before either summaries or runtime settings can expose them', async baseUrl => {
    const root = await mkdtemp(join(tmpdir(), 'llm-legacy-url-'))
    const file = join(root, 'settings.json')
    const legacy = { ...apiInput, baseUrl, apiKey: 'fake-review-key' }
    const ciphertext = Buffer.from(codec.encryptString(JSON.stringify(legacy))).toString('base64')
    await writeFile(file, JSON.stringify({ version: 1, ciphertext }), 'utf8')
    const store = await LlmReviewSettingsStore.load(file, codec)
    expect(store.getSummary()).not.toHaveProperty('baseUrl')
    expect(store.getRuntimeSettings()).not.toHaveProperty('baseUrl')
    expect(JSON.stringify(store.getSummary())).not.toMatch(/fake-inline|fake-review-key/u)
    expect(() => store.preview(apiInput)).toThrow('重新输入 API Key')
    await store.update({ ...apiInput, apiKey: 'new-fake-key' })
    expect(store.getSummary().baseUrl).toBe(apiInput.baseUrl)
  })
  it('keeps the previous committed settings after a persistence failure and serializes later writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-atomic-'))
    let failing=false
    const store=await LlmReviewSettingsStore.load(join(root,'settings.json'),{...codec,encryptString:value=>{if(failing)throw new Error('fixture persistence failure');return codec.encryptString(value)}})
    await store.update({...apiInput,apiKey:'fake-review-key'})
    failing=true
    await expect(store.update({...apiInput,model:'must-not-commit'})).rejects.toThrow('fixture persistence failure')
    expect(store.getSummary().model).toBe('model-a')
    failing=false
    await Promise.all([
      store.update({...apiInput,model:'new-model'}),
      store.recordRuleAudit({model:'audit-model',reviewedAt:42,ruleCount:0,summary:'fixture',findings:[]}),
    ])
    const reloaded=await LlmReviewSettingsStore.load(join(root,'settings.json'),codec)
    expect(reloaded.getSummary()).toMatchObject({model:'new-model',hasApiKey:true,lastRuleAudit:{reviewedAt:42}})
  })
  it('defaults to the high review level while remaining disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    expect(store.getSummary()).toMatchObject({ enabled: false, backend: 'api', level: 'high', retryCount: 3, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24 })
  })

  it('migrates an older encrypted configuration to the default 30 second timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const path = join(root, 'settings.json')
    const oldSettings = {
      enabled: false, level: 'high', retryCount: 3,
      scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
      proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
    }
    const ciphertext = Buffer.from(codec.encryptString(JSON.stringify(oldSettings))).toString('base64')
    await writeFile(path, JSON.stringify({ version: 1, ciphertext }), 'utf8')
    const store = await LlmReviewSettingsStore.load(path, codec)
    expect(store.getSummary().timeoutSeconds).toBe(30)
    expect(store.getSummary().backend).toBe('api')
  })

  it('encrypts credentials, preserves omitted secrets and persists the last rule audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const path = join(root, 'settings.json')
    const store = await LlmReviewSettingsStore.load(path, codec)
    const base = {
      enabled: true, level: 'high' as const, baseUrl: 'https://model.example/v1', model: 'security-model', retryCount: 3,
      timeoutSeconds: 75,
      scheduledRuleAuditEnabled: true, scheduledRuleAuditHours: 12,
      proxyEnabled: true, proxyHost: '127.0.0.1', proxyPort: 7897,
    }
    await store.update({ ...base, apiKey: 'review-secret', proxyPassword: 'proxy-secret' })
    expect(await readFile(path, 'utf8')).not.toContain('review-secret')
    expect(store.getSummary()).not.toHaveProperty('apiKey')
    await store.update(base)
    expect(store.getRuntimeSettings()).toMatchObject({ apiKey: 'review-secret', proxyPassword: 'proxy-secret', timeoutSeconds: 75 })

    await store.recordRuleAudit({ reviewedAt: 123, model: 'security-model', ruleCount: 2, summary: '发现一项问题', findings: [{ rule: 'unsafe', severity: 'high', issue: '可能写入', recommendation: '移除' }] })
    const reloaded = await LlmReviewSettingsStore.load(path, codec)
    expect(reloaded.getSummary().lastRuleAudit).toMatchObject({ reviewedAt: 123, findings: [{ rule: 'unsafe' }] })
  })

  it('fails closed when enabled without a complete model configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    await expect(store.update({ enabled: true, level: 'high', retryCount: 3, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24, proxyEnabled: false })).rejects.toThrow('Base URL')
  })

  it.each(['codex-cli', 'claude-cli'] as const)('persists %s without API credentials and requires them when switching to API', async backend => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const path = join(root, 'settings.json')
    const store = await LlmReviewSettingsStore.load(path, codec)
    const input = { enabled: true, backend, cliExecutable: 'C:\\Program Files\\Agent\\agent.exe', cliModel: 'review-model', level: 'high' as const, retryCount: 0, timeoutSeconds: 120, scheduledRuleAuditEnabled: true, scheduledRuleAuditHours: 24, proxyEnabled: false }
    await store.update(input)
    expect((await LlmReviewSettingsStore.load(path, codec)).getSummary()).toMatchObject({ backend, cliExecutable: input.cliExecutable, cliModel: input.cliModel, hasApiKey: false })
    await expect(store.update({ ...input, backend: 'api' })).rejects.toThrow('Base URL')
    expect(store.getSummary().backend).toBe(backend)
  })

  it('rejects invalid backends and multiline executable settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    const base = { enabled: false, level: 'high' as const, retryCount: 0, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24, proxyEnabled: false }
    await expect(store.update({ ...base, backend: 'other' as 'api' })).rejects.toThrow('后端')
    await expect(store.update({ ...base, backend: 'codex-cli', cliExecutable: 'codex\n--unsafe' })).rejects.toThrow('CLI 路径')
  })
})
