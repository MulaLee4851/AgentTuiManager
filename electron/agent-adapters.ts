import type { AgentKind, RecoveryRecipe } from '../src/shared/manager-api'
import { deepSeekWebUrl } from '../src/shared/deepseek-web-url'
import { terminalScrollbackArgs } from './start-request-policy'

export interface AgentObservation {
  approvalRequired: boolean
  approvalCommand?: string
  approvalReason?: string
  forwardedSubagentApproval?: boolean
  nativeClaudeApprovalMenu?: boolean
  ready: boolean
  recoverableError?: {
    code: 'model-capacity'
    message: string
  }
  webUrl?: string
}

export interface AgentAdapter {
  readonly kind: AgentKind
  readonly supportsNativeSessions: boolean
  observeOutput(data: string): AgentObservation
  acknowledgeUserInput(handledApproval?: boolean): void
  resetForRecovery(): void
  approvalInput(): string
  rejectionInput(): string
  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe | undefined
}

// Approval modals keep the command next to the prompt. Eight KiB covers the
// maximum supported command plus redraw noise without rescanning a full TUI
// screen on every small PTY output chunk.
const MAX_EVIDENCE_CHARACTERS = 32_768
export const MODEL_CAPACITY_ERROR = 'Selected model is at capacity. Please try a different model.'

function terminalText(value: string): string {
  return value
    .replace(/\x1b\]9;Approval requested:\s*([^\x07]*)(?:\x07|\x1b\\)/gi, '\nAGENT_MANAGER_CODEX_APPROVAL_EXEC: $1\n')
    .replace(/\x1b\]9;Codex wants to edit\s*([^\x07]*)(?:\x07|\x1b\\)/gi, '\nAGENT_MANAGER_CODEX_APPROVAL_EDIT: $1\n')
    .replace(/\x1b\]9;Approval requested by\s*([^\x07]*)(?:\x07|\x1b\\)/gi, '\nAGENT_MANAGER_CODEX_APPROVAL_MCP: $1\n')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[ABCEFGHJKSTfhl]/g, '\n')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
}

function completeTerminalOutput(value: string): { complete: string; remainder: string } {
  const escapeIndex = value.lastIndexOf('\x1b')
  if (escapeIndex < 0) return { complete: value, remainder: '' }
  if (escapeIndex === value.length - 1) {
    return { complete: value.slice(0, escapeIndex), remainder: value.slice(escapeIndex) }
  }

  const type = value[escapeIndex + 1]
  if (type === '[') {
    const finalByte = value.slice(escapeIndex + 2).search(/[@-~]/)
    if (finalByte < 0) return { complete: value.slice(0, escapeIndex), remainder: value.slice(escapeIndex) }
  } else if (type === ']') {
    const payload = value.slice(escapeIndex + 2)
    if (!payload.includes('\x07') && !payload.includes('\x1b\\')) {
      return { complete: value.slice(0, escapeIndex), remainder: value.slice(escapeIndex) }
    }
  }
  return { complete: value, remainder: '' }
}

abstract class EvidenceAdapter implements AgentAdapter {
  abstract readonly kind: AgentKind
  abstract readonly supportsNativeSessions: boolean
  private evidence = ''
  private recoverableTail = ''
  private classificationTail = ''
  private terminalControlRemainder = ''
  private handledApprovalSubject: string | undefined
  private lastApprovalSubject: string | undefined
  // The command reported for the approval that is currently on screen. Candidate
  // extraction picks whichever match sits last in the evidence, and the evidence keeps
  // growing as the TUI repaints, so the same prompt can yield a different command from
  // one frame to the next. The controller treats a changed command as a brand new
  // request, which is how one approval turned into several. Hold the first reading
  // until the prompt is answered or goes away.
  private pendingApprovalCommand: string | undefined

  observeOutput(data: string): AgentObservation {
    const raw = completeTerminalOutput(`${this.terminalControlRemainder}${data}`)
    this.terminalControlRemainder = raw.remainder
    // A full screen erase invalidates approval text from older terminal frames.
    // Keep incremental redraws intact; only discard evidence on explicit ED 2.
    const clear = [...raw.complete.matchAll(/\x1b\[2J/g)].at(-1)
    if (this.kind === 'codex' && clear) {
      this.evidence = ''
      this.classificationTail = ''
      this.pendingApprovalCommand = undefined
      this.handledApprovalSubject = undefined
    }
    const output = terminalText(this.kind === 'codex' && clear
      ? raw.complete.slice(clear.index! + clear[0].length) : raw.complete)
    const recoverableWindow = `${this.recoverableTail}${output}`
    const transientError = this.kind === 'deepseek' ? undefined : recoverableError(recoverableWindow)
    this.recoverableTail = recoverableWindow.slice(-(MODEL_CAPACITY_ERROR.length - 1))
    this.evidence = `${this.evidence}${output}`.slice(-MAX_EVIDENCE_CHARACTERS)
    const classificationWindow = `${this.classificationTail}${output}`
    this.classificationTail = classificationWindow.slice(-512)
    let observation = this.hasClassificationSignal(classificationWindow)
      ? this.classify(this.evidence)
      : { ready: false, approvalRequired: false }
    const freshApprovalSignal = /\x1b\]9;(?:Approval requested:|Codex wants to edit|Approval requested by)[^\x07]*(?:\x07|\x1b\\)/i.test(raw.complete)
      || this.kind === 'codex' && /would you like to (?:run the following command|make the following edits|grant these permissions)\?|allow\s+(?:the\s+)?[\w.-]+\s+mcp\s+server\s+to\s+run\s+tool\s+["']/i.test(output)
    if (!observation.approvalRequired) {
      this.pendingApprovalCommand = undefined
    } else if (freshApprovalSignal) {
      this.pendingApprovalCommand = observation.approvalCommand
    } else if (this.pendingApprovalCommand !== undefined) {
      if (this.pendingApprovalCommand === 'tool:Shell'
        && observation.approvalCommand !== undefined
        && observation.approvalCommand !== 'tool:Shell') {
        this.pendingApprovalCommand = observation.approvalCommand
      }
      observation = { ...observation, approvalCommand: this.pendingApprovalCommand }
    } else if (observation.approvalCommand !== undefined) {
      this.pendingApprovalCommand = observation.approvalCommand
    }
    const subject = observation.approvalCommand ?? (observation.approvalRequired ? 'approval:unknown' : undefined)
    if (this.handledApprovalSubject && observation.approvalRequired
      && subject === this.handledApprovalSubject && !freshApprovalSignal) {
      // Ignore one redraw of the prompt that was just answered. Clear the
      // guard immediately so a genuinely new request for the same command
      // can be classified and auto-approved.
      this.handledApprovalSubject = undefined
      return { ready: false, approvalRequired: false }
    }
    if (!observation.approvalRequired || (subject && subject !== this.handledApprovalSubject)) {
      this.handledApprovalSubject = undefined
    }
    this.lastApprovalSubject = subject
    return transientError ? { ...observation, recoverableError: transientError } : observation
  }

  acknowledgeUserInput(handledApproval = false): void {
    // Old approval text remains in a full-screen terminal's scrollback. Clear it so
    // only the exact prompt just answered is ignored if the TUI redraws it.
    this.handledApprovalSubject = handledApproval
      ? this.lastApprovalSubject ?? 'approval:unknown'
      : undefined
    this.evidence = ''
    this.recoverableTail = ''
    this.classificationTail = ''
    this.terminalControlRemainder = ''
    this.lastApprovalSubject = undefined
    this.pendingApprovalCommand = undefined
  }

  resetForRecovery(): void {
    this.evidence = ''
    this.recoverableTail = ''
    this.classificationTail = ''
    this.terminalControlRemainder = ''
    this.handledApprovalSubject = undefined
    this.lastApprovalSubject = undefined
    this.pendingApprovalCommand = undefined
  }

  approvalInput(): string { return '\r' }
  rejectionInput(): string { return '\x1b' }

  private hasClassificationSignal(value: string): boolean {
    if (this.kind === 'generic' || this.kind === 'pi' || this.kind === 'deepseek') return value.trim().length > 0
    if (/approval|permission|would you|do you want|allow|proceed|press enter|\[[yY](?:\/[nN])?\]/i.test(value)
      || /(?:^|\n)\s*(?:[›❯>]\s*)?\d+[.)]\s*(?:yes|allow|no|cancel)\b/im.test(value)) return true
    if (this.kind === 'codex') {
      return /AGENT_MANAGER_CODEX_APPROVAL_|(?:openai\s+)?codex|type \/ to select a command|[›❯]/i.test(value)
    }
    return /claude\s+code|\? for shortcuts|[›❯]|(?:^|\n)\s*(?:Read|Glob|Grep|WebFetch|WebSearch|Edit|Write|NotebookEdit|TodoWrite|Bash|Task)\b/im.test(value)
  }

  abstract recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe | undefined
  protected abstract classify(evidence: string): AgentObservation
}

const EXPLICIT_APPROVAL = [
  /approval required/i,
  /requires? (?:your )?approval/i,
  /permission required/i,
]

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function recoverableError(evidence: string): AgentObservation['recoverableError'] {
  return evidence.toLocaleLowerCase('en-US').includes(MODEL_CAPACITY_ERROR.toLocaleLowerCase('en-US'))
    ? { code: 'model-capacity', message: MODEL_CAPACITY_ERROR }
    : undefined
}
function hasApprovalInteraction(evidence: string): boolean {
  return /(?:^|\n)\s*(?:[›❯>]\s*)?\d+[.)]\s*(?:yes|allow|no)\b/im.test(evidence)
    || /\b(?:yes,\s*(?:proceed|allow)|allow once|always allow|press enter|esc to cancel)\b/i.test(evidence)
    || /\[[yY](?:\/[nN])?\]/.test(evidence)
}


function hasClaudeForwardedSubagentMarker(evidence: string): boolean {
  const compact = evidence.replace(/\s+/g, ' ')
  return /\bfrom the [^\r\n]{1,160}?\bagent\b/i.test(compact)
}


export function extractApprovalCommand(evidence: string): string | undefined {
  const normalizedEvidence = evidence.toLocaleLowerCase('en-US')
  const editApproval = Math.max(
    evidence.lastIndexOf('AGENT_MANAGER_CODEX_APPROVAL_EDIT:'),
    normalizedEvidence.lastIndexOf('would you like to make the following edits?'),
  )
  const execNotification = evidence.lastIndexOf('AGENT_MANAGER_CODEX_APPROVAL_EXEC:')
  const execTitle = normalizedEvidence.lastIndexOf('would you like to run the following command?')
  const execApproval = Math.max(execNotification, execTitle)
  const mcpApproval = evidence.lastIndexOf('AGENT_MANAGER_CODEX_APPROVAL_MCP:')
  const mcpBodyMatches = [...evidence.matchAll(/allow\s+(?:the\s+)?([\w.-]+)\s+mcp\s+server\s+to\s+run\s+tool\s+["']([^"'\r\n]+)["']/gi)]
  const mcpBody = mcpBodyMatches.at(-1)
  const mcpBodyApproval = mcpBody?.index ?? -1
  const latestCodexApproval = Math.max(editApproval, execApproval, mcpApproval, mcpBodyApproval)
  if (latestCodexApproval === editApproval && editApproval >= 0) return 'tool:Edit'
  if (latestCodexApproval === mcpBodyApproval && mcpBody?.[1] && mcpBody[2]) {
    return `mcp:${mcpBody[1]}/${mcpBody[2]}`
  }
  if (latestCodexApproval === mcpApproval && mcpApproval >= 0) return 'tool:MCP'
  if (/would you like to grant these permissions\?/i.test(evidence)) return 'tool:Permissions'

  const commandEvidence = execNotification >= 0 ? evidence.slice(execNotification) : evidence
  const candidates: Array<{ index: number; value: string }> = []
  // Only accept a command line that is already terminated. A TUI paints its approval box
  // progressively, so an unterminated line can hold just the head of the command ("cd" out
  // of `cd ... && rm -f ...`). Taking it both showed the wrong command in the approval UI
  // and made the completed line arrive later as a second, different approval request.
  for (const match of commandEvidence.matchAll(/(?:^|\n)\s*\$\s+([^\n]+)(?=\n)/g)) {
    const value = match[1]?.trim()
    if (value) candidates.push({ index: match.index, value })
  }
  for (const match of commandEvidence.matchAll(/(?:^|\n)\s*Bash command\s*\n\s*([^\n]+)(?=\n)/gi)) {
    const value = match[1]?.trim()
    if (value) candidates.push({ index: match.index, value })
  }
  for (const match of commandEvidence.matchAll(/(?:^|\n)\s*(?:tool(?: use)?|工具)\s*[:：]\s*([A-Za-z][\w-]*)/gi)) {
    if (match[1]) candidates.push({ index: match.index, value: `tool:${match[1]}` })
  }
  for (const match of commandEvidence.matchAll(/(?:^|\n)\s*(Read|Glob|Grep|WebFetch|WebSearch|Edit|Write|NotebookEdit|TodoWrite|Bash|Task)\b(?!\s+command\b)(?:[^\n]*)/gi)) {
    if (match[1]) candidates.push({ index: match.index, value: `tool:${match[1]}` })
  }
  for (const match of commandEvidence.matchAll(/\b(Read|Glob|Grep|WebFetch|WebSearch|Edit|Write|NotebookEdit|TodoWrite|Bash|Task)\b(?=\s*(?:\(|file\b|files\b|tool\b|[:：]))/gi)) {
    if (match[1]) candidates.push({ index: match.index, value: `tool:${match[1]}` })
  }
  const latestCandidate = candidates.sort((left, right) => left.index - right.index).at(-1)
  if (latestCandidate) return latestCandidate.value
  // Codex truncates Exec OSC notifications to 30 graphemes. The notification
  // proves an approval exists, but it is never safe to treat its text as a command.
  return execNotification >= 0 ? 'tool:Shell' : undefined
}

export function extractApprovalReason(evidence: string): string | undefined {
  const matches = [...evidence.matchAll(/(?:^|\n)\s*(?:Reason|原因)\s*[:：]\s*([^\n]{1,2048})/gi)]
  return matches.at(-1)?.[1]?.trim()
}

class CodexAdapter extends EvidenceAdapter {
  readonly kind = 'codex' as const
  readonly supportsNativeSessions = true

  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe {
    return { executable, args: terminalScrollbackArgs('codex', ['resume', nativeSessionId]) }
  }

  protected classify(evidence: string): AgentObservation {
    const approvalPhrase = includesAny(evidence, [
      ...EXPLICIT_APPROVAL,
      /AGENT_MANAGER_CODEX_APPROVAL_(?:EXEC|EDIT|MCP):/i,
      /allow\s+(?:the\s+)?[\w.-]+\s+mcp\s+server\s+to\s+run\s+tool\s+["'][^"'\r\n]+["']/i,
      /would you like to run the following command/i,
      /would you like to make the following edits/i,
      /would you like to grant these permissions/i,
      /do you want to approve network access to/i,
      /needs your approval\./i,
      /do you want to (?:allow|run|execute) (?:this|the) command/i,
      /allow command execution/i,
      // Ratatui can leave the title unchanged between consecutive approvals.
      // Its native choice pair still proves an approval, even without a command.
      /yes,\s*proceed\s*\(y\)[\s\S]*no,\s*and tell codex what to do differently\s*\(esc\)/i,
    ])
    const approvalCommand = approvalPhrase ? extractApprovalCommand(evidence) : undefined
    const approvalReason = approvalPhrase ? extractApprovalReason(evidence) : undefined
    const approvalRequired = approvalPhrase
      && (approvalCommand !== undefined || hasApprovalInteraction(evidence))
    const hasIdentity = /(?:openai\s+)?codex/i.test(evidence)
    const hasPrompt = /(?:^|[\r\n])\s*[›❯]\s*(?:$|[\r\n])/m.test(evidence)
      || /type \/ to select a command/i.test(evidence)
    return {
      approvalRequired,
      ...(approvalCommand ? { approvalCommand } : {}),
      ...(approvalReason ? { approvalReason } : {}),
      ready: !approvalRequired && hasIdentity && hasPrompt,
    }
  }
}

class ClaudeAdapter extends EvidenceAdapter {
  readonly kind = 'claude' as const
  readonly supportsNativeSessions = true

  recoveryRecipe(executable: string, nativeSessionId: string): RecoveryRecipe {
    return { executable, args: ['--resume', nativeSessionId] }
  }

  protected classify(evidence: string): AgentObservation {
    const approvalPhrase = includesAny(evidence, [
      ...EXPLICIT_APPROVAL,
      /allow this tool use/i,
      /do you want to proceed\?/i,
      /would you like to proceed\?/i,
      /do you want to allow (?:this|the) (?:tool|command)/i,
    ])
    const approvalCommand = approvalPhrase ? extractApprovalCommand(evidence) : undefined
    const approvalReason = approvalPhrase ? extractApprovalReason(evidence) : undefined
    const approvalRequired = approvalPhrase && (approvalCommand !== undefined || hasApprovalInteraction(evidence))
    // Claude's local-agent mailbox renders a real permission dialog in the leader
    // TUI without invoking command PermissionRequest hooks. Keep this deliberately
    // narrow: ordinary subagent progress/repaint text must not become an approval.
    const forwardedSubagentApproval = approvalRequired
      && hasClaudeForwardedSubagentMarker(evidence)
      && /(?:do you want to proceed|would you like to proceed)\?/i.test(evidence)
      && hasApprovalInteraction(evidence)
    const hasIdentity = /claude\s+code/i.test(evidence)
    const nativeClaudeApprovalMenu = approvalRequired
      && /(?:do you want to proceed|would you like to proceed)\?/i.test(evidence)
      && /(?:^|\n)\s*[❯›>]\s*1\.\s*Yes\b/i.test(evidence)
      && /(?:^|\n)\s*[23]\.\s*No\b/i.test(evidence)
      && /Esc to cancel/i.test(evidence)
    const hasPrompt = /(?:^|[\r\n])\s*[❯›]\s*(?:$|[\r\n])/m.test(evidence)
      || /\? for shortcuts/i.test(evidence)
    return {
      approvalRequired,
      ...(approvalCommand ? { approvalCommand } : {}),
      ...(approvalReason ? { approvalReason } : {}),
      ...(forwardedSubagentApproval ? { forwardedSubagentApproval: true } : {}),
      ...(nativeClaudeApprovalMenu ? { nativeClaudeApprovalMenu: true } : {}),
      ready: !approvalRequired && hasIdentity && hasPrompt,
    }
  }
}

class GenericAdapter extends EvidenceAdapter {
  readonly supportsNativeSessions = false
  constructor(readonly kind: 'generic' | 'pi') { super() }

  recoveryRecipe(): undefined { return undefined }

  protected classify(evidence: string): AgentObservation {
    return {
      approvalRequired: false,
      ready: evidence.trim().length > 0,
    }
  }
}

class DeepSeekAdapter extends EvidenceAdapter {
  readonly kind = 'deepseek' as const
  readonly supportsNativeSessions = false

  recoveryRecipe(): undefined { return undefined }

  protected classify(evidence: string): AgentObservation {
    const matches = [...evidence.matchAll(/(?:^|\n)dsh web:[ \t]+(http:\/\/[^\s]+)(?=\s)/gi)]
    const webUrl = matches.map((match) => deepSeekWebUrl(match[1])).filter(Boolean).at(-1)
    return {
      approvalRequired: false,
      ready: Boolean(webUrl),
      ...(webUrl ? { webUrl } : {}),
    }
  }
}

export function createAgentAdapter(kind: AgentKind): AgentAdapter {
  if (kind === 'codex') return new CodexAdapter()
  if (kind === 'claude') return new ClaudeAdapter()
  if (kind === 'deepseek') return new DeepSeekAdapter()
  return new GenericAdapter(kind)
}
