import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  LlmReviewLevel,
  LlmReviewSettingsInput,
  LlmReviewSettingsSummary,
  LlmRuleAuditResult,
} from '../src/shared/manager-api'
import type { SecureConfigurationCodec } from './agent-configuration-store'

export interface StoredLlmReviewSettings {
  enabled: boolean
  level: LlmReviewLevel
  baseUrl?: string
  apiKey?: string
  model?: string
  retryCount: number
  timeoutSeconds: number
  scheduledRuleAuditEnabled: boolean
  scheduledRuleAuditHours: number
  proxyEnabled: boolean
  proxyHost: string
  proxyPort: number
  proxyUsername?: string
  proxyPassword?: string
  lastRuleAudit?: LlmRuleAuditResult
}

interface EncryptedEnvelope { version: 1; ciphertext: string }

function defaults(): StoredLlmReviewSettings {
  return {
    enabled: false,
    level: 'high',
    retryCount: 3,
    timeoutSeconds: 30,
    scheduledRuleAuditEnabled: false,
    scheduledRuleAuditHours: 24,
    proxyEnabled: false,
    proxyHost: '127.0.0.1',
    proxyPort: 7897,
  }
}

function validLevel(value: unknown): value is LlmReviewLevel {
  return value === 'low' || value === 'medium' || value === 'high'
}

function validRuleAudit(value: unknown): value is LlmRuleAuditResult {
  if (!value || typeof value !== 'object') return false
  const audit = value as Partial<LlmRuleAuditResult>
  return typeof audit.reviewedAt === 'number' && typeof audit.model === 'string'
    && typeof audit.ruleCount === 'number' && typeof audit.summary === 'string'
    && Array.isArray(audit.findings) && audit.findings.every((finding) => Boolean(finding)
      && typeof finding.rule === 'string' && typeof finding.issue === 'string'
      && typeof finding.recommendation === 'string'
      && ['low', 'medium', 'high', 'critical'].includes(finding.severity))
}

function copyAudit(value: LlmRuleAuditResult | undefined): LlmRuleAuditResult | undefined {
  return value ? { ...value, findings: value.findings.map((finding) => ({ ...finding })) } : undefined
}

function summary(value: StoredLlmReviewSettings): LlmReviewSettingsSummary {
  return {
    enabled: value.enabled,
    level: value.level,
    ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
    hasApiKey: Boolean(value.apiKey),
    ...(value.model ? { model: value.model } : {}),
    retryCount: value.retryCount,
    timeoutSeconds: value.timeoutSeconds,
    scheduledRuleAuditEnabled: value.scheduledRuleAuditEnabled,
    scheduledRuleAuditHours: value.scheduledRuleAuditHours,
    proxyEnabled: value.proxyEnabled,
    proxyHost: value.proxyHost,
    proxyPort: value.proxyPort,
    ...(value.proxyUsername ? { proxyUsername: value.proxyUsername } : {}),
    hasProxyPassword: Boolean(value.proxyPassword),
    ...(value.lastRuleAudit ? { lastRuleAudit: copyAudit(value.lastRuleAudit)! } : {}),
    ruleAuditState: value.lastRuleAudit
      ? { status: 'completed', completedAt: value.lastRuleAudit.reviewedAt }
      : { status: 'idle' },
  }
}

export class LlmReviewSettingsStore {
  private constructor(
    private readonly path: string,
    private readonly codec: SecureConfigurationCodec,
    private settings: StoredLlmReviewSettings,
  ) {}

  static async load(path: string, codec: SecureConfigurationCodec): Promise<LlmReviewSettingsStore> {
    let settings = defaults()
    try {
      if (codec.isEncryptionAvailable()) {
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Partial<EncryptedEnvelope>
        if (envelope.version === 1 && typeof envelope.ciphertext === 'string') {
          const parsed = JSON.parse(codec.decryptString(Buffer.from(envelope.ciphertext, 'base64'))) as Partial<StoredLlmReviewSettings>
          settings = {
            enabled: parsed.enabled === true,
            level: validLevel(parsed.level) ? parsed.level : 'high',
            ...(typeof parsed.baseUrl === 'string' ? { baseUrl: parsed.baseUrl } : {}),
            ...(typeof parsed.apiKey === 'string' ? { apiKey: parsed.apiKey } : {}),
            ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
            retryCount: Number.isInteger(parsed.retryCount) && Number(parsed.retryCount) >= 0 && Number(parsed.retryCount) <= 10 ? Number(parsed.retryCount) : 3,
            timeoutSeconds: Number.isInteger(parsed.timeoutSeconds) && Number(parsed.timeoutSeconds) >= 5 && Number(parsed.timeoutSeconds) <= 600 ? Number(parsed.timeoutSeconds) : 30,
            scheduledRuleAuditEnabled: parsed.scheduledRuleAuditEnabled === true,
            scheduledRuleAuditHours: Number.isInteger(parsed.scheduledRuleAuditHours) && Number(parsed.scheduledRuleAuditHours) >= 1 && Number(parsed.scheduledRuleAuditHours) <= 720 ? Number(parsed.scheduledRuleAuditHours) : 24,
            proxyEnabled: parsed.proxyEnabled === true,
            proxyHost: typeof parsed.proxyHost === 'string' ? parsed.proxyHost : '127.0.0.1',
            proxyPort: Number.isInteger(parsed.proxyPort) ? Number(parsed.proxyPort) : 7897,
            ...(typeof parsed.proxyUsername === 'string' ? { proxyUsername: parsed.proxyUsername } : {}),
            ...(typeof parsed.proxyPassword === 'string' ? { proxyPassword: parsed.proxyPassword } : {}),
            ...(validRuleAudit(parsed.lastRuleAudit) ? { lastRuleAudit: parsed.lastRuleAudit } : {}),
          }
        }
      }
    } catch {
      settings = defaults()
    }
    return new LlmReviewSettingsStore(path, codec, settings)
  }

  getSummary(): LlmReviewSettingsSummary { return summary(this.settings) }

  getRuntimeSettings(): StoredLlmReviewSettings {
    return { ...this.settings, ...(this.settings.lastRuleAudit ? { lastRuleAudit: copyAudit(this.settings.lastRuleAudit) } : {}) }
  }

  async update(input: LlmReviewSettingsInput): Promise<LlmReviewSettingsSummary> {
    if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，LLM 审查配置未保存')
    if (!validLevel(input.level)) throw new Error('请选择有效的审查等级')
    if (!Number.isInteger(input.retryCount) || input.retryCount < 0 || input.retryCount > 10) throw new Error('失败重试次数应为 0 到 10')
    if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 5 || input.timeoutSeconds > 600) throw new Error('单次请求超时应为 5 到 600 秒')
    if (!Number.isInteger(input.scheduledRuleAuditHours) || input.scheduledRuleAuditHours < 1 || input.scheduledRuleAuditHours > 720) throw new Error('定时审查周期应为 1 到 720 小时')
    const apiKey = input.clearApiKey ? undefined : input.apiKey ?? this.settings.apiKey
    const proxyPassword = input.clearProxyPassword ? undefined : input.proxyPassword ?? this.settings.proxyPassword
    if ((input.enabled || input.scheduledRuleAuditEnabled) && (!input.baseUrl || !apiKey || !input.model)) {
      throw new Error('启用 LLM 审查前，请填写 Base URL、API Key 和 Model')
    }
    if (input.baseUrl) {
      let parsed: URL
      try { parsed = new URL(input.baseUrl) } catch { throw new Error('Base URL 不是有效地址') }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 仅支持 HTTP 或 HTTPS')
    }
    if (input.proxyEnabled && (!input.proxyHost || !Number.isInteger(input.proxyPort) || input.proxyPort! < 1 || input.proxyPort! > 65_535)) {
      throw new Error('HTTP 代理主机或端口无效')
    }
    this.settings = {
      enabled: input.enabled,
      level: input.level,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(input.model ? { model: input.model } : {}),
      retryCount: input.retryCount,
      timeoutSeconds: input.timeoutSeconds,
      scheduledRuleAuditEnabled: input.scheduledRuleAuditEnabled,
      scheduledRuleAuditHours: input.scheduledRuleAuditHours,
      proxyEnabled: input.proxyEnabled,
      proxyHost: input.proxyHost || '127.0.0.1',
      proxyPort: input.proxyPort ?? 7897,
      ...(input.proxyUsername ? { proxyUsername: input.proxyUsername } : {}),
      ...(proxyPassword ? { proxyPassword } : {}),
      ...(this.settings.lastRuleAudit ? { lastRuleAudit: this.settings.lastRuleAudit } : {}),
    }
    await this.persist()
    return this.getSummary()
  }

  async recordRuleAudit(result: LlmRuleAuditResult): Promise<void> {
    this.settings = { ...this.settings, lastRuleAudit: copyAudit(result) }
    await this.persist()
  }

  private async persist(): Promise<void> {
    const ciphertext = Buffer.from(this.codec.encryptString(JSON.stringify(this.settings))).toString('base64')
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
