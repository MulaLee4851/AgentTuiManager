import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AgentConfigInput, AgentConfigSource, AgentConfigSummary } from '../src/shared/manager-api'

export interface SecureConfigurationCodec {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Uint8Array
  decryptString(value: Uint8Array): string
}

export interface StoredAgentConfig {
  profileId: string
  source: Exclude<AgentConfigSource, 'local'>
  baseUrl?: string
  apiKey?: string
  model?: string
  extraArgs: string[]
  providerId?: string
  providerName?: string
}

interface StoredPayload {
  version: 1
  profiles: StoredAgentConfig[]
}

interface EncryptedEnvelope {
  version: 1
  ciphertext: string
}

function summary(profile: StoredAgentConfig): AgentConfigSummary {
  return {
    enabled: true,
    source: profile.source,
    profileId: profile.profileId,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    extraArgs: [...profile.extraArgs],
    hasApiKey: Boolean(profile.apiKey),
    ...(profile.providerId ? { providerId: profile.providerId } : {}),
    ...(profile.providerName ? { providerName: profile.providerName } : {}),
  }
}

export class AgentConfigurationStore {
  private constructor(
    private readonly path: string,
    private readonly codec: SecureConfigurationCodec,
    private readonly profiles: Map<string, StoredAgentConfig>,
  ) {}

  static async load(path: string, codec: SecureConfigurationCodec): Promise<AgentConfigurationStore> {
    const profiles = new Map<string, StoredAgentConfig>()
    try {
      if (codec.isEncryptionAvailable()) {
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Partial<EncryptedEnvelope>
        if (envelope.version === 1 && typeof envelope.ciphertext === 'string') {
          const payload = JSON.parse(codec.decryptString(Buffer.from(envelope.ciphertext, 'base64'))) as Partial<StoredPayload>
          if (payload.version === 1 && Array.isArray(payload.profiles)) {
            for (const profile of payload.profiles) {
              if (profile && typeof profile.profileId === 'string' && ['custom', 'ccswitch'].includes(profile.source)) {
                profiles.set(profile.profileId, { ...profile, extraArgs: Array.isArray(profile.extraArgs) ? [...profile.extraArgs] : [] })
              }
            }
          }
        }
      }
    } catch {
      // Missing, damaged, or undecryptable settings must not affect local Agent startup.
    }
    return new AgentConfigurationStore(path, codec, profiles)
  }

  async save(input: AgentConfigInput, existingProfileId?: string): Promise<AgentConfigSummary> {
    if (!input.enabled || input.source === 'local') return AgentConfigurationStore.localSummary()
    if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，独立配置未保存')
    const profileId = existingProfileId && this.profiles.has(existingProfileId) ? existingProfileId : randomUUID()
    const previous = this.profiles.get(profileId)
    const apiKey = input.clearApiKey ? undefined : input.apiKey ?? previous?.apiKey
    const profile: StoredAgentConfig = {
      profileId,
      source: input.source,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(input.model ? { model: input.model } : {}),
      extraArgs: [...(input.extraArgs ?? [])],
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.providerName ? { providerName: input.providerName } : {}),
    }
    this.profiles.set(profileId, profile)
    await this.persist()
    return summary(profile)
  }

  get(profileId: string): StoredAgentConfig | undefined {
    const profile = this.profiles.get(profileId)
    return profile ? { ...profile, extraArgs: [...profile.extraArgs] } : undefined
  }

  async remove(profileId: string): Promise<void> {
    if (!this.profiles.delete(profileId)) return
    await this.persist()
  }

  static localSummary(): AgentConfigSummary {
    return { enabled: false, source: 'local', extraArgs: [], hasApiKey: false }
  }

  private async persist(): Promise<void> {
    const payload: StoredPayload = { version: 1, profiles: [...this.profiles.values()] }
    const ciphertext = Buffer.from(this.codec.encryptString(JSON.stringify(payload))).toString('base64')
    const envelope: EncryptedEnvelope = { version: 1, ciphertext }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(envelope, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
