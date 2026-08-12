import { randomUUID } from 'node:crypto'
import net from 'node:net'

interface HookInput {
  tool_name?: unknown
  tool_input?: unknown
  tool_use_id?: unknown
}

type ApprovalRisk = 'read' | 'write' | 'delete' | 'unknown'

interface PermissionDetails {
  command?: string
  operation: ApprovalRisk
  filePath?: string
  targetPaths?: string[]
  toolInputSummary?: string
  reason?: string
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
  return typeof input.tool_input === 'object' && input.tool_input !== null
    ? input.tool_input as Record<string, unknown>
    : undefined
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
    ? value
    : undefined
}

function permissionDetails(input: HookInput): PermissionDetails {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  const details = objectInput(input)
  const command = toolName === 'Bash' || toolName === 'PowerShell'
    ? boundedText(details?.command, 2_048)
    : undefined
  const filePath = boundedText(details?.file_path ?? details?.notebook_path ?? details?.path, 1_024)
  const rawPaths = details?.file_paths ?? details?.paths
  const targetPaths = Array.isArray(rawPaths)
    ? rawPaths
      .map((value) => boundedText(value, 1_024))
      .filter((value): value is string => value !== undefined)
      .slice(0, 50)
    : undefined
  const operation: ApprovalRisk = command && /(?:^|\s)(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|format)(?:\s|$)/i.test(command)
    ? 'delete'
    : /^(?:Read|Glob|Grep|WebFetch|WebSearch)$/i.test(toolName)
      ? 'read'
      : /^(?:Edit|Write|NotebookEdit|TodoWrite)$/i.test(toolName)
        ? 'write'
        : 'unknown'
  const summary = command ?? filePath ?? (targetPaths?.length ? targetPaths.join(', ') : undefined)
    ?? (() => {
      try { return details ? JSON.stringify(details).slice(0, 2_048) : undefined } catch { return undefined }
    })()
  return {
    ...(command ? { command } : {}),
    operation,
    ...(filePath ? { filePath } : {}),
    ...(targetPaths?.length ? { targetPaths } : {}),
    ...(summary ? { toolInputSummary: summary.slice(0, 2_048) } : {}),
    ...(boundedText(details?.description ?? details?.reason, 2_048) ? { reason: boundedText(details?.description ?? details?.reason, 2_048) } : {}),
  }
}

async function main(): Promise<void> {
  const endpoint = process.env.AGENT_TUI_MANAGER_HOOK_ENDPOINT
  const token = process.env.AGENT_TUI_MANAGER_HOOK_TOKEN
  if (!endpoint || !token) return
  let input: HookInput
  try { input = JSON.parse(await readInput()) as HookInput } catch { return }
  if (typeof input.tool_name !== 'string' || !input.tool_name) return

  const requestId = randomUUID()
  const details = permissionDetails(input)
  const response = await new Promise<'allow' | 'ask' | 'deny'>((resolve) => {
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
      type: 'permission-hook', token, requestId, toolName: input.tool_name,
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

  if (response === 'allow') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    }))
  } else if (response === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by the user in Agent TUI Manager' } },
    }))
  }
}

void main().finally(() => setTimeout(() => process.exit(0), 0))
