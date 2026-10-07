import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import initSqlJs from 'sql.js'
import type { Database, SqlJsStatic } from 'sql.js'
import { parse as parseToml } from 'smol-toml'

import type { AgentConfigInput, CCSwitchProviderSummary, LlmApiProtocol, LlmReviewerInput } from '../src/shared/manager-api'
import { resolveLlmApiEndpoint } from './llm-model-catalog'
import { redactLlmCredentialText } from './llm-response-privacy'

type SupportedAgentKind = 'codex' | 'claude'

export interface CCSwitchProviderRow {
  id: string
  appType: SupportedAgentKind
  name: string
  settingsConfig: string
  endpointUrl?: string
  isCurrent: boolean
}

interface ParsedProvider extends CCSwitchProviderSummary {
  apiKey?: string
  protocol?: LlmApiProtocol
  anthropicAuth?: 'api-key' | 'bearer'
}

let sqlPromise: Promise<SqlJsStatic> | undefined

function sql(): Promise<SqlJsStatic> {
  sqlPromise ??= readFile(require.resolve('sql.js/dist/sql-wasm.wasm'))
    .then((wasmBinary) => initSqlJs({
      wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer,
    }))
  return sqlPromise
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function validBaseUrl(value: unknown): string | undefined {
  const candidate = nonEmpty(value)
  if (!candidate) return undefined
  try {
    resolveLlmApiEndpoint(candidate, 'models')
    return candidate
  } catch {
    return undefined
  }
}

function parsedResult(row: CCSwitchProviderRow, baseUrl?: string, apiKey?: string, model?: string): ParsedProvider {
  const variants = apiKey ? [apiKey, encodeURIComponent(apiKey), Buffer.from(apiKey).toString('base64')] : []
  const safe = (value?: string) => value && !variants.some(secret => value.includes(secret)) ? value : undefined
  baseUrl = safe(baseUrl)
  model = safe(model)
  const missing = [!baseUrl ? 'Base URL' : '', !apiKey ? 'API Key' : ''].filter(Boolean)
  return {
    id: row.id,
    name: safe(row.name) ?? '受保护的 Provider 配置',
    agentKind: row.appType,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    isCurrent: row.isCurrent,
    hasApiKey: Boolean(apiKey),
    ...(apiKey ? { apiKey } : {}),
    ...(missing.length ? { issue: `缺少 ${missing.join(' 和 ')}` } : {}),
  }
}

function parseClaude(row: CCSwitchProviderRow, settings: Record<string, unknown>): ParsedProvider {
  const env = object(settings.env) ?? {}
  if (row.id === 'claude-official' && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    return { ...parsedResult(row), issue: '使用 Claude Code 官方登录；请关闭独立配置并确认 CLI 当前登录账号' }
  }
  return { ...parsedResult(
    row,
    validBaseUrl(env.ANTHROPIC_BASE_URL) ?? validBaseUrl(row.endpointUrl),
    nonEmpty(env.ANTHROPIC_AUTH_TOKEN) ?? nonEmpty(env.ANTHROPIC_API_KEY),
    nonEmpty(env.ANTHROPIC_MODEL),
  ), protocol: 'anthropic-messages', anthropicAuth: nonEmpty(env.ANTHROPIC_AUTH_TOKEN) ? 'bearer' : 'api-key' }
}

function parseCodex(row: CCSwitchProviderRow, settings: Record<string, unknown>): ParsedProvider {
  const auth = object(settings.auth) ?? {}
  if (!nonEmpty(auth.OPENAI_API_KEY) && (auth.tokens || auth.auth_mode === 'chatgpt')) {
    return { ...parsedResult(row), issue: '使用 Codex CLI 登录，无法导入为独立 API 配置；请关闭独立配置并确认 CLI 当前登录账号' }
  }
  const configText = nonEmpty(settings.config)
  const config = configText ? object(parseToml(configText)) ?? {} : {}
  const providerId = nonEmpty(config.model_provider)
  const providers = object(config.model_providers) ?? {}
  const provider = providerId ? object(providers[providerId]) : undefined
  return { ...parsedResult(
    row,
    validBaseUrl(provider?.base_url) ?? validBaseUrl(row.endpointUrl),
    nonEmpty(auth.OPENAI_API_KEY),
    nonEmpty(config.model),
  ), protocol: provider?.wire_api === 'chat' ? 'openai-chat' : 'openai-responses' }
}

export function parseCCSwitchProvider(row: CCSwitchProviderRow): ParsedProvider {
  try {
    const settings = object(JSON.parse(row.settingsConfig))
    if (!settings) throw new Error('配置不是 JSON 对象')
    return row.appType === 'claude' ? parseClaude(row, settings) : parseCodex(row, settings)
  } catch {
    return {
      id: row.id,
      name: row.name,
      agentKind: row.appType,
      isCurrent: row.isCurrent,
      hasApiKey: false,
      issue: 'Provider 配置无法解析，请在 CC Switch 中检查 JSON／TOML 格式',
    }
  }
}

function queryRows(database: Database, agentKind: SupportedAgentKind, providerId?: string): CCSwitchProviderRow[] {
  const statement = database.prepare(`
    SELECT p.id, p.app_type, p.name, p.settings_config, p.is_current,
      (SELECT e.url FROM provider_endpoints e
       WHERE e.provider_id = p.id AND e.app_type = p.app_type
       ORDER BY e.added_at DESC LIMIT 1) AS endpoint_url
    FROM providers p
    WHERE p.app_type = ? ${providerId === undefined ? '' : 'AND p.id = ?'}
    ORDER BY p.is_current DESC, p.sort_index ASC, p.created_at DESC
  `)
  try {
    statement.bind(providerId === undefined ? [agentKind] : [agentKind, providerId])
    const rows: CCSwitchProviderRow[] = []
    while (statement.step()) {
      const value = statement.getAsObject()
      rows.push({
        id: String(value.id),
        appType: String(value.app_type) as SupportedAgentKind,
        name: String(value.name),
        settingsConfig: String(value.settings_config),
        ...(nonEmpty(value.endpoint_url) ? { endpointUrl: String(value.endpoint_url) } : {}),
        isCurrent: Boolean(value.is_current),
      })
    }
    return rows
  } finally {
    statement.free()
  }
}

function defaultAppPathsFile(): string {
  const configRoot = process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configRoot, 'com.ccswitch.desktop', 'app_paths.json')
}

/** Follow CC Switch's own directory setting on every refresh/import. */
export async function resolveCCSwitchDatabasePath(appPathsFile = defaultAppPathsFile(), homeDirectory = homedir()): Promise<string> {
  let content: string
  try { content = await readFile(appPathsFile, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(homeDirectory, '.cc-switch', 'cc-switch.db')
    throw new Error('无法读取 CC Switch 数据目录设置，请检查 app_paths.json 的访问权限')
  }
  let settings: Record<string, unknown> | undefined
  try { settings = object(JSON.parse(content)) } catch { /* Do not echo configuration contents. */ }
  if (!settings) throw new Error('CC Switch 的 app_paths.json 格式无效，请在 CC Switch 中检查数据目录设置')
  const override = settings.app_config_dir_override
  if (override == null || override === '') return join(homeDirectory, '.cc-switch', 'cc-switch.db')
  if (typeof override !== 'string' || !isAbsolute(override.trim())) throw new Error('CC Switch 自定义数据目录必须是绝对路径')
  return join(override.trim(), 'cc-switch.db')
}

export class CCSwitchProviderReader {
  constructor(private readonly databasePath?: string, private readonly appPathsFile = defaultAppPathsFile(), private readonly homeDirectory = homedir()) {}

  async list(agentKind: SupportedAgentKind): Promise<CCSwitchProviderSummary[]> {
    const providers = await this.read(agentKind)
    const redact = (text: string): string => providers.reduce((result, provider) => redactLlmCredentialText(result, { apiKey: provider.apiKey }), text)
    return providers.filter(provider => redact(provider.id) === provider.id)
      .map(({ apiKey: _apiKey, protocol: _protocol, anthropicAuth: _anthropicAuth, ...summary }) => ({ ...summary,
        name: redact(summary.name), ...(summary.baseUrl ? { baseUrl: redact(summary.baseUrl) } : {}),
        ...(summary.model ? { model: redact(summary.model) } : {}) }))
  }

  async import(agentKind: SupportedAgentKind, providerId: string): Promise<AgentConfigInput> {
    const provider = (await this.read(agentKind, providerId))[0]
    if (!provider) throw new Error('CCSwitch 中找不到这个 Provider，请刷新后重新选择')
    if (provider.issue || !provider.baseUrl || !provider.apiKey) {
      throw new Error(`${provider.name} 无法导入：${provider.issue ?? '配置不完整'}`)
    }
    return {
      enabled: true,
      source: 'ccswitch',
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      ...(provider.model ? { model: provider.model } : {}),
      extraArgs: [],
      providerId: provider.id,
      providerName: provider.name,
    }
  }

  /** Imports one selected connection; unrelated provider settings are never parsed. */
  async importForReview(agentKind: SupportedAgentKind, providerId: string): Promise<Omit<LlmReviewerInput, 'id'>> {
    const provider = (await this.read(agentKind, providerId))[0]
    if (!provider || provider.issue || !provider.apiKey || !provider.baseUrl) throw new Error('所选 Provider 的 API 配置不完整，请检查后重试')
    return { name: provider.name.slice(0, 100), enabled: false, backend: 'api', protocol: provider.protocol,
      anthropicAuth: provider.anthropicAuth, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model }
  }

  private async read(agentKind: SupportedAgentKind, providerId?: string): Promise<ParsedProvider[]> {
    const databasePath = this.databasePath ?? await resolveCCSwitchDatabasePath(this.appPathsFile, this.homeDirectory)
    let bytes: Buffer
    try {
      bytes = await readFile(databasePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error(`未找到 CCSwitch 数据库：${databasePath}。请检查 CC Switch 当前数据目录`)
      throw new Error(`读取 CCSwitch 数据库失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const SQL = await sql()
    const database = new SQL.Database(bytes)
    try {
      return queryRows(database, agentKind, providerId).map(parseCCSwitchProvider)
    } catch (error) {
      throw new Error(`CCSwitch 数据库格式不兼容：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      database.close()
    }
  }
}
