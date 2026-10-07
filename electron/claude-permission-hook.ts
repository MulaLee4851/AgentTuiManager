import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'
import { boundedHookText as boundedText, permissionHookFields } from './permission-hook-input'
import type { ApprovalInputIssue } from '../src/shared/manager-api'

interface HookInput {
  session_id?: unknown
  transcript_path?: unknown
  cwd?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_use_id?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'

interface PermissionDetails {
  command?: string
  operation: ApprovalRisk
  filePath?: string
  targetPaths?: string[]
  toolInputSummary?: string
  reason?: string
  inputTruncated?: boolean
  inputIssue?: ApprovalInputIssue
}

function readInput(): Promise<string> {
  return new Promise((resolve) => {
    let value = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { value += chunk })
    process.stdin.on('end', () => resolve(value))
  })
}

function objectInput(input: HookInput): Record<string, unknown> | undefined {
  return typeof input.tool_input === 'object' && input.tool_input !== null && !Array.isArray(input.tool_input)
    ? input.tool_input as Record<string, unknown>
    : undefined
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function toolInputFingerprint(input: HookInput): string | undefined {
  if (input.tool_input === undefined) return undefined
  return createHash('sha256').update(canonicalJson(input.tool_input)).digest('hex')
}

function permissionDetails(input: HookInput): PermissionDetails {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  const details = objectInput(input)
  const fields = permissionHookFields(details)
  const { command, filePath, targetPaths } = fields
  const operation: ApprovalRisk = /^(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(toolName)
      ? 'read'
      : /^(?:Edit|Write|NotebookEdit|TodoWrite)$/i.test(toolName)
        ? 'write'
        : 'unknown'
  const summary = command ?? filePath ?? (targetPaths?.length ? targetPaths.join(', ') : undefined)
    ?? (() => {
      try { return details ? JSON.stringify(details) : undefined } catch { return undefined }
    })()
  return {
    ...fields,
    operation,
    ...(summary ? { toolInputSummary: summary.slice(0, 16_384) } : {}),
    ...(boundedText(details?.description ?? details?.reason, 2_048) ? { reason: boundedText(details?.description ?? details?.reason, 2_048) } : {}),
  }
}

function denyUnavailable(): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'deny', message: 'Agent TUI Manager could not obtain a valid approval. This request was not executed. Use a materially safer, complete request; do not bypass review or wait for a human.',
  } } }))
}

async function main(): Promise<void> {
  const endpoint = process.env.AGENT_TUI_MANAGER_HOOK_ENDPOINT
  const token = process.env.AGENT_TUI_MANAGER_HOOK_TOKEN
  if (!endpoint || !token) { denyUnavailable(); return }
  let input: HookInput
  try { input = JSON.parse(await readInput()) as HookInput } catch { denyUnavailable(); return }
  if (!input || typeof input.tool_name !== 'string' || !input.tool_name) { denyUnavailable(); return }

  const requestId = randomUUID()
  const details = permissionDetails(input)
  const fingerprint = toolInputFingerprint(input)
  const response = await new Promise<{ action: 'allow' | 'ask' | 'deny'; reason?: string }>((resolve) => {
    const socket = net.createConnection(endpoint)
    let buffer = ''
    let settled = false
    const finish = (action: 'allow' | 'ask' | 'deny', reason?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ action, ...(reason ? { reason } : {}) })
    }
    const timer = setTimeout(() => finish('deny'), 1790_000)
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({
      type: 'permission-hook', token, requestId, hookSource: 'claude', toolName: input.tool_name,
      toolInput: input.tool_input,
      rawPayload: input,
      ...(boundedText(input.session_id, 256) ? { nativeSessionId: boundedText(input.session_id, 256) } : {}),
      ...(boundedText(input.transcript_path, 4_096) ? { transcriptPath: boundedText(input.transcript_path, 4_096) } : {}),
      ...(boundedText(input.cwd, 4_096) ? { cwd: boundedText(input.cwd, 4_096) } : {}),
      ...(boundedText(input.tool_use_id, 256) ? { toolUseId: boundedText(input.tool_use_id, 256) } : {}),
      ...(boundedText(input.agent_id, 256) ? { agentId: boundedText(input.agent_id, 256) } : {}),
      ...(boundedText(input.agent_type, 128) ? { agentType: boundedText(input.agent_type, 128) } : {}),
      ...(fingerprint ? { toolInputFingerprint: fingerprint } : {}),
      ...details,
    })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 65_536) { finish('deny'); return }
      while (!settled) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line) as { type?: string; action?: string; requestId?: string; data?: unknown; reason?: unknown }
          if (event.type === 'output' && typeof event.data === 'string') continue
          if (event.type !== 'permission-response' || event.requestId !== requestId
            || !['allow', 'deny', 'ask'].includes(event.action ?? '')) finish('deny')
          else finish(event.action as 'allow' | 'deny' | 'ask', boundedText(event.reason, 2_000)?.trim())
        } catch { finish('deny') }
      }
    })
    socket.once('error', () => finish('deny'))
    socket.once('end', () => finish('deny'))
    socket.once('close', () => finish('deny'))
  })

  if (response.action === 'allow') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    }))
  } else if (response.reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: response.reason ?? 'Denied by Agent TUI Manager' } },
    }))
  } else denyUnavailable()
}

void main().catch(() => denyUnavailable()).finally(() => setTimeout(() => process.exit(0), 0))
