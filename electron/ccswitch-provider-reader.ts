import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import initSqlJs from 'sql.js'
import type { Database, SqlJsStatic } from 'sql.js'
import { parse as parseToml } from 'smol-toml'

import type { AgentConfigInput, CCSwitchProviderSummary } from '../src/shared/manager-api'

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
    const parsed = new URL(candidate)
    return ['http:', 'https:'].includes(parsed.protocol) ? candidate : undefined
  } catch {
    return undefined
  }
}

function parsedResult(row: CCSwitchProviderRow, baseUrl?: string, apiKey?: string, model?: string): ParsedProvider {
  const missing = [!baseUrl ? 'Base URL' : '', !apiKey ? 'API Key' : ''].filter(Boolean)
  return {
    id: row.id,
    name: row.name,
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
  return parsedResult(
    row,
    validBaseUrl(env.ANTHROPIC_BASE_URL) ?? validBaseUrl(row.endpointUrl),
    nonEmpty(env.ANTHROPIC_AUTH_TOKEN) ?? nonEmpty(env.ANTHROPIC_API_KEY),
    nonEmpty(env.ANTHROPIC_MODEL),
  )
}

function parseCodex(row: CCSwitchProviderRow, settings: Record<string, unknown>): ParsedProvider {
  const auth = object(settings.auth) ?? {}
  const configText = nonEmpty(settings.config)
  const config = configText ? object(parseToml(configText)) ?? {} : {}
  const providerId = nonEmpty(config.model_provider)
  const providers = object(config.model_providers) ?? {}
  const provider = providerId ? object(providers[providerId]) : undefined
  return parsedResult(
    row,
    validBaseUrl(provider?.base_url) ?? validBaseUrl(row.endpointUrl),
    nonEmpty(auth.OPENAI_API_KEY),
    nonEmpty(config.model),
  )
}

export function parseCCSwitchProvider(row: CCSwitchProviderRow): ParsedProvider {
  try {
    const settings = object(JSON.parse(row.settingsConfig))
    if (!settings) throw new Error('配置不是 JSON 对象')
    return row.appType === 'claude' ? parseClaude(row, settings) : parseCodex(row, settings)
  } catch (error) {
    return {
      id: row.id,
      name: row.name,
      agentKind: row.appType,
      isCurrent: row.isCurrent,
      hasApiKey: false,
      issue: `Provider 配置无法解析：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function queryRows(database: Database, agentKind: SupportedAgentKind): CCSwitchProviderRow[] {
  const statement = database.prepare(`
    SELECT p.id, p.app_type, p.name, p.settings_config, p.is_current,
      (SELECT e.url FROM provider_endpoints e
       WHERE e.provider_id = p.id AND e.app_type = p.app_type
       ORDER BY e.added_at DESC LIMIT 1) AS endpoint_url
    FROM providers p
    WHERE p.app_type = ?
    ORDER BY p.is_current DESC, p.sort_index ASC, p.created_at DESC
  `)
  try {
    statement.bind([agentKind])
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

export class CCSwitchProviderReader {
  constructor(private readonly databasePath = join(homedir(), '.cc-switch', 'cc-switch.db')) {}

  async list(agentKind: SupportedAgentKind): Promise<CCSwitchProviderSummary[]> {
    return (await this.read(agentKind)).map(({ apiKey: _apiKey, ...summary }) => summary)
  }

  async import(agentKind: SupportedAgentKind, providerId: string): Promise<AgentConfigInput> {
    const provider = (await this.read(agentKind)).find((item) => item.id === providerId)
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

  private async read(agentKind: SupportedAgentKind): Promise<ParsedProvider[]> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.databasePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error('未找到 CCSwitch 数据库，请先安装并打开 CCSwitch')
      throw new Error(`读取 CCSwitch 数据库失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const SQL = await sql()
    const database = new SQL.Database(bytes)
    try {
      return queryRows(database, agentKind).map(parseCCSwitchProvider)
    } catch (error) {
      throw new Error(`CCSwitch 数据库格式不兼容：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      database.close()
    }
  }
}
