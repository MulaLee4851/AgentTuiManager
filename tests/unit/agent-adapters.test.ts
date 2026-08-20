import { describe, expect, it } from 'vitest'

import { createAgentAdapter } from '../../electron/agent-adapters'

describe('native agent adapters', () => {
  it('requires Codex identity and prompt evidence before reporting ready', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('loading session...').ready).toBe(false)
    expect(adapter.observeOutput('\x1b[2JOpenAI Codex\r\n\r\n›\r\n').ready).toBe(true)
    expect(adapter.recoveryRecipe('codex.cmd', 'native-1')).toEqual({
      executable: 'codex.cmd', args: ['--no-alt-screen', 'resume', 'native-1'],
    })
  })

  it('does not report ready while Codex is asking for approval', () => {
    const adapter = createAgentAdapter('codex')
    const result = adapter.observeOutput('OpenAI Codex\r\n›\r\n$ git status --short\r\nWould you like to run the following command?')
    expect(result).toEqual({ approvalRequired: true, approvalCommand: 'git status --short', ready: false })
    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput('Would you like to run the following command?').approvalRequired).toBe(false)
    const fresh = createAgentAdapter('codex')
    expect(fresh.observeOutput('$ git log --oneline\r\nWould you like to run the following command?').approvalCommand)
      .toBe('git log --oneline')
  })

  it('recognizes Claude readiness and approval separately', () => {
    const adapter = createAgentAdapter('claude')
    expect(adapter.observeOutput('Claude Code\r\n❯\r\n')).toEqual({ approvalRequired: false, ready: true })
    expect(adapter.observeOutput('Bash command\r\n  Get-Content package.json\r\nAllow this tool use?')).toEqual({ approvalRequired: true, approvalCommand: 'Get-Content package.json', ready: false })
    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput('Claude Code\r\n❯\r\n')).toEqual({ approvalRequired: false, ready: true })
    expect(adapter.recoveryRecipe('claude', 'native-2')).toEqual({
      executable: 'claude', args: ['--resume', 'native-2'],
    })
  })

  it('keeps Pi and generic recovery conservative', () => {
    const adapter = createAgentAdapter('pi')
    expect(adapter.supportsNativeSessions).toBe(false)
    expect(adapter.observeOutput('first output').ready).toBe(true)
    expect(adapter.recoveryRecipe('pi', 'unknown')).toBeUndefined()
  })

  it('recognizes a Claude Read prompt split across ANSI cursor redraws', () => {
    const adapter = createAgentAdapter('claude')
    expect(adapter.observeOutput('\x1b[12;1H Read file\x1b[13;1H F:\\repo\\secret.ts').approvalRequired).toBe(false)
    expect(adapter.observeOutput('\x1b[18;1H Allow this tool use?\x1b[19;1H ❯ 1. Yes')).toEqual({
      approvalRequired: true,
      approvalCommand: 'tool:Read',
      ready: false,
    })
  })

  it('does not hide the next different Claude tool after one approval', () => {
    const adapter = createAgentAdapter('claude')
    expect(adapter.observeOutput('Edit file\r\nAllow this tool use?\r\n1. Yes').approvalCommand).toBe('tool:Edit')
    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput('Write file\r\nAllow this tool use?\r\n1. Yes')).toMatchObject({ approvalRequired: true, approvalCommand: 'tool:Write' })
  })

  it('does not mistake ordinary Agent prose for an interactive approval prompt', () => {
    expect(createAgentAdapter('codex').observeOutput('This change requires your approval before the team can merge it.').approvalRequired).toBe(false)
    expect(createAgentAdapter('claude').observeOutput('Permission required by your organization policy.').approvalRequired).toBe(false)
    expect(createAgentAdapter('pi').observeOutput('Approval required before release.').approvalRequired).toBe(false)
  })

  it('uses the latest tool in a multi-tool turn instead of an earlier shell command', () => {
    const adapter = createAgentAdapter('claude')
    adapter.observeOutput('Bash command\r\n  git log --oneline\r\nAllow this tool use?\r\n1. Yes')
    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput('command completed\r\nRead file\r\n  src/App.tsx\r\nAllow this tool use?\r\n1. Yes')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Read',
    })
  })

  it('reports a capacity error only for the output occurrence that introduced it', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('Selected model is at capacity. Please try a different model.').recoverableError).toBeDefined()
    const ready = adapter.observeOutput('\r\nOpenAI Codex\r\n›\r\n')
    expect(ready.ready).toBe(true)
    expect(ready.recoverableError).toBeUndefined()
  })

  it('recognizes a capacity error split across output chunks once', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('Selected model is at capa').recoverableError).toBeUndefined()
    expect(adapter.observeOutput('city. Please try a different model.').recoverableError).toBeDefined()
    expect(adapter.observeOutput('\r\nredraw').recoverableError).toBeUndefined()
  })

  it('recognizes the Codex file-change approval title from the official TUI', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput([
      'Would you like to make the following edits?',
      '1. Yes, proceed (y)',
      '2. Yes, and do not ask again for these files (a)',
      '3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\r\n'))).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Edit',
      ready: false,
    })
  })

  it('uses Codex OSC 9 notifications as fresh approval events', () => {
    const adapter = createAgentAdapter('codex')
    const editNotification = '\x1b]9;Codex wants to edit src/App.tsx\x07'
    expect(adapter.observeOutput(editNotification)).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Edit',
    })
    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput(editNotification)).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Edit',
    })
  })

  it('recognizes the Codex MCP approval form without relying on an OSC notification', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput([
      'Field 1/1',
      'Allow the codegraph MCP server to run tool "codegraph_explore"?',
      '',
      'maxFiles: 12',
      'projectPath: B:\AiDemo\AgentTuiManager',
    ].join('\r\n'))).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'mcp:codegraph/codegraph_explore',
      ready: false,
    })
  })
  it('refines an on-screen Codex shell placeholder when the command arrives without another OSC notification', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput([
      '\x1b]9;Approval requested: npm run typecheck\x07',
      'Would you like to run the following command?',
      '1. Yes, proceed',
      '2. No',
    ].join('\r\n'))).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Shell',
    })

    expect(adapter.observeOutput('\r\n$ npm run typecheck\r\n')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'npm run typecheck',
    })
  })

  it('recognizes a Codex approval when OSC and ANSI sequences span output chunks', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('\x1b]9;Codex wants to ed').approvalRequired).toBe(false)
    expect(adapter.observeOutput('it src/App.tsx\x07')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Edit',
    })

    adapter.acknowledgeUserInput(true)
    expect(adapter.observeOutput('Would you like to run the following command?\r\n$ Get-Content -LiteralPath \x1b[38;2;').approvalRequired).toBe(false)
    expect(adapter.observeOutput('243;139;168mfile.txt\x1b[0m\r\n1. Yes, proceed')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'Get-Content -LiteralPath file.txt',
    })
  })

  it('uses only the official DeepSeek Harness readiness URL and never guesses approvals', () => {
    const adapter = createAgentAdapter('deepseek')
    expect(adapter.observeOutput('starting web server…\r\n')).toEqual({ approvalRequired: false, ready: false })
    expect(adapter.observeOutput('dsh web: http://127.0.0.1:43127\r\n')).toEqual({
      approvalRequired: false,
      ready: true,
      webUrl: 'http://127.0.0.1:43127',
    })
    expect(adapter.observeOutput('Allow this tool use? rm -rf /')).toMatchObject({ approvalRequired: false })
    expect(adapter.observeOutput('Selected model is at capacity. Please try a different model.').recoverableError).toBeUndefined()
    expect(adapter.recoveryRecipe('dsh', 'not-used')).toBeUndefined()
  })

  it('surfaces an Exec OSC immediately while waiting for the full modal command', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('\x1b]9;Approval requested: Remove-Item -Recurse very-lon\x07')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Shell',
    })
    expect(adapter.observeOutput([
      'Would you like to run the following command?',
      '$ git status --short',
      '1. Yes, proceed (y)',
    ].join('\r\n'))).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'git status --short',
    })
  })

  it('recognizes option-only modal output after a long Codex repaint', () => {
    const adapter = createAgentAdapter('codex')
    expect(adapter.observeOutput('\x1b]9;Approval requested: npm test\x07')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Shell',
    })
    expect(adapter.observeOutput(`\x1b[12;1H${'.'.repeat(700)}`).approvalRequired).toBe(true)
    expect(adapter.observeOutput('\r\n1. Yes, proceed\r\n2. No')).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'tool:Shell',
    })
  })
  it('recognizes the other official Codex approval titles', () => {
    expect(createAgentAdapter('codex').observeOutput(
      'Would you like to grant these permissions?\r\n1. Yes, proceed\r\n2. No',
    )).toMatchObject({ approvalRequired: true, approvalCommand: 'tool:Permissions' })
    expect(createAgentAdapter('codex').observeOutput(
      'Do you want to approve network access to github.com?\r\n$ git fetch\r\n1. Yes, proceed\r\n2. No',
    )).toMatchObject({ approvalRequired: true, approvalCommand: 'git fetch' })
  })

  it('ignores a half-painted command line and reports it once complete', () => {
    const adapter = createAgentAdapter('codex')
    // The approval box is still being painted: the command line has no terminator yet.
    expect(adapter.observeOutput(
      'Would you like to run the following command?\r\n$ cd',
    )).toMatchObject({ approvalRequired: false })
    // The rest of the line arrives; the full command must be reported, not the "cd" head.
    expect(adapter.observeOutput(
      ' "F:/x" && rm -f out.txt\r\n1. Yes, proceed\r\n2. No',
    )).toMatchObject({
      approvalRequired: true,
      approvalCommand: 'cd "F:/x" && rm -f out.txt',
    })
  })

  it('keeps one pending approval on a single command while the TUI repaints', () => {
    const adapter = createAgentAdapter('claude')
    const first = adapter.observeOutput(
      'Claude Code\r\nDo you want to proceed?\r\nBash command\r\n rm -rf build\r\n1. Yes\r\n2. No',
    )
    expect(first).toMatchObject({ approvalRequired: true, approvalCommand: 'rm -rf build' })

    // A repaint appends more text, which moves a different candidate to the end of the
    // evidence. The reported command must not drift, or the controller raises a second
    // approval request for what is still the same prompt.
    const repaint = adapter.observeOutput('\r\nWrite file src/x.ts\r\ntool: write\r\n')
    expect(repaint).toMatchObject({ approvalRequired: true, approvalCommand: 'rm -rf build' })

    // Answering it releases the lock so the next prompt is classified from scratch.
    adapter.acknowledgeUserInput(true)
    const next = adapter.observeOutput(
      'Claude Code\r\nDo you want to proceed?\r\nBash command\r\n git status\r\n1. Yes\r\n2. No',
    )
    expect(next).toMatchObject({ approvalRequired: true, approvalCommand: 'git status' })
  })
})
