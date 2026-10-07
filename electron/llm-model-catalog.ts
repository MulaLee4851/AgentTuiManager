import axios, { type AxiosRequestConfig } from 'axios'

import type { StoredLlmReviewSettings } from './llm-review-settings-store'

const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_MODEL_ENTRIES = 2_000
const MAX_MODEL_ID_LENGTH = 200
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u

type CatalogErrorCode = 'configuration' | 'authentication' | 'rate-limit' | 'http' | 'timeout' | 'network' | 'invalid-response'

const ERROR_MESSAGES: Record<CatalogErrorCode, string> = {
  configuration: '请检查 Base URL、API Key 和代理配置',
  authentication: 'LLM API 请求失败：身份验证或访问权限不足',
  'rate-limit': 'LLM API 请求失败：请求过于频繁，请稍后重试',
  http: 'LLM API 请求失败：服务返回错误状态',
  timeout: 'LLM API 请求超时，请稍后重试',
  network: 'LLM API 请求失败：无法连接模型服务',
  'invalid-response': 'LLM API 请求失败：服务返回的响应格式无效，请检查协议和模型设置',
}

/** Contains only an allowlisted code/message, never an upstream error or request. */
export class LlmModelCatalogError extends Error {
  constructor(readonly code: CatalogErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'LlmModelCatalogError'
  }
}

/** Bare origins use /v1; custom prefixes and explicit endpoints stay consistent. */
export function resolveLlmApiEndpoint(baseUrl: string, resource: 'models' | 'chat/completions' | 'responses' | 'messages'): string {
  try {
    if (typeof baseUrl !== 'string' || !baseUrl.trim() || baseUrl.length > 4_096 || UNSAFE_TEXT.test(baseUrl)) {
      throw new Error()
    }
    const url = new URL(baseUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error()
    }
    // URL.search/hash omit an empty delimiter; disallow those as well.
    if (baseUrl.includes('?') || baseUrl.includes('#')) throw new Error()
    const path = url.pathname.replace(/\/+$/u, '')
    const prefix = path ? path.replace(/\/(?:chat\/completions|models|responses|messages)$/iu, '') : '/v1'
    url.pathname = `${prefix}/${resource}`
    return url.toString()
  } catch {
    throw new LlmModelCatalogError('configuration')
  }
}

export function configuredProxy(settings: StoredLlmReviewSettings) {
  if (!settings.proxyEnabled) return false as const
  const host = settings.proxyHost?.trim()
  if (!host || /[\s/@?#\\]/u.test(host) || UNSAFE_TEXT.test(host)
    || !Number.isInteger(settings.proxyPort) || settings.proxyPort < 1 || settings.proxyPort > 65_535) {
    throw new LlmModelCatalogError('configuration')
  }
  try {
    const proxyUrl = new URL(`http://${host}`)
    if (!proxyUrl.hostname || proxyUrl.hostname.toLowerCase() !== host.toLowerCase()
      || proxyUrl.port || proxyUrl.username || proxyUrl.password) throw new Error()
  } catch {
    throw new LlmModelCatalogError('configuration')
  }
  return {
    protocol: 'http', host, port: settings.proxyPort,
    ...(settings.proxyUsername ? { auth: { username: settings.proxyUsername, password: settings.proxyPassword ?? '' } } : {}),
  }
}

export function llmApiHeaders(settings: Pick<StoredLlmReviewSettings, 'apiKey' | 'protocol' | 'anthropicAuth'>): Record<string, string> {
  const apiKey = settings.apiKey?.trim()
  if (!apiKey || apiKey.length > 16384 || UNSAFE_TEXT.test(settings.apiKey!)) throw new LlmModelCatalogError('configuration')
  return settings.protocol === 'anthropic-messages'
    ? { ...(settings.anthropicAuth === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }), 'anthropic-version': '2023-06-01', Accept: 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
}

export function protectedLlmApiValues(settings: Pick<StoredLlmReviewSettings, 'apiKey' | 'proxyPassword' | 'proxyUsername' | 'reviewers'>): string[] {
  const values = new Set<string>()
  for (const value of [settings.apiKey, settings.proxyPassword, ...(settings.reviewers?.map(entry => entry.apiKey) ?? [])]) {
    if (typeof value !== 'string' || !value) continue
    for (const variant of [value, value.trim()]) {
      if (!variant) continue
      values.add(variant)
      values.add(encodeURIComponent(variant))
      values.add(Buffer.from(variant, 'utf8').toString('base64'))
    }
  }
  if (settings.proxyUsername && settings.proxyPassword) {
    values.add(Buffer.from(`${settings.proxyUsername}:${settings.proxyPassword}`, 'utf8').toString('base64'))
  }
  return [...values]
}

function parseModelIds(body: unknown, secrets: readonly string[]): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LlmModelCatalogError('invalid-response')
  const entries = (body as Record<string, unknown>).data
  if (!Array.isArray(entries) || entries.length > MAX_MODEL_ENTRIES) throw new LlmModelCatalogError('invalid-response')
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const value: unknown = (entry as Record<string, unknown>).id
    if (typeof value !== 'string' || value.length > MAX_MODEL_ID_LENGTH || UNSAFE_TEXT.test(value)) continue
    const id = value.trim()
    if (!id || secrets.some(secret => id.includes(secret))) continue
    ids.add(id)
  }
  return [...ids]
}

function statusError(status: number): LlmModelCatalogError {
  if (status === 401 || status === 403) return new LlmModelCatalogError('authentication')
  if (status === 429) return new LlmModelCatalogError('rate-limit')
  return new LlmModelCatalogError('http')
}

/** Safe for IPC/UI: upstream error messages, URLs, bodies and configs are discarded. */
export function safeLlmApiError(error: unknown): Error {
  if (error instanceof LlmModelCatalogError && Object.hasOwn(ERROR_MESSAGES, error.code)) {
    return new LlmModelCatalogError(error.code)
  }
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return new LlmModelCatalogError('timeout')
    if (typeof error.response?.status === 'number') return statusError(error.response.status)
  }
  return new LlmModelCatalogError('network')
}

/** Shared bounded transport for provider and reviewer model catalogs. */
export async function requestLlmModels(endpoint: string, options: {
  headers: Record<string, string>
  timeout: number
  proxy?: AxiosRequestConfig['proxy']
  secrets: readonly string[]
}): Promise<string[]> {
  try {
    const response = await axios.get<unknown>(endpoint, {
      headers: options.headers,
      ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      timeout: options.timeout,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      responseType: 'json',
      validateStatus: () => true,
    })
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw statusError(response.status)
    return parseModelIds(response.data, options.secrets)
  } catch (error) {
    throw safeLlmApiError(error)
  }
}

/** Fetches in the main process; neither credentials nor upstream bodies leave here. */
export async function listLlmReviewModels(settings: StoredLlmReviewSettings): Promise<string[]> {
  try {
    const apiKey = settings.apiKey?.trim()
    if (!apiKey || apiKey.length > 16_384 || UNSAFE_TEXT.test(settings.apiKey!)) throw new LlmModelCatalogError('configuration')
    const endpoint = resolveLlmApiEndpoint(settings.baseUrl ?? '', 'models')
    const proxy = configuredProxy(settings)
    const secrets = protectedLlmApiValues(settings)
    const timeoutSeconds = Number.isFinite(settings.timeoutSeconds) ? Math.max(1, Math.min(60, settings.timeoutSeconds)) : 30
    return await requestLlmModels(endpoint, {
      headers: llmApiHeaders(settings),
      proxy,
      timeout: timeoutSeconds * 1_000,
      secrets,
    })
  } catch (error) {
    // Do not attach causes, stringify errors, or expose axios request/response/config.
    throw safeLlmApiError(error)
  }
}
