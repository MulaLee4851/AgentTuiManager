import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import type { AgentKind, TerminalHistoryEntry, TerminalHistorySnapshot } from '../src/shared/manager-api'

const MAX_FILES = 20_000
const MAX_HISTORY_CHARACTERS = 160_000

export type TranscriptEntry = TerminalHistoryEntry

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\u001b/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return cleanText(value)
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return ''
      const block = item as Record<string, unknown>
      return block.type === 'text' || block.type === 'input_text' || block.type === 'output_text'
        ? cleanText(block.text)
        : ''
    })
    .filter(Boolean)
    .join('\n')
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return cleanText(value)
  if (value === undefined) return ''
  try { return cleanText(JSON.stringify(value, null, 2)) } catch { return String(value) }
}

function toolCall(name: unknown, input: unknown): Pick<TranscriptEntry, 'title' | 'text'> {
  const label = typeof name === 'string' && name ? name : '未知工具'
  return { title: `工具调用 · ${label}`, text: jsonText(input) }
}

function toolResult(value: unknown): Pick<TranscriptEntry, 'title' | 'text'> {
  return { title: '工具结果', text: jsonText(value) }
}

function appendCodexResponseItem(entries: TranscriptEntry[], payload: Record<string, unknown>): void {
  const type = payload.type
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call') {
    const item = toolCall(payload.name ?? payload.type, payload.arguments ?? payload.input ?? payload.action)
    append(entries, 'tool', item.text, item.title)
  } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'web_search_call_output') {
    const item = toolResult(payload.output ?? payload.result ?? payload.content)
    append(entries, 'tool_result', item.text, item.title)
  }
}

function appendClaudeContent(entries: TranscriptEntry[], value: unknown, role: 'user' | 'agent'): void {
  if (!Array.isArray(value)) {
    const text = contentText(value)
    if (text) append(entries, role, text)
    return
  }
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const block = item as Record<string, unknown>
    if (block.type === 'text') append(entries, role, cleanText(block.text))
    else if (block.type === 'tool_use') {
      const item = toolCall(block.name, block.input)
      append(entries, 'tool', item.text, item.title)
    } else if (block.type === 'tool_result') {
      const item = toolResult(block.content ?? block.output)
      append(entries, 'tool_result', item.text, item.title)
    }
  }
}

async function matchingJsonl(root: string, sessionId: string): Promise<string | undefined> {
  const pending = [root]
  let visited = 0
  while (pending.length > 0 && visited < MAX_FILES) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
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

function append(entries: TranscriptEntry[], role: TranscriptEntry['role'], text: string, title?: string): void {
  if (!text && !title) return
  const previous = entries.at(-1)
  if (previous?.role === role && previous.text === text && previous.title === title) return
  entries.push({ role, text, ...(title ? { title } : {}) })
}

async function parseTranscript(file: string, agentKind: 'codex' | 'claude'): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = []
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    let record: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(line)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      record = value as Record<string, unknown>
    } catch {
      continue
    }
    if (agentKind === 'codex') {
      if (record.payload === null || typeof record.payload !== 'object' || Array.isArray(record.payload)) continue
      const payload = record.payload as Record<string, unknown>
      if (record.type === 'event_msg') {
        if (payload.type === 'user_message') append(entries, 'user', cleanText(payload.message))
        else if (payload.type === 'agent_message') append(entries, 'agent', cleanText(payload.message))
      } else if (record.type === 'response_item') {
        appendCodexResponseItem(entries, payload)
      }
      continue
    }
    if ((record.type !== 'user' && record.type !== 'assistant') || record.message === null
      || typeof record.message !== 'object' || Array.isArray(record.message)) continue
    const message = record.message as Record<string, unknown>
    appendClaudeContent(entries, message.content, record.type === 'user' ? 'user' : 'agent')
  }
  return entries
}

export function formatTranscript(entries: TranscriptEntry[], agentKind: 'codex' | 'claude'): TerminalHistorySnapshot {
  const labels: Partial<Record<TranscriptEntry['role'], string>> = {
    user: '你', agent: agentKind === 'codex' ? 'Codex' : 'Claude Code', tool: '工具调用', tool_result: '工具结果',
  }
  const titledEntries = entries.map((entry) => ({ ...entry, title: entry.title ?? labels[entry.role] }))
  const sizes = titledEntries.map((entry) => (entry.title?.length ?? 0) + entry.text.length + 2)
  let selectedLength = 0
  let firstSelected = titledEntries.length
  while (firstSelected > 0) {
    const nextLength = sizes[firstSelected - 1]!
    const separatorLength = firstSelected === titledEntries.length ? 0 : 2
    if (selectedLength > 0 && selectedLength + separatorLength + nextLength > MAX_HISTORY_CHARACTERS) break
    firstSelected -= 1
    selectedLength += separatorLength + nextLength
  }
  return { entries: titledEntries.slice(firstSelected), truncated: firstSelected > 0 }
}

export async function readNativeSessionTranscript(agentKind: AgentKind, sessionId: string | undefined): Promise<TerminalHistorySnapshot> {
  const empty: TerminalHistorySnapshot = { entries: [], truncated: false }
  if (!sessionId || !/^[a-zA-Z0-9-]{8,128}$/.test(sessionId)) return empty
  if (agentKind !== 'codex' && agentKind !== 'claude') return empty
  const root = agentKind === 'codex'
    ? join(homedir(), '.codex', 'sessions')
    : join(homedir(), '.claude', 'projects')
  const file = await matchingJsonl(root, sessionId)
  if (!file) return empty
  return formatTranscript(await parseTranscript(file, agentKind), agentKind)
}
