import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { DingTalkSettingsStore } from '../../electron/dingtalk-settings-store'
import type { SecureConfigurationCodec } from '../../electron/agent-configuration-store'

const codec: SecureConfigurationCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a),
  decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)).toString('utf8'),
}

describe('DingTalkSettingsStore', () => {
  it('starts disabled and does not expose a client secret in its summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dingtalk-settings-'))
    const store = await DingTalkSettingsStore.load(join(root, 'settings.json'), codec)

    expect(store.getSummary()).toMatchObject({ enabled: false, hasClientSecret: false, allowedWorkspaces: [], agentModeEnabled: false })
    expect(store.getSummary().bindingKey).toMatch(/^[a-f0-9]{32}$/)
    expect(store.getSummary()).not.toHaveProperty('clientSecret')
  })

  it('enables DingTalk without requiring a workspace allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dingtalk-settings-'))
    const store = await DingTalkSettingsStore.load(join(root, 'settings.json'), codec)

    const base = { agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false }
    await expect(store.update({ enabled: true, clientId: 'id', clientSecret: 'secret', commandsPerMinute: 20, ...base })).resolves.toMatchObject({ enabled: true })
    expect(store.getRuntimeSettings().allowedWorkspaces).toEqual([])
  })

  it('encrypts the client secret on disk and preserves it when omitted on edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dingtalk-settings-'))
    const path = join(root, 'settings.json')
    const store = await DingTalkSettingsStore.load(path, codec)

    await store.update({ enabled: true, clientId: 'id', clientSecret: 'secret-value', allowedWorkspaces: ['B:/work'], commandsPerMinute: 5, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentApiKey: 'agent-secret', agentModel: 'model-x', agentRetryCount: 3, agentProxyEnabled: true, agentProxyHost: '127.0.0.1', agentProxyPort: 7897, agentProxyPassword: 'proxy-secret' })
    expect(await readFile(path, 'utf8')).not.toContain('secret-value')
    expect(await readFile(path, 'utf8')).not.toContain('agent-secret')
    await store.update({ enabled: true, clientId: 'id', allowedWorkspaces: ['B:/work'], commandsPerMinute: 5, agentModeEnabled: true, agentBaseUrl: 'https://model.example/v1', agentModel: 'model-x', agentRetryCount: 3, agentProxyEnabled: true, agentProxyHost: '127.0.0.1', agentProxyPort: 7897 })
    expect(store.getRuntimeSettings().clientSecret).toBe('secret-value')
    expect(store.getRuntimeSettings().agentApiKey).toBe('agent-secret')
    expect(store.getRuntimeSettings().agentProxyPassword).toBe('proxy-secret')
    expect(store.getSummary()).not.toHaveProperty('agentApiKey')
    expect(store.getSummary()).not.toHaveProperty('agentProxyPassword')
  })

  it('refuses to persist settings when secure storage is unavailable', async () => {
    const unavailable: SecureConfigurationCodec = { ...codec, isEncryptionAvailable: () => false }
    const root = await mkdtemp(join(tmpdir(), 'dingtalk-settings-'))
    const store = await DingTalkSettingsStore.load(join(root, 'settings.json'), unavailable)

    await expect(store.update({ enabled: false, allowedWorkspaces: [], commandsPerMinute: 20, agentModeEnabled: false, agentRetryCount: 3, agentProxyEnabled: false })).rejects.toThrow('安全存储')
  })

  it('binds one staff account with a single-use key and rotates it on reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dingtalk-settings-'))
    const store = await DingTalkSettingsStore.load(join(root, 'settings.json'), codec)
    const key = store.getSummary().bindingKey!
    await expect(store.bind('wrong', 'staff-1')).resolves.toBe(false)
    await expect(store.bind(key, 'staff-1', 'Tester')).resolves.toBe(true)
    expect(store.getSummary()).toMatchObject({ boundStaffId: 'staff-1', boundSenderName: 'Tester' })
    expect(store.getSummary().bindingKey).toBeUndefined()
    await expect(store.bind(key, 'staff-2')).resolves.toBe(false)
    const reset = await store.resetBinding()
    expect(reset.boundStaffId).toBeUndefined(); expect(reset.bindingKey).toMatch(/^[a-f0-9]{32}$/); expect(reset.bindingKey).not.toBe(key)
  })
})
