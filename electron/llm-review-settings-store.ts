import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  LlmReviewLevel,
  LlmReviewerBackend,
  LlmReviewSettingsInput,
  LlmReviewSettingsSummary,
  LlmRuleAuditResult,
  LlmReviewerInput,
  LlmReviewerSummary,
  LlmApiProtocol,
} from '../src/shared/manager-api'
import type { SecureConfigurationCodec } from './agent-configuration-store'
import { resolveLlmApiEndpoint } from './llm-model-catalog'
import { redactLlmCredentialText } from './llm-response-privacy'

export interface StoredLlmReviewSettings {
  reviewers?: StoredLlmReviewer[]
  overallTimeoutSeconds?: number
  protocol?: LlmApiProtocol
  anthropicAuth?: 'api-key' | 'bearer'
  enabled: boolean
  backend?: LlmReviewerBackend
  cliExecutable?: string
  cliModel?: string
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

export interface StoredLlmReviewer extends Omit<LlmReviewerInput, 'clearApiKey'> {}
export function validLlmProtocol(value: unknown): value is LlmApiProtocol {
  return value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages'
}

function reviewerSummary(value: StoredLlmReviewer): LlmReviewerSummary {
  const { apiKey: _apiKey, ...rest } = value
  return { ...rest, hasApiKey: Boolean(value.apiKey) }
}

function legacyReviewer(settings: StoredLlmReviewSettings): StoredLlmReviewer {
  return { id: 'legacy-reviewer', name: '默认审核器', enabled: true, backend: settings.backend ?? 'api',
    protocol: settings.protocol ?? 'openai-chat', anthropicAuth: settings.anthropicAuth, baseUrl: settings.baseUrl, apiKey: settings.apiKey,
    model: settings.model, cliExecutable: settings.cliExecutable, cliModel: settings.cliModel }
}

function resolveReviewer(input: LlmReviewerInput, previous?: StoredLlmReviewer): StoredLlmReviewer {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) throw new Error('审核器 ID 无效')
  const name = optionalCliText(input.name, '审核器名称', 100)
  if (!name || typeof input.enabled !== 'boolean' || !validBackend(input.backend)) throw new Error('审核器名称、启用状态或后端无效')
  const protocol = input.protocol ?? 'openai-chat'
  if (!validLlmProtocol(protocol)) throw new Error('审核 API 协议无效')
  if (input.anthropicAuth !== undefined && input.anthropicAuth !== 'api-key' && input.anthropicAuth !== 'bearer') throw new Error('Anthropic 身份验证方式无效')
  const baseUrl = optionalCliText(input.baseUrl, 'Base URL', 4096)
  if (baseUrl) resolveLlmApiEndpoint(baseUrl, 'models')
  const newKey = optionalCliText(input.apiKey, 'API Key', 16384)
  if (baseUrl && !newKey && !input.clearApiKey && previous?.apiKey) {
    let sameOrigin = false
    try { sameOrigin = new URL(baseUrl).origin === new URL(previous.baseUrl ?? '').origin } catch { /* Reject unbound keys. */ }
    if (!sameOrigin) throw new Error('服务地址已更换，请重新输入 API Key，避免将原密钥发送到其他服务')
  }
  return { id: input.id, name, enabled: input.enabled, backend: input.backend, protocol, anthropicAuth: input.anthropicAuth,
    ...(baseUrl ? { baseUrl } : {}),
    apiKey: input.clearApiKey ? undefined : newKey || previous?.apiKey,
    model: optionalCliText(input.model, 'Model', 200),
    cliExecutable: optionalCliText(input.cliExecutable, 'CLI 路径', 4096),
    cliModel: optionalCliText(input.cliModel, 'CLI Model', 200) }
}

interface EncryptedEnvelope { version: 1; ciphertext: string }

function defaults(): StoredLlmReviewSettings {
  return {
    enabled: false,
    backend: 'api',
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

function validBackend(value: unknown): value is LlmReviewerBackend {
  return value === 'api' || value === 'codex-cli' || value === 'claude-cli'
}

function optionalCliText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(name + ' 无效')
  return value.trim() || undefined
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
  return value ? { ...value, findings: value.findings.map((finding) => ({ ...finding })), ...(value.attempts ? { attempts: value.attempts.map(attempt => ({ ...attempt })) } : {}) } : undefined
}

function safeStoredBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    resolveLlmApiEndpoint(value, 'models')
    return value.trim()
  } catch {
    // Older versions accepted credential-bearing URLs. Never return them to IPC.
    return undefined
  }
}

function summary(value: StoredLlmReviewSettings): LlmReviewSettingsSummary {
  const baseUrl = safeStoredBaseUrl(value.baseUrl)
  const result: LlmReviewSettingsSummary = {
    reviewers: value.reviewers?.map(reviewerSummary) ?? [],
    overallTimeoutSeconds: value.overallTimeoutSeconds ?? 120,
    protocol: value.protocol ?? 'openai-chat',
    anthropicAuth: value.anthropicAuth,
    enabled: value.enabled,
    backend: value.backend ?? 'api',
    ...(value.cliExecutable ? { cliExecutable: value.cliExecutable } : {}),
    ...(value.cliModel ? { cliModel: value.cliModel } : {}),
    level: value.level,
    ...(baseUrl ? { baseUrl } : {}),
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
  // Historical summaries and provider labels may themselves contain echoed credentials.
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = redactLlmCredentialText(item, value)
      for (const entry of value.reviewers ?? []) text = redactLlmCredentialText(text, { apiKey: entry.apiKey })
      return text
    }
    if (Array.isArray(item)) return item.map(redact)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]))
    return item
  }
  return redact(result) as LlmReviewSettingsSummary
}

export class LlmReviewSettingsStore {
  private writes: Promise<void> = Promise.resolve()
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
          const baseUrl = safeStoredBaseUrl(parsed.baseUrl)
          settings = {
            enabled: parsed.enabled === true,
            backend: validBackend(parsed.backend) ? parsed.backend : 'api',
            ...(optionalCliText(parsed.cliExecutable, 'CLI 路径', 4_096) ? { cliExecutable: parsed.cliExecutable!.trim() } : {}),
            ...(optionalCliText(parsed.cliModel, 'CLI Model', 200) ? { cliModel: parsed.cliModel!.trim() } : {}),
            level: validLevel(parsed.level) ? parsed.level : 'high',
            ...(baseUrl ? { baseUrl } : {}),
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
          settings.protocol = validLlmProtocol(parsed.protocol) ? parsed.protocol : 'openai-chat'
          settings.anthropicAuth = parsed.anthropicAuth === 'bearer' ? 'bearer' : 'api-key'
          settings.overallTimeoutSeconds = Number.isInteger(parsed.overallTimeoutSeconds) && Number(parsed.overallTimeoutSeconds) >= 5 && Number(parsed.overallTimeoutSeconds) <= 600 ? parsed.overallTimeoutSeconds : 120
          if (Array.isArray(parsed.reviewers)) {
            // Invalid individual entries cannot erase other encrypted credentials.
            const ids = new Set<string>()
            settings.reviewers = parsed.reviewers.slice(0, 30).flatMap(entry => {
              try {
                if (ids.has(entry.id)) return []
                const clean = resolveReviewer({ ...entry, baseUrl: safeStoredBaseUrl(entry.baseUrl) })
                ids.add(clean.id)
                return [clean]
              } catch { return [] }
            })
          } else settings.reviewers = [legacyReviewer(settings)]
        }
      }
    } catch {
      settings = defaults()
    }
    return new LlmReviewSettingsStore(path, codec, settings)
  }

  getSummary(): LlmReviewSettingsSummary { return summary(this.settings) }

  getRuntimeSettings(): StoredLlmReviewSettings {
    return { ...this.settings, reviewers: this.settings.reviewers?.map(entry => ({ ...entry })), ...(this.settings.lastRuleAudit ? { lastRuleAudit: copyAudit(this.settings.lastRuleAudit) } : {}) }
  }

  /** Resolve a form draft in the main process without saving or exposing secrets. */
  preview(input: LlmReviewSettingsInput, reviewerId?: string): StoredLlmReviewSettings {
    const baseUrl = input.baseUrl?.trim()
    if (baseUrl) resolveLlmApiEndpoint(baseUrl, 'models')
    const newKey = input.apiKey?.trim()
    const proxyHost = input.proxyHost || '127.0.0.1'
    const proxyPort = input.proxyPort ?? 7897
    const proxyUsername = input.proxyUsername || undefined
    if (!input.reviewers && baseUrl && !input.clearApiKey && !newKey && this.settings.apiKey) {
      let sameOrigin = false
      try { sameOrigin = new URL(baseUrl).origin === new URL(this.settings.baseUrl ?? '').origin } catch { /* Unbound key needs explicit input. */ }
      if (!sameOrigin) throw new Error('服务地址已更换，请重新输入 API Key，避免将原密钥发送到其他服务')
    }
    // Password ownership must survive disabled saves and removal of the username.
    if (!input.clearProxyPassword && !input.proxyPassword && this.settings.proxyPassword
      && (proxyHost !== this.settings.proxyHost || proxyPort !== this.settings.proxyPort || proxyUsername !== this.settings.proxyUsername)) {
      throw new Error('代理地址或用户名已更换，请重新输入代理密码')
    }
    const resolved: StoredLlmReviewSettings = {
      ...this.getRuntimeSettings(), ...input, baseUrl,
      model: input.model?.trim(),
      apiKey: input.clearApiKey ? undefined : newKey || this.settings.apiKey,
      proxyHost, proxyPort, proxyUsername,
      proxyPassword: input.clearProxyPassword ? undefined : input.proxyPassword || this.settings.proxyPassword,
    }
    if (input.reviewers !== undefined) {
      if (!Array.isArray(input.reviewers) || input.reviewers.length > 30) throw new Error('审核器池最多 30 项')
      const ids = new Set<string>()
      resolved.reviewers = input.reviewers.map(entry => {
        const next = resolveReviewer(entry, this.settings.reviewers?.find(saved => saved.id === entry.id))
        if (ids.has(next.id)) throw new Error('审核器 ID 不能重复')
        ids.add(next.id)
        return next
      })
      const selected = reviewerId ? resolved.reviewers.find(entry => entry.id === reviewerId) : resolved.reviewers[0]
      if (reviewerId && !selected) throw new Error('找不到所选审核器')
      if (selected) Object.assign(resolved, { backend: selected.backend, protocol: selected.protocol, anthropicAuth: selected.anthropicAuth, baseUrl: selected.baseUrl,
        apiKey: selected.apiKey, model: selected.model, cliExecutable: selected.cliExecutable, cliModel: selected.cliModel })
      else Object.assign(resolved, { backend: 'api', baseUrl: undefined, apiKey: undefined, model: undefined })
    } else resolved.reviewers = [{ ...legacyReviewer(resolved), id: this.settings.reviewers?.[0]?.id ?? 'legacy-reviewer', name: this.settings.reviewers?.[0]?.name ?? '默认审核器' }]
    return resolved
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => undefined).then(operation)
    this.writes = pending.then(() => undefined, () => undefined)
    return pending
  }

  async update(input: LlmReviewSettingsInput): Promise<LlmReviewSettingsSummary> {
    return this.enqueue(() => this.updateNow(input))
  }

  private async updateNow(input: LlmReviewSettingsInput): Promise<LlmReviewSettingsSummary> {
    if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，LLM 审查配置未保存')
    if (!validLevel(input.level)) throw new Error('请选择有效的审查等级')
    const backend = input.backend ?? this.settings.backend ?? 'api'
    if (!validBackend(backend)) throw new Error('请选择有效的审查后端')
    const cliExecutable = optionalCliText(input.cliExecutable, 'CLI 路径', 4_096)
    const cliModel = optionalCliText(input.cliModel, 'CLI Model', 200)
    if (!Number.isInteger(input.retryCount) || input.retryCount < 0 || input.retryCount > 10) throw new Error('失败重试次数应为 0 到 10')
    if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 5 || input.timeoutSeconds > 600) throw new Error('单次请求超时应为 5 到 600 秒')
    if (input.overallTimeoutSeconds !== undefined && (!Number.isInteger(input.overallTimeoutSeconds) || input.overallTimeoutSeconds < 5 || input.overallTimeoutSeconds > 600)) throw new Error('整体审核时限应为 5 到 600 秒')
    if (input.protocol !== undefined && !validLlmProtocol(input.protocol)) throw new Error('审核 API 协议无效')
    if (!Number.isInteger(input.scheduledRuleAuditHours) || input.scheduledRuleAuditHours < 1 || input.scheduledRuleAuditHours > 720) throw new Error('定时审查周期应为 1 到 720 小时')
    const resolved = this.preview(input)
    const { apiKey, proxyPassword } = resolved
    if (!input.reviewers && backend === 'api' && (input.enabled || input.scheduledRuleAuditEnabled) && (!input.baseUrl?.trim() || !apiKey?.trim() || !input.model?.trim())) {
      throw new Error('启用 LLM 审查前，请填写 Base URL、API Key 和 Model')
    }
    if (input.reviewers && (input.enabled || input.scheduledRuleAuditEnabled)) {
      const enabled = resolved.reviewers!.filter(entry => entry.enabled)
      if (!enabled.length) throw new Error('请至少启用一个审核器')
      const incomplete = resolved.reviewers!.flatMap((entry, index) => {
        if (!entry.enabled || entry.backend !== 'api') return []
        const missing = [!entry.baseUrl && 'Base URL', !entry.apiKey && 'API Key', !entry.model && 'Model'].filter(Boolean)
        // Identify by visible position, not user-supplied labels that might contain credentials.
        return missing.length ? [`第 ${index + 1} 个审核器缺少 ${missing.join('、')}`] : []
      })
      if (incomplete.length) throw new Error(incomplete.join('；') + '。请补全这些字段，或取消勾选对应审核器后保存；其他已保存的密钥无需重新填写。')
    }
    if (input.baseUrl) {
      let parsed: URL
      try { parsed = new URL(input.baseUrl) } catch { throw new Error('Base URL 不是有效地址') }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 仅支持 HTTP 或 HTTPS')
    }
    if (input.proxyEnabled && (!input.proxyHost || !Number.isInteger(input.proxyPort) || input.proxyPort! < 1 || input.proxyPort! > 65_535)) {
      throw new Error('HTTP 代理主机或端口无效')
    }
    const next: StoredLlmReviewSettings = {
      reviewers: resolved.reviewers,
      overallTimeoutSeconds: input.overallTimeoutSeconds ?? this.settings.overallTimeoutSeconds ?? 120,
      protocol: resolved.protocol ?? 'openai-chat',
      anthropicAuth: resolved.anthropicAuth,
      enabled: input.enabled,
      backend,
      ...(cliExecutable ? { cliExecutable } : {}),
      ...(cliModel ? { cliModel } : {}),
      level: input.level,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
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
    if (input.reviewers) Object.assign(next, { backend: resolved.backend, cliExecutable: resolved.cliExecutable, cliModel: resolved.cliModel })
    await this.persist(next)
    this.settings = next
    return this.getSummary()
  }

  async recordRuleAudit(result: LlmRuleAuditResult): Promise<void> {
    await this.enqueue(async () => {
      const next = { ...this.settings, lastRuleAudit: copyAudit(result) }
      await this.persist(next)
      this.settings = next
    })
  }

  /** Main-process-only import. Credentials are committed encrypted before any summary leaves. */
  async importReviewer(input: Omit<LlmReviewerInput, 'id'>): Promise<LlmReviewSettingsSummary> {
    return this.enqueue(async () => {
      if (!this.codec.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储，审核器未导入')
      if ((this.settings.reviewers?.length ?? 0) >= 30) throw new Error('审核器池最多 30 项')
      const entry = resolveReviewer({ ...input, id: randomUUID() })
      const next = { ...this.settings, reviewers: [...(this.settings.reviewers ?? []), entry] }
      await this.persist(next)
      this.settings = next
      return this.getSummary()
    })
  }

  private async persist(settings: StoredLlmReviewSettings): Promise<void> {
    const ciphertext = Buffer.from(this.codec.encryptString(JSON.stringify(settings))).toString('base64')
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
