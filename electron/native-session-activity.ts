import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentKind, SessionSummary } from '../src/shared/manager-api'
import type { SessionActivity } from '../src/shared/session-state'

export interface NativeActivityEvent {
  activity: SessionActivity
  timestamp: number
  error?: string
  userMessage?: { text: string; timestamp: number }
  assistantMessage?: { text: string; timestamp: number }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function parseNativeActivity(kind: AgentKind, value: unknown, sessionId: string): NativeActivityEvent | undefined {
  const record = object(value)
  if (!record || record.isSidechain === true || record.agentId
    || typeof record.sessionId === 'string' && record.sessionId !== sessionId) return undefined
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Date.parse(String(record.timestamp ?? ''))
  if (!Number.isFinite(timestamp)) return undefined
  const result = (activity: SessionActivity, error?: unknown): NativeActivityEvent => ({
    activity, timestamp, ...(typeof error === 'string' ? { error: error.slice(0, 2000) } : {}),
  })
  if (kind === 'codex') {
    const payload = object(record.payload)
    if (!payload) return undefined
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        return { ...result('running'), userMessage: { text: payload.message, timestamp } }
      }
      if (payload.type === 'task_started' || payload.type === 'user_message') return result('running')
      if (payload.type === 'task_complete') return { ...result(payload.error ? 'error' : 'completed',
        payload.error ? object(payload.error)?.message ?? (typeof payload.error === 'string' ? payload.error : 'Codex 当前任务异常结束') : undefined),
        ...(typeof payload.last_agent_message === 'string' ? { assistantMessage: { text: payload.last_agent_message, timestamp } } : {}) }
      if (payload.type === 'turn_aborted') return result('idle')
      if (payload.type === 'error') return result(payload.will_retry === true ? 'running' : 'error', payload.message)
    }
    if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type))) return result('running')
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase !== 'commentary') {
      const text = Array.isArray(payload.content) ? payload.content.filter(item => object(item)?.type === 'output_text')
        .map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : ''
      if (text) return { ...result('running'), assistantMessage: { text, timestamp } }
    }
  } else if (kind === 'claude') {
    const message = object(record.message)
    if (record.type === 'assistant' && record.isApiErrorMessage === true) {
      const text = Array.isArray(message?.content)
        ? message.content.map((item: unknown) => object(item)?.text).filter((item): item is string => typeof item === 'string').join('\n')
        : 'Claude Code 请求失败'
      return result('error', text)
    }
    if (record.type === 'user' && record.isMeta !== true) {
      const content = message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        && content.every(item => object(item)?.type === 'text')
        ? content.map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : undefined
      return { ...result('running'), ...(text ? { userMessage: { text, timestamp } } : {}) }
    }
    if (record.type === 'assistant' && message) {
      const text = Array.isArray(message.content) ? message.content.filter(item => object(item)?.type === 'text')
        .map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : ''
      return { ...result(['end_turn', 'stop_sequence'].includes(String(message.stop_reason)) ? 'completed' : 'running'),
        ...(text ? { assistantMessage: { text, timestamp } } : {}) }
    }
    if (record.type === 'system' && record.subtype === 'turn_duration') return result('completed')
  }
  return undefined
}

interface FileCursor { path: string; size: number; mtime: number }

/** Read-only, bounded tail polling. Never sends input or changes approval/recovery. */
export class NativeSessionActivityMonitor {
  private readonly files = new Map<string, FileCursor>()
  private readonly missingUntil = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private readonly sessions: () => SessionSummary[],
    private readonly onActivity: (session: SessionSummary, event: NativeActivityEvent) => void,
    private readonly roots = {
      codex: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
      claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    },
  ) {}

  start(): void {
    this.stopped = false
    const tick = async (): Promise<void> => {
      try { await this.poll() } finally {
        if (!this.stopped) {
          this.timer = setTimeout(() => { void tick() }, 2000)
          this.timer.unref?.()
        }
      }
    }
    void tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  async poll(): Promise<void> {
    const sessions = this.sessions().filter((session) => session.nativeSessionId
      && (session.agentKind === 'codex' || session.agentKind === 'claude')
      && (!['completed', 'stopped', 'failed'].includes(session.status) || session.unattended?.enabled))
    const activeKeys = new Set(sessions.map((session) => this.key(session)))
    for (const key of this.files.keys()) if (!activeKeys.has(key)) this.files.delete(key)
    for (const key of this.missingUntil.keys()) if (!activeKeys.has(key)) this.missingUntil.delete(key)
    for (const session of sessions) {
      const key = this.key(session)
      try {
        let cursor = this.files.get(key)
        if (!cursor) {
          if ((this.missingUntil.get(key) ?? 0) > Date.now()) continue
          const path = await this.findFile(session.agentKind as 'codex' | 'claude', session.nativeSessionId!)
          if (!path) { this.missingUntil.set(key, Date.now() + 30_000); continue }
          cursor = { path, size: -1, mtime: -1 }
          this.files.set(key, cursor)
          this.missingUntil.delete(key)
        }
        const stat = await fs.stat(cursor.path)
        if (stat.size === cursor.size && stat.mtimeMs === cursor.mtime) continue
        const file = await fs.open(cursor.path, 'r')
        let text: string
        try {
          const offset = Math.max(0, stat.size - 512 * 1024)
          const buffer = Buffer.alloc(stat.size - offset)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          text = buffer.subarray(0, bytesRead).toString('utf8')
          if (offset > 0) text = text.slice(text.indexOf('\n') + 1)
        } finally { await file.close() }
        let latest: NativeActivityEvent | undefined
        let userMessage: NativeActivityEvent['userMessage']
        let assistantMessage: NativeActivityEvent['assistantMessage']
        // Ignore the last partial JSONL record; revisit it after the next append.
        for (const line of text.split('\n').slice(0, -1)) {
          let value: unknown
          try { value = JSON.parse(line) } catch { continue }
          const event = parseNativeActivity(session.agentKind, value, session.nativeSessionId!)
          if (event?.userMessage && event.timestamp >= (session.activitySince ?? 0)
            && (!userMessage || event.timestamp >= userMessage.timestamp)) userMessage = event.userMessage
          if (event?.assistantMessage && event.timestamp >= (session.activitySince ?? 0)
            && (!assistantMessage || event.timestamp >= assistantMessage.timestamp)) assistantMessage = event.assistantMessage
          if (event && event.timestamp >= (session.activitySince ?? 0)
            && event.timestamp >= (session.activityUpdatedAt ?? 0)
            && (!latest || event.timestamp >= latest.timestamp)) latest = event
        }
        cursor.size = stat.size
        cursor.mtime = stat.mtimeMs
        if (latest && !this.stopped) this.onActivity(session, { ...latest, ...(userMessage ? { userMessage } : {}), ...(assistantMessage ? { assistantMessage } : {}) })
        else if (assistantMessage && !this.stopped) {
          this.onActivity(session, { activity: 'running', timestamp: assistantMessage.timestamp, assistantMessage, ...(userMessage ? { userMessage } : {}) })
        }
        else if (userMessage && !this.stopped) {
          // Evidence may predate an optimistic UI activity update. Deliver it
          // without rolling that activity back in the controller.
          this.onActivity(session, { activity: 'running', timestamp: userMessage.timestamp, userMessage })
        }
      } catch {
        // Missing/rotated/unreadable transcripts must not interrupt the Agent.
        this.files.delete(key)
        this.missingUntil.set(key, Date.now() + 30_000)
      }
    }
  }

  private key(session: SessionSummary): string {
    return [session.sessionId, session.nativeSessionId, session.activitySince ?? 0].join(':')
  }

  private async findFile(kind: 'codex' | 'claude', id: string): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) return undefined
    const directories = [this.roots[kind]]
    let visited = 0
    while (directories.length && visited < 20_000) {
      const directory = directories.pop()!
      let entries
      try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (++visited > 20_000) break
        if (entry.isDirectory() && entry.name !== 'subagents') directories.push(join(directory, entry.name))
        else if (entry.isFile() && (kind === 'claude' ? entry.name === id + '.jsonl'
          : entry.name.startsWith('rollout-') && entry.name.endsWith('-' + id + '.jsonl'))) return join(directory, entry.name)
      }
    }
    return undefined
  }
}
