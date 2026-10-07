import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'
import { boundedHookText as boundedText, permissionHookFields } from './permission-hook-input'
import type { ApprovalInputIssue } from '../src/shared/manager-api'

interface CodexPermissionInput {
  hook_event_name?: unknown
  session_id?: unknown
  turn_id?: unknown
  cwd?: unknown
  model?: unknown
  permission_mode?: unknown
  tool_name?: unknown
  tool_input?: unknown
  transcript_path?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'

// One small lifecycle record per transition; never log commands, keys or payloads.
function trace(stage: string, requestId?: string, reason?: string): void {
  process.stderr.write(JSON.stringify({ component: 'manager-permission-hook', time: new Date().toISOString(), stage, requestId, reason }) + '\n')
}

function readInput(): Promise<string> {
  return new Promise((resolve) => {
    let value = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { value += chunk })
    process.stdin.on('end', () => resolve(value))
  })
}

function objectInput(input: CodexPermissionInput): Record<string, unknown> | undefined {
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

function fingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function permissionDetails(input: CodexPermissionInput): {
  command?: string
  operation: ApprovalRisk
  filePath?: string
  targetPaths?: string[]
  toolInputSummary?: string
  reason?: string
  inputTruncated?: boolean
  inputIssue?: ApprovalInputIssue
} {
  const toolName = boundedText(input.tool_name, 256) ?? ''
  const details = objectInput(input)
  const fields = permissionHookFields(details)
  const { command, filePath, targetPaths } = fields
  // Shell risk is assessed from complete source by Manager, never by a keyword in printed text.
  const operation: ApprovalRisk = /^(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(toolName)
      ? 'read'
      : /^(?:Edit|Write|NotebookEdit|TodoWrite|apply_patch)$/i.test(toolName)
        ? 'write'
        : 'unknown'
  const serialized = (() => {
    try { return details ? JSON.stringify(details) : undefined } catch { return undefined }
  })()
  const summary = command ?? filePath ?? (targetPaths?.length ? targetPaths.join(', ') : undefined) ?? serialized
  const reason = boundedText(details?.description ?? details?.reason ?? details?.justification, 4_096)
  return {
    ...fields,
    operation,
    ...(summary ? { toolInputSummary: summary.slice(0, 16_384) } : {}),
    ...(reason ? { reason } : {}),
  }
}

interface HookDecision { action: 'allow' | 'ask' | 'deny'; reason?: string }

async function requestDecision(input: CodexPermissionInput): Promise<HookDecision> {
  const endpoint = process.env.AGENT_TUI_MANAGER_HOOK_ENDPOINT
  const token = process.env.AGENT_TUI_MANAGER_HOOK_TOKEN
  const toolName = boundedText(input.tool_name, 256)
  if (!endpoint || !token || !toolName) {
    trace('failed', undefined, 'missing-connection-or-tool')
    return { action: 'deny' }
  }
  const requestId = randomUUID()
  trace('received', requestId)
  const details = permissionDetails(input)
  const toolInputFingerprint = fingerprint(input.tool_input)
  return await new Promise((resolve) => {
    const socket = net.createConnection(endpoint)
    let buffer = ''
    let settled = false
    const finish = (action: 'allow' | 'ask' | 'deny', reason = 'manager-response', decisionReason?: string): void => {
      if (settled) return
      settled = true
      trace('decision-' + action, requestId, reason)
      clearTimeout(timer)
      socket.destroy()
      resolve({ action, ...(decisionReason ? { reason: decisionReason } : {}) })
    }
    // Finish before Codex's 1800-second hook timeout so it receives a decision.
    const timer = setTimeout(() => finish('deny', 'timeout'), 1790_000)
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      trace('sent', requestId)
      socket.write(`${JSON.stringify({
      type: 'permission-hook', token, requestId, hookSource: 'codex', toolName,
      toolInput: input.tool_input,
      rawPayload: input,
      ...(boundedText(input.session_id, 256) ? { nativeSessionId: boundedText(input.session_id, 256) } : {}),
      ...(boundedText(input.turn_id, 256) ? { turnId: boundedText(input.turn_id, 256) } : {}),
      ...(boundedText(input.cwd, 4_096) ? { cwd: boundedText(input.cwd, 4_096) } : {}),
      ...(boundedText(input.model, 256) ? { model: boundedText(input.model, 256) } : {}),
      ...(boundedText(input.permission_mode, 128) ? { permissionMode: boundedText(input.permission_mode, 128) } : {}),
      ...(boundedText(input.transcript_path, 4_096) ? { transcriptPath: boundedText(input.transcript_path, 4_096) } : {}),
      ...(boundedText(input.agent_id, 256) ? { agentId: boundedText(input.agent_id, 256) } : {}),
      ...(boundedText(input.agent_type, 128) ? { agentType: boundedText(input.agent_type, 128) } : {}),
      ...(toolInputFingerprint ? { toolInputFingerprint } : {}),
      ...details,
    })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 65_536) { finish('deny', 'response-too-large'); return }
      while (!settled) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line) as { type?: string; action?: string; requestId?: string; data?: unknown; reason?: unknown }
          // Older live Hosts briefly broadcast output before recognizing this
          // socket as a hook. Consume that frame; it is NOT an approval decision.
          if (event.type === 'output' && typeof event.data === 'string') continue
          if (event.type !== 'permission-response' || event.requestId !== requestId
            || !['allow', 'deny', 'ask'].includes(event.action ?? '')) {
            finish('deny', 'invalid-response')
          } else finish(event.action as 'allow' | 'deny' | 'ask', 'manager-response', boundedText(event.reason, 2_000)?.trim())
        } catch { finish('deny', 'invalid-json') }
      }
    })
    socket.once('error', () => finish('deny', 'connection-error'))
    socket.once('end', () => finish('deny', 'connection-ended'))
    socket.once('close', () => finish('deny', 'connection-closed'))
  })
}

function denyUnavailable(): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'deny', message: 'Agent TUI Manager could not parse or review this request. Submit a complete, materially safer request; do not bypass review or wait for a human.',
  } } }))
}

async function main(): Promise<void> {
  let input: CodexPermissionInput
  try { input = JSON.parse(await readInput()) as CodexPermissionInput } catch { denyUnavailable(); return }
  if (!input || typeof input.hook_event_name !== 'string') { denyUnavailable(); return }
  if (input.hook_event_name !== 'PermissionRequest') return
  const response = await requestDecision(input)
  trace('return-' + response.action)
  if (response.action === 'allow') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    }))
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: response.reason ?? 'Agent TUI Manager could not confirm approval. This request was not executed. Use a materially safer, complete request; do not bypass review or wait for a human.' },
      },
    }))
  }
}

void main().catch(() => denyUnavailable()).finally(() => setTimeout(() => process.exit(0), 0))
