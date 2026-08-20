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
  it('defaults to the high review level while remaining disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-review-settings-'))
    const store = await LlmReviewSettingsStore.load(join(root, 'settings.json'), codec)
    expect(store.getSummary()).toMatchObject({ enabled: false, level: 'high', retryCount: 3, timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24 })
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
})
