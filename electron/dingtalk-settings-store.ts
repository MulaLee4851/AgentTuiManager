import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { DingTalkSettingsInput, DingTalkSettingsSummary } from '../src/shared/manager-api'
import type { SecureConfigurationCodec } from './agent-configuration-store'

export interface StoredDingTalkSettings {
  enabled: boolean
  clientId?: string
  clientSecret?: string
  allowedWorkspaces: string[]
  knownWorkspaces?: string[]
  commandsPerMinute: number
  bindingKey?: string
  boundStaffId?: string
  boundSenderName?: string
  agentModeEnabled: boolean
  agentBaseUrl?: string
  agentApiKey?: string
  agentModel?: string
  agentRetryCount: number
  agentProxyEnabled: boolean
  agentProxyHost: string
  agentProxyPort: number
  agentProxyUsername?: string
  agentProxyPassword?: string
}

interface LegacyStoredDingTalkSettings extends Partial<StoredDingTalkSettings> { allowedStaffIds?: string[] }
interface EncryptedEnvelope { version: 1; ciphertext: string }

function newBindingKey(): string { return randomBytes(16).toString('hex') }

function defaults(): StoredDingTalkSettings {
  return {
    enabled: false,
    allowedWorkspaces: [],
    knownWorkspaces: [],
    commandsPerMinute: 20,
    bindingKey: newBindingKey(),
    agentModeEnabled: false,
    agentRetryCount: 3,
    agentProxyEnabled: false,
    agentProxyHost: '127.0.0.1',
    agentProxyPort: 7897,
  }
}

function summary(value: StoredDingTalkSettings): DingTalkSettingsSummary {
  return {
    enabled: value.enabled,
    ...(value.clientId ? { clientId: value.clientId } : {}),
    hasClientSecret: Boolean(value.clientSecret),
    allowedWorkspaces: [...value.allowedWorkspaces],
    knownWorkspaces: [...(value.knownWorkspaces ?? [])],
    commandsPerMinute: value.commandsPerMinute,
    ...(value.bindingKey ? { bindingKey: value.bindingKey } : {}),
    ...(value.boundStaffId ? { boundStaffId: value.boundStaffId } : {}),
    ...(value.boundSenderName ? { boundSenderName: value.boundSenderName } : {}),
    agentModeEnabled: value.agentModeEnabled,
    ...(value.agentBaseUrl ? { agentBaseUrl: value.agentBaseUrl } : {}),
    hasAgentApiKey: Boolean(value.agentApiKey),
    ...(value.agentModel ? { agentModel: value.agentModel } : {}),
    agentRetryCount: value.agentRetryCount,
    agentProxyEnabled: value.agentProxyEnabled,
    agentProxyHost: value.agentProxyHost,
    agentProxyPort: value.agentProxyPort,
    ...(value.agentProxyUsername ? { agentProxyUsername: value.agentProxyUsername } : {}),
    hasAgentProxyPassword: Boolean(value.agentProxyPassword),
  }
}

export class DingTalkSettingsStore {
  private constructor(private readonly path: string, private readonly codec: SecureConfigurationCodec, private settings: StoredDingTalkSettings) {}

  static async load(path: string, codec: SecureConfigurationCodec): Promise<DingTalkSettingsStore> {
    let settings = defaults()
    try {
      if (codec.isEncryptionAvailable()) {
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Partial<EncryptedEnvelope>
        if (envelope.version === 1 && typeof envelope.ciphertext === 'string') {
          const parsed = JSON.parse(codec.decryptString(Buffer.from(envelope.ciphertext, 'base64'))) as LegacyStoredDingTalkSettings
          const legacyStaffIds = Array.isArray(parsed.allowedStaffIds) ? parsed.allowedStaffIds.filter((item): item is string => typeof item === 'string' && Boolean(item)) : []
          const boundStaffId = typeof parsed.boundStaffId === 'string' ? parsed.boundStaffId : legacyStaffIds.length === 1 ? legacyStaffIds[0] : undefined
          settings = {
            enabled: parsed.enabled === true,
            ...(typeof parsed.clientId === 'string' ? { clientId: parsed.clientId } : {}),
            ...(typeof parsed.clientSecret === 'string' ? { clientSecret: parsed.clientSecret } : {}),
            allowedWorkspaces: Array.isArray(parsed.allowedWorkspaces) ? parsed.allowedWorkspaces.filter((item): item is string => typeof item === 'string') : [],
            knownWorkspaces: Array.isArray(parsed.knownWorkspaces)
              ? parsed.knownWorkspaces.filter((item): item is string => typeof item === 'string')
              : Array.isArray(parsed.allowedWorkspaces)
                ? parsed.allowedWorkspaces.filter((item): item is string => typeof item === 'string')
                : [],
            commandsPerMinute: Number.isInteger(parsed.commandsPerMinute) ? Number(parsed.commandsPerMinute) : 20,
            ...(boundStaffId ? { boundStaffId } : { bindingKey: typeof parsed.bindingKey === 'string' ? parsed.bindingKey : newBindingKey() }),
            ...(typeof parsed.boundSenderName === 'string' ? { boundSenderName: parsed.boundSenderName } : {}),
            agentModeEnabled: parsed.agentModeEnabled === true,
            ...(typeof parsed.agentBaseUrl === 'string' ? { agentBaseUrl: parsed.agentBaseUrl } : {}),
            ...(typeof parsed.agentApiKey === 'string' ? { agentApiKey: parsed.agentApiKey } : {}),
            ...(typeof parsed.agentModel === 'string' ? { agentModel: parsed.agentModel } : {}),
            agentRetryCount: Number.isInteger(parsed.agentRetryCount) && Number(parsed.agentRetryCount) >= 0 && Number(parsed.agentRetryCount) <= 10 ? Number(parsed.agentRetryCount) : 3,
            agentProxyEnabled: parsed.agentProxyEnabled === true,
            agentProxyHost: typeof parsed.agentProxyHost === 'string' ? parsed.agentProxyHost : '127.0.0.1',
            agentProxyPort: Number.isInteger(parsed.agentProxyPort) ? Number(parsed.agentProxyPort) : 7897,
            ...(typeof parsed.agentProxyUsername === 'string' ? { agentProxyUsername: parsed.agentProxyUsername } : {}),
            ...(typeof parsed.agentProxyPassword === 'string' ? { agentProxyPassword: parsed.agentProxyPassword } : {}),
          }
        }
      }
    } catch { settings = defaults() }
    const store = new DingTalkSettingsStore(path, codec, settings)
    if (codec.isEncryptionAvailable() && !settings.boundStaffId && settings.bindingKey) await store.persist()
    return store
  }

  getSummary(): DingTalkSettingsSummary { return summary(this.settings) }
  getRuntimeSettings(): StoredDingTalkSettings {
    return {
      ...this.settings,
      allowedWorkspaces: [...this.settings.allowedWorkspaces],
      knownWorkspaces: [...(this.settings.knownWorkspaces ?? [])],
    }
  }

  async update(input: DingTalkSettingsInput): Promise<DingTalkSettingsSummary> {
    if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，钉钉配置未保存')
    const clientSecret = input.clearClientSecret ? undefined : input.clientSecret ?? this.settings.clientSecret
    const agentApiKey = input.clearAgentApiKey ? undefined : input.agentApiKey ?? this.settings.agentApiKey
    const agentProxyPassword = input.clearAgentProxyPassword ? undefined : input.agentProxyPassword ?? this.settings.agentProxyPassword
    if (input.enabled && (!input.clientId || !clientSecret)) throw new Error('启用钉钉远程开发前，请填写 Client ID 和 Client Secret')
    if (input.enabled && input.allowedWorkspaces.length === 0) throw new Error('启用钉钉远程开发前，请至少添加一个允许的工作区')
    if (input.agentModeEnabled && (!input.agentBaseUrl || !agentApiKey || !input.agentModel)) throw new Error('启用 Agent 模式前，请填写 Base URL、API Key 和 Model')
    if (!Number.isInteger(input.agentRetryCount) || input.agentRetryCount < 0 || input.agentRetryCount > 10) throw new Error('Agent 失败重试次数应为 0 到 10')
    if (input.agentBaseUrl) {
      let parsed: URL
      try { parsed = new URL(input.agentBaseUrl) } catch { throw new Error('Agent Base URL 不是有效地址') }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Agent Base URL 仅支持 HTTP 或 HTTPS')
    }
    if (input.agentProxyEnabled && (!input.agentProxyHost || !Number.isInteger(input.agentProxyPort) || input.agentProxyPort! < 1 || input.agentProxyPort! > 65_535)) {
      throw new Error('Agent HTTP 代理主机或端口无效')
    }
    this.settings = {
      enabled: input.enabled,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      allowedWorkspaces: [...input.allowedWorkspaces],
      knownWorkspaces: [...new Set([...(input.knownWorkspaces ?? this.settings.knownWorkspaces ?? []), ...input.allowedWorkspaces])],
      commandsPerMinute: input.commandsPerMinute,
      ...(this.settings.boundStaffId ? { boundStaffId: this.settings.boundStaffId } : { bindingKey: this.settings.bindingKey ?? newBindingKey() }),
      ...(this.settings.boundSenderName ? { boundSenderName: this.settings.boundSenderName } : {}),
      agentModeEnabled: input.agentModeEnabled,
      ...(input.agentBaseUrl ? { agentBaseUrl: input.agentBaseUrl } : {}),
      ...(agentApiKey ? { agentApiKey } : {}),
      ...(input.agentModel ? { agentModel: input.agentModel } : {}),
      agentRetryCount: input.agentRetryCount,
      agentProxyEnabled: input.agentProxyEnabled,
      agentProxyHost: input.agentProxyHost || '127.0.0.1',
      agentProxyPort: input.agentProxyPort ?? 7897,
      ...(input.agentProxyUsername ? { agentProxyUsername: input.agentProxyUsername } : {}),
      ...(agentProxyPassword ? { agentProxyPassword } : {}),
    }
    await this.persist()
    return this.getSummary()
  }

  async bind(key: string, staffId: string, senderName?: string): Promise<boolean> {
    if (this.settings.boundStaffId || !this.settings.bindingKey) return false
    const expected = Buffer.from(this.settings.bindingKey, 'utf8'); const actual = Buffer.from(key, 'utf8')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
    this.settings = { ...this.settings, bindingKey: undefined, boundStaffId: staffId, ...(senderName ? { boundSenderName: senderName } : {}) }
    await this.persist(); return true
  }

  async resetBinding(): Promise<DingTalkSettingsSummary> {
    this.settings = { ...this.settings, boundStaffId: undefined, boundSenderName: undefined, bindingKey: newBindingKey() }
    await this.persist(); return this.getSummary()
  }

  private async persist(): Promise<void> {
    const ciphertext = Buffer.from(this.codec.encryptString(JSON.stringify(this.settings))).toString('base64')
    const envelope: EncryptedEnvelope = { version: 1, ciphertext }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(envelope, null, 2), 'utf8'); await rename(temporary, this.path) }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error }
  }
}
