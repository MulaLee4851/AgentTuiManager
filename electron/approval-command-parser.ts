import { MAX_APPROVAL_COMMAND_LENGTH } from '../src/shared/approval-input'

/** Static inspection only: this module never starts a shell or evaluates source. */
export interface CommandToken {
  value: string
  raw: string
  quoted?: 'single' | 'double' | 'mixed' | 'here-single' | 'here-double'
  dynamic?: boolean
}

export interface ParsedCommandTokens {
  name: string
  executable: CommandToken
  args: CommandToken[]
  /** Synthetic pipeline marker, aligned with the corresponding commands entry. */
  piped?: boolean
}

export interface ParsedApprovalCommand {
  /** Quoted arguments remain data unless passed to a known inline interpreter. */
  commands: string[]
  commandTokens?: ParsedCommandTokens[]
  redirections: string[]
  code: Array<{ language: 'python' | 'javascript'; source: string }>
  incomplete?: string
}

type ShellDialect = 'powershell' | 'posix' | 'cmd' | 'unknown'

function hereStringAt(source: string, index: number): { body: string; end: number; quote: string } | undefined {
  if (source[index] !== '@' || !/['"]/.test(source[index + 1] ?? '') || !/[\r\n]/.test(source[index + 2] ?? '')) return undefined
  const quote = source[index + 1]!
  const bodyStart = index + (source[index + 2] === '\r' && source[index + 3] === '\n' ? 4 : 3)
  const ending = new RegExp('(?:^|\\r?\\n)' + quote + '@(?=\\s|$)', 'g')
  ending.lastIndex = bodyStart
  const match = ending.exec(source)
  return match ? { body: source.slice(bodyStart, match.index), end: match.index + match[0].length, quote } : undefined
}

function escapedLength(source: string, index: number, dialect: ShellDialect, quoted: boolean): number {
  if (index + 1 >= source.length) return 0
  if (source[index] === '`' && dialect !== 'posix' && dialect !== 'cmd') {
    // Without explicit shell context, a paired backtick inside double quotes
    // can be a POSIX command substitution. Known PowerShell syntax keeps its
    // normal escape semantics; unquoted cmdlet escapes are unchanged.
    if (dialect === 'unknown' && quoted && backtickEnd(source, index) !== undefined) return 0
    return source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2
  }
  if (source[index] === '\\' && (dialect === 'posix'
    ? !quoted || /["\\$`\r\n]/.test(source[index + 1]!)
    : /[\r\n]/.test(source[index + 1]!) || dialect === 'unknown' && quoted && /["\\]/.test(source[index + 1]!))) {
    return source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2
  }
  return 0
}

/** Locate shell syntax without evaluating it. Nested quotes belong to the
 * subexpression, not the enclosing expandable string. */
function subexpressionEnd(source: string, start: number, dialect: ShellDialect, depth = 0): number | undefined {
  if (depth > 8) return undefined
  let level = 1
  let quote: string | undefined
  for (let index = start + 2; index < source.length; index++) {
    const character = source[index]!
    if (quote === "'") {
      if (character === "'") {
        if (source[index + 1] === "'") index++
        else quote = undefined
      }
      continue
    }
    const escaped = escapedLength(source, index, dialect, Boolean(quote))
    if (escaped) { index += escaped - 1; continue }
    if (quote === '"') {
      if (source.startsWith('$(', index) && dialect !== 'cmd') {
        const end = subexpressionEnd(source, index, dialect, depth + 1)
        if (end === undefined) return undefined
        index = end - 1
      } else if (character === '`' && (dialect === 'posix' || dialect === 'unknown')) {
        const end = backtickEnd(source, index)
        if (end === undefined) return undefined
        index = end - 1
      } else if (character === '"') quote = undefined
      continue
    }
    const here = dialect !== 'posix' && dialect !== 'cmd' ? hereStringAt(source, index) : undefined
    if (here) { index = here.end - 1; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '#' && (index === start + 2 || /\s/.test(source[index - 1]!))) {
      const newline = source.indexOf('\n', index)
      if (newline < 0) return undefined
      index = newline; continue
    }
    if (source.startsWith('<#', index) && dialect !== 'posix') {
      const end = source.indexOf('#>', index + 2)
      if (end < 0) return undefined
      index = end + 1; continue
    }
    if (character === '(') level++
    else if (character === ')' && --level === 0) return index + 1
  }
  return undefined
}

function backtickEnd(source: string, start: number): number | undefined {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\' && /[\\$`]/.test(source[index + 1] ?? '')) index++
    else if (source[index] === '`') return index + 1
  }
  return undefined
}

function expandableCommands(source: string, dialect: ShellDialect): { commands: string[]; incomplete?: string } {
  const commands: string[] = []
  for (let index = 0; index < source.length; index++) {
    const escaped = escapedLength(source, index, dialect, true)
    if (escaped) { index += escaped - 1; continue }
    if (source.startsWith('$(', index) && dialect !== 'cmd') {
      const end = subexpressionEnd(source, index, dialect)
      if (end === undefined) return { commands, incomplete: 'unterminated-command-substitution' }
      commands.push(source.slice(index + 2, end - 1)); index = end - 1
    } else if (source[index] === '`' && dialect === 'posix') {
      const end = backtickEnd(source, index)
      if (end === undefined) return { commands, incomplete: 'unterminated-command-substitution' }
      commands.push(source.slice(index + 1, end - 1)); index = end - 1
    }
  }
  return { commands }
}

function unquotedAt(source: string, offset: number, dialect: ShellDialect): boolean {
  let quote: string | undefined
  for (let index = 0; index < offset; index++) {
    const character = source[index]!
    if (quote === "'") {
      if (character === "'") {
        if (source[index + 1] === "'") index++
        else quote = undefined
      }
      continue
    }
    const escaped = escapedLength(source, index, dialect, Boolean(quote))
    if (escaped) { index += escaped - 1; continue }
    if (character === '"') { quote = quote ? undefined : '"'; continue }
    if (!quote && character === "'") { quote = "'"; continue }
    if (source.startsWith('$(', index) && dialect !== 'cmd') {
      const end = subexpressionEnd(source, index, dialect)
      if (end !== undefined) { if (end > offset) return false; index = end - 1 }
    }
  }
  return quote === undefined
}

function executableName(value: string): string {
  const name = value.replace(/^.*[/\\]/, '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
  return /\s/.test(name) ? '<literal-command-name>' : name
}

function tokenize(source: string, dialect: ShellDialect): {
  statements: Array<{ tokens: CommandToken[]; piped: boolean }>; substitutions: string[]; incomplete?: string
} {
  const statements: Array<{ tokens: CommandToken[]; piped: boolean }> = []
  const substitutions: string[] = []
  let tokens: CommandToken[] = []
  let piped = false
  let pendingPipe = false
  const delimiters: string[] = []
  let index = 0
  const flush = () => { if (tokens.length) statements.push({ tokens, piped }); tokens = [] }
  while (index < source.length) {
    const character = source[index]!
    if (character === '\r' || character === '\n' || /[;|&(){}]/.test(character)) {
      flush()
      if (character === '(' || character === '{') delimiters.push(character)
      if (character === ')' || character === '}') {
        if (delimiters.pop() !== (character === ')' ? '(' : '{')) return { statements, substitutions, incomplete: 'unbalanced-command-delimiter' }
      }
      if (character === '|') {
        piped = source[index + 1] !== '|' && source[index - 1] !== '|'
        pendingPipe = true
      } else if (character !== '\r' && character !== '\n') piped = false
      index++
      continue
    }
    if (/\s/.test(character)) { index++; continue }
    if (source.startsWith('<#', index)) {
      const end = source.indexOf('#>', index + 2)
      if (end < 0) return { statements, substitutions, incomplete: 'unterminated-comment' }
      index = end + 2
      continue
    }
    if (character === '#') {
      index = source.indexOf('\n', index)
      if (index < 0) break
      continue
    }
    const start = index
    let value = ''
    let dynamic = false
    let unquoted = false
    const quoteKinds = new Set<NonNullable<CommandToken['quoted']>>()
    while (index < source.length && !/[\s;|&(){}]/.test(source[index]!)) {
      const escaped = escapedLength(source, index, dialect, false)
      if (escaped) {
        if (!/[\r\n]/.test(source[index + 1]!)) value += source[index + 1]
        index += escaped; unquoted = true
        continue
      }
      if ((source.startsWith('$(', index) && dialect !== 'cmd') || (source[index] === '`' && dialect === 'posix')) {
        const isBacktick = source[index] === '`'
        const end = isBacktick ? backtickEnd(source, index) : subexpressionEnd(source, index, dialect)
        if (end === undefined) return { statements, substitutions, incomplete: 'unterminated-command-substitution' }
        substitutions.push(source.slice(index + (isBacktick ? 1 : 2), end - 1))
        value += source.slice(index, end); index = end; dynamic = true; unquoted = true
        continue
      }
      const hereString = source[index] === '@' && /['"]/.test(source[index + 1] ?? '')
        && /[\r\n]/.test(source[index + 2] ?? '')
      if (hereString) {
        const here = hereStringAt(source, index)
        if (!here) return { statements, substitutions, incomplete: 'unterminated-here-string' }
        quoteKinds.add(here.quote === '"' ? 'here-double' : 'here-single')
        if (here.quote === '"') {
          const expanded = expandableCommands(here.body, 'powershell')
          substitutions.push(...expanded.commands); dynamic ||= expanded.commands.length > 0
          if (expanded.incomplete) return { statements, substitutions, incomplete: expanded.incomplete }
        }
        value += here.body
        index = here.end
        continue
      }
      if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++]
        quoteKinds.add(quote === '"' ? 'double' : 'single')
        let closed = false
        while (index < source.length) {
          if (source[index] === quote) {
            if (source[index + 1] === quote) { value += quote; index += 2; continue }
            index++; closed = true; break
          }
          const quoteEscape = quote === '"' ? escapedLength(source, index, dialect, true) : 0
          if (quoteEscape) {
            if (!/[\r\n]/.test(source[index + 1]!)) value += source[index + 1]
            index += quoteEscape; continue
          }
          if (quote === '"' && ((source.startsWith('$(', index) && dialect !== 'cmd')
            || (source[index] === '`' && (dialect === 'posix' || dialect === 'unknown')))) {
            const isBacktick = source[index] === '`'
            const end = isBacktick ? backtickEnd(source, index) : subexpressionEnd(source, index, dialect)
            if (end === undefined) return { statements, substitutions, incomplete: 'unterminated-command-substitution' }
            substitutions.push(source.slice(index + (isBacktick ? 1 : 2), end - 1))
            value += source.slice(index, end); index = end; dynamic = true
            continue
          }
          value += source[index++]
        }
        if (!closed) return { statements, substitutions, incomplete: 'unterminated-quote' }
        continue
      }
      if (source[index] === '>') {
        if (value) break
        while (source[index] === '>') value += source[index++]
        break
      }
      value += source[index++]
      unquoted = true
    }
    if (value || quoteKinds.size) tokens.push({ value, raw: source.slice(start, index),
      ...(quoteKinds.size ? { quoted: quoteKinds.size > 1 || unquoted ? 'mixed' : [...quoteKinds][0]! } : {}),
      ...(dynamic ? { dynamic: true } : {}) })
    pendingPipe = false
  }
  flush()
  if (delimiters.length) return { statements, substitutions, incomplete: 'unbalanced-command-delimiter' }
  if (pendingPipe) return { statements, substitutions, incomplete: 'missing-pipeline-command' }
  return { statements, substitutions }
}

function decodePowerShell(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length % 2 || bytes.toString('base64') !== value) return undefined
  const decoded = bytes.toString('utf16le')
  return decoded.trim() && !decoded.includes('\0') ? decoded : undefined
}

export function parseApprovalCommand(source: string): ParsedApprovalCommand {
  const result: ParsedApprovalCommand = { commands: [], commandTokens: [], redirections: [], code: [] }
  if (source.length > MAX_APPROVAL_COMMAND_LENGTH) {
    result.incomplete = 'command-length-limit'
    return result
  }
  let inspectedLength = 0
  function inspect(script: string, depth: number, shell: ShellDialect = 'unknown'): void {
    inspectedLength += script.length
    // Wrappers inspect their intact child source again. Budget the root plus
    // eight supported nesting levels separately from the transport/root cap;
    // repeated expansions remain bounded and exhaustion stays incomplete.
    if (depth > 8 || inspectedLength > 9 * MAX_APPROVAL_COMMAND_LENGTH) { result.incomplete = 'nested-command-limit'; return }
    const dialect = shell === 'unknown' && /^\s*(?:\$[\w:]+\s*=|(?:&\s*)?[A-Za-z]+-[A-Za-z]+\b)/.test(script)
      ? 'powershell' : shell
    const heredocs = new Map<string, string>()
    const originalScript = script
    script = script.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\r\n]*\r?\n([\s\S]*?)\r?\n\2(?=\r?\n|$)/g,
      (match: string, quote: string, _delimiter: string, body: string, offset: number) => {
        if (!unquotedAt(originalScript, offset, dialect)) return match
        const id = '__approval_heredoc_' + heredocs.size + '__'
        heredocs.set(id, body)
        if (!quote) {
          const expanded = expandableCommands(body, 'posix')
          if (expanded.incomplete) result.incomplete = expanded.incomplete
          for (const command of expanded.commands) inspect(command, depth + 1, 'posix')
        }
        return id + '\n'
      })
    const parsed = tokenize(script, dialect)
    if (parsed.incomplete) result.incomplete = parsed.incomplete
    for (const statement of parsed.statements) {
      let tokens = statement.tokens
      while (tokens.length && /^[A-Za-z_]\w*=/.test(tokens[0]!.value)) tokens = tokens.slice(1)
      if (/^\$[\w:]+$/.test(tokens[0]?.value ?? '') && tokens[1]?.value === '=') tokens = tokens.slice(2)
      if (tokens[0]?.value === '$') tokens = tokens.slice(1)
      if (!tokens.length) continue
      const name = executableName(tokens[0]!.value)
      const args = tokens.slice(1)
      if (args.some((arg) => /^<<-?(?:[A-Za-z_'\"]|$)/.test(arg.raw))) result.incomplete = 'unterminated-heredoc'
      let commandArgs = args
      if (name === 'git') {
        while (commandArgs.length && /^(?:-[Cc]|--git-dir|--work-tree)$/.test(commandArgs[0]!.value)) commandArgs = commandArgs.slice(2)
        while (commandArgs.length && /^--(?:git-dir|work-tree)=/.test(commandArgs[0]!.value)) commandArgs = commandArgs.slice(1)
      }
      result.commands.push([name, ...commandArgs.map((token) => token.value)].join(' '))
      result.commandTokens!.push({ name, executable: tokens[0]!, args: commandArgs })
      for (let index = 0; index < args.length - 1; index++) {
        if (/^>{1,2}$/.test(args[index]!.raw)) result.redirections.push(args[index]!.value + ' ' + args[index + 1]!.value)
      }
      if (statement.piped) {
        result.commands.push('| ' + name)
        result.commandTokens!.push({ name, executable: tokens[0]!, args: [], piped: true })
      }
      if (/^(?:env|command|nohup|exec|time)$/.test(name) && args.length) {
        if (name === 'command' && args.some((arg) => /^-[vV]$/.test(arg.value))) continue
        let executable = 0
        while (executable < args.length) {
          const argument = args[executable]!.value
          if ((name === 'env' && /^(?:-u|--unset)$/.test(argument)) || (name === 'exec' && argument === '-a')) executable += 2
          else if (argument.startsWith('-') || /^[A-Za-z_]\w*=/.test(argument)) executable++
          else break
        }
        if (executable < args.length) inspect(args.slice(executable).map((token) => token.raw).join(' '), depth + 1, dialect)
      } else if (name === 'cmd') {
        const flag = args.findIndex((token) => /^\/[ck]$/i.test(token.value))
        if (flag >= 0) {
          const body = args.slice(flag + 1)
          if (!body.length) result.incomplete = 'missing-shell-command'
          else inspect(body.length === 1 ? body[0]!.value : body.map((token) => token.raw).join(' '), depth + 1, 'cmd')
        }
      } else if (/^(?:pwsh|powershell)$/.test(name)) {
        const flag = args.findIndex((token) => /^-(?:c|command|commandwithargs|e|ec|enc|encodedcommand)$/i.test(token.value))
        if (flag >= 0) {
          const body = args.slice(flag + 1)
          if (/^-(?:e|ec|enc|encodedcommand)$/i.test(args[flag]!.value)) {
            const decoded = body[0] ? decodePowerShell(body[0]!.value) : undefined
            if (decoded) inspect(decoded, depth + 1, 'powershell')
            else result.incomplete = 'invalid-encoded-command'
          } else if (!body.length) result.incomplete = 'missing-shell-command'
          else inspect(body.length === 1 ? body[0]!.value : body.map((token) => token.raw).join(' '), depth + 1, 'powershell')
        }
      } else if (/^(?:bash|sh|zsh|dash)$/.test(name)) {
        const flag = args.findIndex((token) => /^-[a-z]*c[a-z]*$/i.test(token.value))
        if (flag >= 0 && args[flag + 1]) inspect(args[flag + 1]!.value, depth + 1, 'posix')
      } else if (/^(?:python(?:\d+(?:\.\d+)*)?|py|node|nodejs)$/.test(name)) {
        const language = /^(?:node|nodejs)$/.test(name) ? 'javascript' : 'python'
        const flag = args.findIndex((token) => language === 'python' ? token.value === '-c' : /^(?:-e|--eval|-p|--print)$/.test(token.value))
        if (flag >= 0 && args[flag + 1]) result.code.push({ language, source: args[flag + 1]!.value })
        for (const arg of args) {
          const body = heredocs.get(arg.value)
          if (body !== undefined) result.code.push({ language, source: body })
        }
      }
    }
    for (const command of parsed.substitutions) inspect(command, depth + 1, dialect)
    if (parsed.statements.filter((statement) => statement.tokens[0]?.value === ':').length >= 4
      && /(?:^|\n)\s*:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(script)) {
      result.commands.push(':(){ :|:& };:')
      result.commandTokens!.push({ name: ':', executable: { value: ':', raw: ':' }, args: [] })
    }
  }
  inspect(source, 0)
  return result
}

/** Remove comments and string literals, retaining positions and line breaks. */
export function executableCode(source: string, language: 'python' | 'javascript'): string {
  const pattern = language === 'python'
    ? /#[^\r\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g
    : /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g
  return source.replace(pattern, (match) => match.replace(/[^\r\n]/g, ' '))
}
