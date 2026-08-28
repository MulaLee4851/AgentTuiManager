import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'

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

function readInput(): Promise<string> {
  return new Promise((resolve) => {
    let value = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { value += chunk })
    process.stdin.on('end', () => resolve(value))
  })
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
    ? value
    : undefined
}

function objectInput(input: CodexPermissionInput): Record<string, unknown> | undefined {
  return typeof input.tool_input === 'object' && input.tool_input !== null
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

function commandFromToolInput(details: Record<string, unknown> | undefined): string | undefined {
  const direct = boundedText(details?.command, 16_384)
  if (direct) return direct
  if (!Array.isArray(details?.command)) return undefined
  const parts = details.command
    .map((part) => boundedText(part, 4_096))
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' ') : undefined
}

function permissionDetails(input: CodexPermissionInput): {
  command?: string
  operation: ApprovalRisk
  filePath?: string
  targetPaths?: string[]
  toolInputSummary?: string
  reason?: string
} {
  const toolName = boundedText(input.tool_name, 256) ?? ''
  const details = objectInput(input)
  const command = commandFromToolInput(details)
  const filePath = boundedText(details?.file_path ?? details?.notebook_path ?? details?.path, 4_096)
  const rawPaths = details?.file_paths ?? details?.paths
  const targetPaths = Array.isArray(rawPaths)
    ? rawPaths.map((value) => boundedText(value, 4_096)).filter((value): value is string => Boolean(value)).slice(0, 100)
    : undefined
  const operation: ApprovalRisk = command && /(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i.test(command)
    ? 'delete'
    : /^(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(toolName)
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
    ...(command ? { command } : {}),
    operation,
    ...(filePath ? { filePath } : {}),
    ...(targetPaths?.length ? { targetPaths } : {}),
    ...(summary ? { toolInputSummary: summary.slice(0, 16_384) } : {}),
    ...(reason ? { reason } : {}),
  }
}

async function requestDecision(input: CodexPermissionInput): Promise<'allow' | 'ask' | 'deny'> {
  const endpoint = process.env.AGENT_TUI_MANAGER_HOOK_ENDPOINT
  const token = process.env.AGENT_TUI_MANAGER_HOOK_TOKEN
  const toolName = boundedText(input.tool_name, 256)
  if (!endpoint || !token || !toolName) return 'ask'
  const requestId = randomUUID()
  const details = permissionDetails(input)
  const toolInputFingerprint = fingerprint(input.tool_input)
  return await new Promise((resolve) => {
    const socket = net.createConnection(endpoint)
    let buffer = ''
    let settled = false
    const finish = (action: 'allow' | 'ask' | 'deny'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(action)
    }
    const timer = setTimeout(() => finish('ask'), 30 * 60_000)
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({
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
    })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const event = JSON.parse(buffer.slice(0, newline)) as { type?: string; action?: string }
        finish(event.type === 'permission-response' && (event.action === 'allow' || event.action === 'deny') ? event.action : 'ask')
      } catch { finish('ask') }
    })
    socket.once('error', () => finish('ask'))
  })
}

async function main(): Promise<void> {
  let input: CodexPermissionInput
  try { input = JSON.parse(await readInput()) as CodexPermissionInput } catch { return }
  if (input.hook_event_name !== 'PermissionRequest') return
  const response = await requestDecision(input)
  if (response === 'allow') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    }))
  } else if (response === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied by the user in Agent TUI Manager' },
      },
    }))
  }
}

void main().finally(() => setTimeout(() => process.exit(0), 0))
