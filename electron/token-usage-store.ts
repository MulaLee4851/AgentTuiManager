import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { AgentKind, SessionSummary, TokenUsageAccuracy, TokenUsagePage, TokenUsageQuery, TokenUsageRecord, TokenUsageSummary } from '../src/shared/manager-api'
import { readNativeSessionUsage } from './native-session-usage'

interface CacheEntry { signature: string; records: TokenUsageRecord[] }
type ConfigSnapshot = SessionSummary['agentConfig']

function clean(value: string | undefined): string | undefined { return value?.trim() || undefined }
function sameWorkspace(a: string, b: string): boolean { return a.replace(/[\\/]+$/, '').toLocaleLowerCase() === b.replace(/[\\/]+$/, '').toLocaleLowerCase() }
function accuracy(records: TokenUsageRecord[]): TokenUsageAccuracy { return records.every((record) => record.accuracy === 'exact') ? 'exact' : records.some((record) => record.accuracy === 'estimated') ? 'estimated' : 'unknown' }
function label(session: SessionSummary): string { return `${session.displayName} · ${session.agentConfig?.model ?? '继承模型'}` }

export class TokenUsageStore {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly configHistory = new Map<string, Array<{ timestamp: number; config?: ConfigSnapshot }>>()
  private refreshInFlight: Promise<void> | undefined

  constructor(private readonly filePath?: string) {}

  noteSessionConfig(sessionId: string, config: ConfigSnapshot, timestamp = Date.now()): void {
    const history = this.configHistory.get(sessionId) ?? []
    history.push({ timestamp, config }); history.sort((a, b) => a.timestamp - b.timestamp)
    this.configHistory.set(sessionId, history.slice(-100))
  }

  private configAt(sessionId: string, timestamp: number, fallback?: ConfigSnapshot): ConfigSnapshot {
    const history = this.configHistory.get(sessionId) ?? []
    let selected = fallback
    for (const item of history) if (item.timestamp <= timestamp) selected = item.config
    return selected
  }

  async load(): Promise<void> {
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records) ? (parsed as { records: unknown[] }).records : []
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { configHistory?: unknown }).configHistory)) {
        for (const item of (parsed as { configHistory: unknown[] }).configHistory) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const value = item as { sessionId?: unknown; timestamp?: unknown; config?: ConfigSnapshot }
          if (typeof value.sessionId === 'string' && typeof value.timestamp === 'number') this.noteSessionConfig(value.sessionId, value.config, value.timestamp)
        }
      }
      for (const item of records) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const record = item as TokenUsageRecord
        if (typeof record.id === 'string' && typeof record.sessionId === 'string') {
          const current = this.cache.get(record.sessionId)
          this.cache.set(record.sessionId, { signature: 'persisted', records: [...(current?.records ?? []), record] })
        }
      }
    } catch { /* first run */ }
  }

  async refresh(sessions: SessionSummary[]): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.refreshInternal(sessions).finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  private async refreshInternal(sessions: SessionSummary[]): Promise<void> {
    for (const session of sessions) {
      if (!session.nativeSessionId || (session.agentKind !== 'codex' && session.agentKind !== 'claude')) continue
      const native = await readNativeSessionUsage(session.agentKind, session.nativeSessionId)
      const records = native.map((event): TokenUsageRecord => {
        const config = this.configAt(session.sessionId, event.timestamp, session.agentConfig)
        return ({
        id: `${session.sessionId}:${event.sourceKey}`,
        timestamp: event.timestamp,
        sessionId: session.sessionId,
        nativeSessionId: session.nativeSessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        agentKind: session.agentKind,
        workspace: session.workspace,
        ...(config?.profileId ? { profileId: config.profileId } : {}),
        ...(event.providerId ?? config?.providerId ? { providerId: event.providerId ?? config?.providerId } : {}),
        ...(config?.providerName ? { providerName: config.providerName } : {}),
        ...(event.model ?? config?.model ? { model: event.model ?? config?.model } : {}),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        reasoningTokens: event.reasoningTokens,
        totalTokens: event.totalTokens,
        source: event.sourceKey.includes('.claude') ? 'claude-session' : 'codex-session',
        accuracy: 'exact',
        ...(event.subagent ? { subagent: true } : {}),
      })
      })
      const signature = records.map((record) => record.id).join('|')
      this.cache.set(session.sessionId, { signature, records })
    }
    await this.persist()
  }

  async listDetails(query: TokenUsageQuery = {}, sessions: SessionSummary[] = []): Promise<TokenUsagePage> {
    await this.refresh(sessions)
    const records = [...this.cache.values()].flatMap((entry) => entry.records).filter((record) => {
      if (!query.includeSubagents && record.subagent) return false
      if (query.sessionId && record.sessionId !== query.sessionId) return false
      if (query.agentKind && record.agentKind !== query.agentKind) return false
      if (query.workspace && !sameWorkspace(record.workspace, query.workspace)) return false
      if (query.profileId && record.profileId !== query.profileId) return false
      if (query.providerId && record.providerId !== query.providerId) return false
      if (query.model && record.model !== query.model) return false
      if (query.from && record.timestamp < query.from) return false
      if (query.to && record.timestamp > query.to) return false
      if (query.accuracy && query.accuracy !== 'all' && record.accuracy !== query.accuracy) return false
      return true
    }).sort((a, b) => b.timestamp - a.timestamp)
    const pageSize = Math.max(1, Math.min(500, query.pageSize ?? 100))
    const page = Math.max(1, query.page ?? 1)
    return { records: records.slice((page - 1) * pageSize, page * pageSize), total: records.length, page, pageSize }
  }

  async listSummary(query: TokenUsageQuery = {}, sessions: SessionSummary[] = []): Promise<TokenUsageSummary[]> {
    const details = await this.listDetails({ ...query, page: 1, pageSize: 100_000 }, sessions)
    const groupBy = query.groupBy ?? 'session'
    const grouped = new Map<string, TokenUsageSummary>()
    for (const record of details.records) {
      const key = groupBy === 'session' ? record.sessionId
        : groupBy === 'config' ? `${record.providerId ?? ''}:${record.profileId ?? ''}:${record.model ?? ''}`
          : groupBy === 'model' ? (record.model ?? '未指定模型')
            : groupBy === 'workspace' ? record.workspace
              : groupBy === 'day' ? new Date(record.timestamp).toISOString().slice(0, 10)
                : new Date(record.timestamp).toISOString().slice(0, 13)
      const session = sessions.find((item) => item.sessionId === record.sessionId)
      const current = grouped.get(key) ?? {
        key,
        label: groupBy === 'session' && session ? label(session) : key || '未配置',
        ...(groupBy === 'session' ? { sessionId: record.sessionId, agentKind: record.agentKind, workspace: record.workspace } : {}),
        ...(record.profileId ? { profileId: record.profileId } : {}),
        ...(record.providerId ? { providerId: record.providerId } : {}),
        ...(record.providerName ? { providerName: record.providerName } : {}),
        ...(record.model ? { model: record.model } : {}),
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, requestCount: 0,
        accuracy: 'exact' as const,
      }
      current.inputTokens += record.inputTokens; current.outputTokens += record.outputTokens; current.cacheReadTokens += record.cacheReadTokens; current.cacheWriteTokens += record.cacheWriteTokens; current.reasoningTokens += record.reasoningTokens; current.totalTokens += record.totalTokens; current.requestCount += 1; current.lastTimestamp = Math.max(current.lastTimestamp ?? 0, record.timestamp); current.accuracy = accuracy([...(details.records.filter((item) => item.sessionId === record.sessionId))])
      grouped.set(key, current)
    }
    return [...grouped.values()].sort((a, b) => (b.totalTokens - a.totalTokens))
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    const records = [...this.cache.values()].flatMap((entry) => entry.records)
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const configHistory = [...this.configHistory.entries()].flatMap(([sessionId, history]) => history.map((item) => ({ sessionId, ...item })))
    await fs.writeFile(this.filePath, JSON.stringify({ version: 1, records, configHistory }), 'utf8').catch(() => undefined)
  }
}
