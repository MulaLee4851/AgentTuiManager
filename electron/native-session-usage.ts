import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import type { AgentKind } from '../src/shared/manager-api'

const MAX_FILES = 20_000

export interface NativeUsageEvent {
  sourceKey: string
  timestamp: number
  turnId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  subagent?: boolean
  model?: string
  providerId?: string
  providerName?: string
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const current = number(value[key])
    if (current > 0) return current
  }
  return 0
}

function usage(value: unknown): Omit<NativeUsageEvent, 'sourceKey' | 'timestamp' | 'turnId' | 'subagent'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const inputTokens = firstNumber(item, ['input_tokens', 'inputTokens', 'prompt_tokens'])
  const outputTokens = firstNumber(item, ['output_tokens', 'outputTokens', 'completion_tokens'])
  const cacheReadTokens = firstNumber(item, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_tokens'])
  const cacheWriteTokens = firstNumber(item, ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_write_tokens'])
  const reasoningTokens = firstNumber(item, ['reasoning_output_tokens', 'reasoning_tokens', 'reasoningTokens'])
  const totalTokens = firstNumber(item, ['total_tokens', 'totalTokens']) || inputTokens + outputTokens
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens + totalTokens === 0) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens }
}

function timestamp(record: Record<string, unknown>): number | undefined {
  const value = record.timestamp ?? record.created_at ?? record.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function matchingJsonl(root: string, sessionId: string): Promise<string | undefined> {
  const pending = [root]
  let visited = 0
  while (pending.length > 0 && visited < MAX_FILES) {
    const directory = pending.pop()!
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited += 1
      if (visited >= MAX_FILES) break
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && basename(path).includes(sessionId) && path.toLocaleLowerCase('en-US').endsWith('.jsonl')) return path
    }
  }
  return undefined
}

function codexUsage(record: Record<string, unknown>): { event?: Omit<NativeUsageEvent, 'sourceKey'>; cumulative?: Omit<NativeUsageEvent, 'sourceKey'> } | undefined {
  if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) return undefined
  const payload = record.payload as Record<string, unknown>
  if (payload.type !== 'token_count') return undefined
  const info = payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info) ? payload.info as Record<string, unknown> : payload
  const last = usage(info.last_token_usage)
  const total = usage(info.total_token_usage)
  if (!last && !total) return undefined
  const turnId = stringValue(record.turn_id ?? payload.turn_id ?? info.turn_id)
  const occurredAt = timestamp(record)
  const make = (item: ReturnType<typeof usage>) => item && occurredAt !== undefined ? { ...item, timestamp: occurredAt, ...(turnId ? { turnId } : {}) } : undefined
  return { event: make(last), cumulative: make(total) }
}

function claudeUsage(record: Record<string, unknown>): Omit<NativeUsageEvent, 'sourceKey'> | undefined {
  if (record.type !== 'assistant' && record.type !== 'user') return undefined
  const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message) ? record.message as Record<string, unknown> : undefined
  const item = usage(record.usage ?? message?.usage)
  if (!item) return undefined
  const turnId = stringValue(record.uuid ?? record.id ?? message?.id)
  const model = stringValue(message?.model ?? record.model)
  const occurredAt = timestamp(record)
  if (occurredAt === undefined) return undefined
  return { ...item, timestamp: occurredAt, ...(turnId ? { turnId } : {}), ...(model ? { model } : {}) }
}

export async function readNativeSessionUsage(agentKind: AgentKind, sessionId: string | undefined): Promise<NativeUsageEvent[]> {
  if (!sessionId || !/^[a-zA-Z0-9-]{8,128}$/.test(sessionId)) return []
  if (agentKind !== 'codex' && agentKind !== 'claude') return []
  const root = agentKind === 'codex' ? join(homedir(), '.codex', 'sessions') : join(homedir(), '.claude', 'projects')
  const file = await matchingJsonl(root, sessionId)
  if (!file) return []
  const result: NativeUsageEvent[] = []
  const cumulative = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  let activeModel: string | undefined
  let activeProvider: string | undefined
  let lineNumber = 0
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    lineNumber += 1
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      record = parsed as Record<string, unknown>
    } catch { continue }
    if (agentKind === 'codex' && record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)) {
      const payload = record.payload as Record<string, unknown>
      const settings = payload.thread_settings && typeof payload.thread_settings === 'object' && !Array.isArray(payload.thread_settings) ? payload.thread_settings as Record<string, unknown> : undefined
      const discoveredModel = stringValue(payload.model ?? settings?.model)
      const discoveredProvider = stringValue(payload.model_provider_id ?? settings?.model_provider_id)
      if (discoveredModel) activeModel = discoveredModel
      if (discoveredProvider) activeProvider = discoveredProvider
    }
    const parsed = agentKind === 'codex' ? codexUsage(record) : undefined
    if (parsed?.event || parsed?.cumulative) {
      const item = parsed.event ?? parsed.cumulative!
      const delta = parsed.event ?? {
        ...item,
        inputTokens: Math.max(0, item.inputTokens - cumulative.inputTokens),
        outputTokens: Math.max(0, item.outputTokens - cumulative.outputTokens),
        cacheReadTokens: Math.max(0, item.cacheReadTokens - cumulative.cacheReadTokens),
        cacheWriteTokens: Math.max(0, item.cacheWriteTokens - cumulative.cacheWriteTokens),
        reasoningTokens: Math.max(0, item.reasoningTokens - cumulative.reasoningTokens),
        totalTokens: Math.max(0, item.totalTokens - cumulative.totalTokens),
      }
      if (parsed.cumulative) Object.assign(cumulative, parsed.cumulative)
      if (delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheWriteTokens + delta.reasoningTokens + delta.totalTokens > 0) {
        result.push({ ...delta, sourceKey: `${file}:${lineNumber}`, ...(activeModel && !delta.model ? { model: activeModel } : {}), ...(activeProvider && !delta.providerId ? { providerId: activeProvider } : {}) })
      }
      continue
    }
    const item = agentKind === 'claude' ? claudeUsage(record) : undefined
    if (item && item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens + item.reasoningTokens + item.totalTokens > 0) {
      result.push({ ...item, sourceKey: `${file}:${lineNumber}`, ...(item.model ? {} : activeModel ? { model: activeModel } : {}), ...(activeProvider ? { providerId: activeProvider } : {}) })
    }
  }
  return result
}
