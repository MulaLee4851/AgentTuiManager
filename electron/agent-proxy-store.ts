import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AgentProxyInput, AgentProxySummary } from '../src/shared/manager-api'
import type { SecureConfigurationCodec } from './agent-configuration-store'

export interface StoredAgentProxy {
  proxyId: string
  protocol: 'http'
  host: string
  port: number
  username?: string
  password?: string
}

interface StoredPayload { version: 1; proxies: StoredAgentProxy[] }
interface EncryptedEnvelope { version: 1; ciphertext: string }

function summary(proxy: StoredAgentProxy): AgentProxySummary {
  return {
    enabled: true,
    proxyId: proxy.proxyId,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username ? { username: proxy.username } : {}),
    hasPassword: Boolean(proxy.password),
  }
}

export class AgentProxyStore {
  private constructor(
    private readonly path: string,
    private readonly codec: SecureConfigurationCodec,
    private readonly proxies: Map<string, StoredAgentProxy>,
  ) {}

  static async load(path: string, codec: SecureConfigurationCodec): Promise<AgentProxyStore> {
    const proxies = new Map<string, StoredAgentProxy>()
    try {
      if (codec.isEncryptionAvailable()) {
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Partial<EncryptedEnvelope>
        if (envelope.version === 1 && typeof envelope.ciphertext === 'string') {
          const payload = JSON.parse(codec.decryptString(Buffer.from(envelope.ciphertext, 'base64'))) as Partial<StoredPayload>
          if (payload.version === 1 && Array.isArray(payload.proxies)) {
            for (const proxy of payload.proxies) {
              if (proxy?.protocol === 'http' && typeof proxy.proxyId === 'string' && typeof proxy.host === 'string' && Number.isInteger(proxy.port)) {
                proxies.set(proxy.proxyId, { ...proxy })
              }
            }
          }
        }
      }
    } catch {
      // A missing or damaged proxy store must never prevent local Agent startup.
    }
    return new AgentProxyStore(path, codec, proxies)
  }

  async save(input: AgentProxyInput, existingProxyId?: string): Promise<AgentProxySummary | undefined> {
    if (!input.enabled) return undefined
    if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，代理配置未保存')
    const proxyId = existingProxyId && this.proxies.has(existingProxyId) ? existingProxyId : randomUUID()
    const previous = this.proxies.get(proxyId)
    const password = input.clearPassword ? undefined : input.password ?? previous?.password
    const proxy: StoredAgentProxy = {
      proxyId,
      protocol: 'http',
      host: input.host,
      port: input.port,
      ...(input.username ? { username: input.username } : {}),
      ...(password ? { password } : {}),
    }
    this.proxies.set(proxyId, proxy)
    await this.persist()
    return summary(proxy)
  }

  get(proxyId: string): StoredAgentProxy | undefined {
    const proxy = this.proxies.get(proxyId)
    return proxy ? { ...proxy } : undefined
  }

  async remove(proxyId: string): Promise<void> {
    if (!this.proxies.delete(proxyId)) return
    await this.persist()
  }

  private async persist(): Promise<void> {
    const payload: StoredPayload = { version: 1, proxies: [...this.proxies.values()] }
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

export function environmentForAgentProxy(proxy: StoredAgentProxy): Record<string, string> {
  const credentials = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : ''
  const url = `http://${credentials}${proxy.host}:${proxy.port}`
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url }
}
