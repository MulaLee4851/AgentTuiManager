import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildReviewerArguments, CliSecurityReviewer, codexProviderOverrides,
  isolatedReviewerEnvironment, parseCliReviewOutput, resolveReviewerExecutable, runReviewerProcess,
  type ReviewerProcessRunner,
} from '../../electron/cli-security-reviewer'
import { READONLY_CONTEXT_SERVER } from '../../electron/reviewer-readonly-context'
import type { StoredLlmReviewSettings } from '../../electron/llm-review-settings-store'
import { LlmSecurityReviewer } from '../../electron/llm-security-reviewer'
import type { ApprovalRequest } from '../../src/shared/manager-api'

const conclusion = { verdict: 'allow', riskScore: 8, summary: '安全', reasons: ['范围明确'], hazards: [], assumptions: [] }
const codexOutput = [
  { type: 'thread.started', thread_id: 'isolated' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(conclusion) } },
  { type: 'turn.completed', usage: {} },
].map(value => JSON.stringify(value)).join('\n')
const settings: StoredLlmReviewSettings = {
  backend: 'codex-cli', cliExecutable: process.execPath, enabled: true, level: 'high', retryCount: 0,
  timeoutSeconds: 30, scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
  proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
}

describe('independent CLI security reviewer', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reviewer-test-'))
    vi.stubEnv('CODEX_HOME', directory)
    vi.stubEnv('CLAUDE_CONFIG_DIR', directory)
    vi.stubEnv('AGENT_TUI_REVIEW_PROCESS', '')
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('strips hook endpoints, tokens, session identity and runtime injection while retaining auth', () => {
    const env = isolatedReviewerEnvironment({
      PATH: 'bin', CODEX_HOME: '/auth', OPENAI_API_KEY: 'provider-key', ANTHROPIC_API_KEY: 'claude-key',
      AGENT_TUI_MANAGER_HOOK_ENDPOINT: 'http://manager', AGENT_TUI_MANAGER_HOOK_TOKEN: 'secret',
      agent_tui_manager_other: 'secret', CODEX_THREAD_ID: 'original', CLAUDECODE: '1', NODE_OPTIONS: '--require evil.js',
      CODEX_PROFILE: 'active-session-profile', CODEX_SQLITE_HOME: 'active-session-state', CLAUDE_CODE_BYPASS_PERMISSIONS: '1',
    })
    expect(env).toEqual({ PATH: 'bin', CODEX_HOME: '/auth', OPENAI_API_KEY: 'provider-key', ANTHROPIC_API_KEY: 'claude-key', AGENT_TUI_REVIEW_PROCESS: '1' })
  })

  it('whitelists a third-party Codex provider without copying hooks or command settings', () => {
    const environment: NodeJS.ProcessEnv = {}
    const args = codexProviderOverrides(`model = "custom-model"
model_provider = "gateway"
approval_policy = "never"
[model_providers.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
wire_api = "responses"
requires_openai_auth = true
[model_providers.gateway.http_headers]
Authorization = "secret-token"
[mcp_servers.evil]
command = "do-not-run"
[hooks]
command = "also-do-not-run"
`, environment)
    expect(args.join(' ')).toContain('https://gateway.example/v1')
    expect(args.join(' ')).toContain('custom-model')
    expect(args.join(' ')).not.toMatch(/secret-token|do-not-run|hooks|mcp_servers/)
    expect(environment.AGENT_TUI_REVIEW_HEADER_0).toBe('secret-token')
    expect(args.join(' ')).toContain('env_http_headers')
  })

  it('copies only explicitly referenced custom provider credentials under reviewer-only aliases', () => {
    const env = isolatedReviewerEnvironment({ CODEX_CUSTOM_API_KEY: 'custom-secret', AGENT_TUI_MANAGER_HOOK_TOKEN: 'manager-secret' })
    const args = codexProviderOverrides('model_provider="gateway"\n[model_providers.gateway]\nenv_key="CODEX_CUSTOM_API_KEY"', env, { CODEX_CUSTOM_API_KEY: 'custom-secret' })
    expect(env.CODEX_CUSTOM_API_KEY).toBeUndefined()
    expect(env.AGENT_TUI_REVIEW_CREDENTIAL_0).toBe('custom-secret')
    expect(args.join(' ')).not.toContain('custom-secret')
    expect(() => codexProviderOverrides('model_provider="gateway"\n[model_providers.gateway]\nenv_key="AGENT_TUI_MANAGER_HOOK_TOKEN"', env)).toThrow('Hook')
  })

  it('uses structured noninteractive interfaces and disables command execution and session reuse', () => {
    const codex = buildReviewerArguments('codex-cli', directory, directory, {}, 'model with spaces')
    expect(codex).toEqual(expect.arrayContaining(['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--json', '--output-schema', '--model', 'model with spaces']))
    expect(codex).toEqual(expect.arrayContaining(['shell_tool', 'hooks', 'plugins', 'code_mode_host']))
    expect(codex.join(' ')).toContain('mcp_servers.review_context')
    expect(codex.join(' ')).not.toMatch(/--resume|--continue|--full-auto|bypass-approvals/)
    const claude = buildReviewerArguments('claude-cli', directory, directory, {})
    expect(claude).toEqual(expect.arrayContaining(['--print', '--json-schema', '--no-session-persistence', '--safe-mode', '--restricted', '--tools', 'Read,Glob,Grep', '--permission-prompts', 'none']))
    expect(claude.join(' ')).not.toMatch(/Bash|PowerShell|Edit|bypassPermissions|--resume/)
  })

  it('uses stdin for untrusted commands, a private cwd, exact schema, and cleans up afterwards', async () => {
    let observedCwd = ''
    const runner = vi.fn<ReviewerProcessRunner>(async input => {
      observedCwd = input.cwd
      expect(input.cwd).not.toBe(directory)
      expect(input.args.join(' ')).not.toContain('Remove-Item')
      expect(input.prompt).toContain('Remove-Item')
      expect(JSON.parse(await readFile(join(input.cwd, 'schema.json'), 'utf8'))).toEqual({ type: 'object' })
      expect(await readFile(join(input.cwd, 'context.cjs'), 'utf8')).toBe(READONLY_CONTEXT_SERVER)
      expect(input.env.AGENT_TUI_MANAGER_HOOK_TOKEN).toBeUndefined()
      return codexOutput
    })
    vi.stubEnv('AGENT_TUI_MANAGER_HOOK_TOKEN', 'never-inherit')
    const result = await new CliSecurityReviewer(runner).complete(settings, 'system', { command: 'Remove-Item "$x" -Recurse & echo injection' }, { type: 'object' }, directory)
    expect(JSON.parse(result)).toEqual(conclusion)
    await expect(readFile(join(observedCwd, 'schema.json'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(runner).toHaveBeenCalledOnce()
  })

  it('parses only complete success results and rejects failed, partial or executable-tool output', () => {
    expect(JSON.parse(parseCliReviewOutput('codex-cli', codexOutput))).toEqual(conclusion)
    expect(() => parseCliReviewOutput('codex-cli', '{"type":"turn.failed"}')).toThrow()
    expect(() => parseCliReviewOutput('codex-cli', '{"type":"turn.completed"}')).toThrow()
    expect(() => parseCliReviewOutput('codex-cli', codexOutput + '\n{"type":"item.completed","item":{"type":"command_execution"}}')).toThrow('未授权')
    expect(JSON.parse(parseCliReviewOutput('claude-cli', JSON.stringify({ type: 'result', subtype: 'success', structured_output: conclusion })))).toEqual(conclusion)
    expect(() => parseCliReviewOutput('claude-cli', JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: JSON.stringify(conclusion) }))).toThrow()
    expect(() => parseCliReviewOutput('claude-cli', 'prefix ' + JSON.stringify(conclusion))).toThrow()
  })

  it('rejects recursion and cancellation without spawning', async () => {
    const runner = vi.fn<ReviewerProcessRunner>()
    const reviewer = new CliSecurityReviewer(runner)
    const signal = AbortSignal.abort()
    await expect(reviewer.complete(settings, '', {}, {}, directory, signal)).rejects.toThrow('取消')
    vi.stubEnv('AGENT_TUI_REVIEW_PROCESS', '1')
    await expect(reviewer.complete(settings, '', {}, {}, directory)).rejects.toThrow('递归')
    expect(runner).not.toHaveBeenCalled()
  })

  it('limits concurrent CLI reviews and ignores a result after cancellation', async () => {
    const release: Array<() => void> = []
    const runner = vi.fn<ReviewerProcessRunner>(() => new Promise(resolve => release.push(() => resolve(codexOutput))))
    const reviewer = new CliSecurityReviewer(runner)
    const controller = new AbortController()
    const first = reviewer.complete(settings, '', {}, {}, directory, controller.signal)
    const second = reviewer.complete(settings, '', {}, {}, directory)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    await expect(reviewer.complete(settings, '', {}, {}, directory)).rejects.toThrow('正忙')
    controller.abort()
    const expectation = expect(first).rejects.toThrow('取消')
    release.forEach(fn => fn())
    await expectation
    await expect(second).resolves.toBe(JSON.stringify(conclusion))
  })

  it('queues a third CLI pool review and executes it only after a real reviewer releases capacity', async () => {
    const completions: Array<() => void> = []
    const runner = vi.fn<ReviewerProcessRunner>(() => new Promise(resolve => completions.push(() => resolve(codexOutput))))
    const reviewer = new LlmSecurityReviewer(new CliSecurityReviewer(runner))
    const request: ApprovalRequest = { requestId: 'fixture', sessionId: 'fixture', displayName: 'fixture', agentKind: 'codex', workspace: directory,
      source: 'codex-hook', risk: 'unknown', reason: 'fixture', createdAt: 1, canBulkApprove: false, command: 'echo fixture' }
    const pool = { ...settings, overallTimeoutSeconds: 30, reviewers: [{ id: 'cli-fixture', name: 'CLI fixture', enabled: true, backend: 'codex-cli' as const, cliExecutable: process.execPath }] }
    const first = reviewer.reviewApproval(request, pool)
    const second = reviewer.reviewApproval(request, pool)
    const third = reviewer.reviewApproval(request, pool)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    completions[0]!()
    // Filesystem setup can let either of the first two reach the transport first.
    await Promise.race([first, second])
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(3))
    completions[1]!(); completions[2]!()
    await expect(second).resolves.toMatchObject({ verdict: 'allow' })
    await expect(first).resolves.toMatchObject({ verdict: 'allow' })
    await expect(third).resolves.toMatchObject({ verdict: 'allow', attempts: [expect.objectContaining({ status: 'completed' })] })
  })

  it('cancels queued CLI work without execution and holds running capacity until shutdown completes', async () => {
    const completions: Array<() => void> = []
    const runner = vi.fn<ReviewerProcessRunner>(() => new Promise(resolve => completions.push(() => resolve(codexOutput))))
    const reviewer = new LlmSecurityReviewer(new CliSecurityReviewer(runner))
    const request: ApprovalRequest = { requestId: 'fixture', sessionId: 'fixture', displayName: 'fixture', agentKind: 'codex', workspace: directory,
      source: 'codex-hook', risk: 'unknown', reason: 'fixture', createdAt: 1, canBulkApprove: false, command: 'echo fixture' }
    const pool = { ...settings, overallTimeoutSeconds: 30, reviewers: [{ id: 'cli-fixture', name: 'CLI fixture', enabled: true, backend: 'codex-cli' as const, cliExecutable: process.execPath }] }
    const cancelRunning = new AbortController()
    const first = reviewer.reviewApproval(request, pool, undefined, cancelRunning.signal)
    const firstRejected = expect(first).rejects.toThrow('取消')
    const second = reviewer.reviewApproval(request, pool)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    const cancelQueued = new AbortController()
    const queued = reviewer.reviewApproval(request, pool, undefined, cancelQueued.signal)
    cancelQueued.abort()
    await expect(queued).rejects.toThrow('取消')
    const third = reviewer.reviewApproval(request, pool)
    cancelRunning.abort()
    await firstRejected
    expect(runner).toHaveBeenCalledTimes(2)
    completions[0]!()
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(3))
    completions[1]!(); completions[2]!()
    await Promise.all([second, third])
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('rejects shell wrappers or relative executable paths instead of executing a shell', async () => {
    await expect(resolveReviewerExecutable('claude-cli', './claude', {}, process.platform)).rejects.toThrow('绝对路径')
    await expect(resolveReviewerExecutable('claude-cli', 'claude.cmd', { PATH: directory }, 'win32')).rejects.toThrow('找不到')
    await expect(resolveReviewerExecutable('claude-cli', 'claude\n--unsafe', {}, process.platform)).rejects.toThrow('无效')
  })

  it('resolves an npm Codex shim to the native binary without launching cmd.exe', async () => {
    const packageRoot = join(directory, 'node_modules', '@openai', 'codex')
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const vendor = join(packageRoot, 'vendor', triple, 'bin')
    await mkdir(vendor, { recursive: true })
    await writeFile(join(directory, 'codex.cmd'), '@echo this must never execute')
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@openai/codex"}')
    const binary = join(vendor, 'codex.exe')
    await writeFile(binary, 'fixture native executable path, not launched')
    expect(await resolveReviewerExecutable('codex-cli', undefined, { PATH: directory }, 'win32')).toBe(binary)
  })

  it('runs the real process transport with bounded output, timeout and abort, using only a fixture Node process', async () => {
    const base = { executable: process.execPath, cwd: directory, env: isolatedReviewerEnvironment(process.env), prompt: '', timeoutMs: 5000 }
    expect(await runReviewerProcess({ ...base, args: ['-e', 'process.stdout.write("fixture-ok")'] })).toBe('fixture-ok')
    await expect(runReviewerProcess({ ...base, args: ['-e', 'process.stdout.write("x".repeat(1100000))'] })).rejects.toThrow('超过限制')
    await expect(runReviewerProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 })).rejects.toThrow('超时')
    const controller = new AbortController()
    const pending = runReviewerProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('取消')
  }, 15_000)

  it('serves standard MCP read/list/stat calls and refuses outside paths and junctions', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(workspace, 'safe.txt'), 'read-only fixture')
    await writeFile(join(outside, 'private.txt'), 'must not appear')
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const server = join(directory, 'context.cjs')
    await writeFile(server, READONLY_CONTEXT_SERVER)
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'safe.txt' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../outside/private.txt' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'escape/private.txt' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'execute', arguments: { path: 'safe.txt' } } },
    ]
    const stdout = await runReviewerProcess({ executable: process.execPath, args: [server, workspace], cwd: directory, env: isolatedReviewerEnvironment(process.env), prompt: requests.map(value => JSON.stringify(value)).join('\n') + '\n', timeoutMs: 5000 })
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(responses[0].result.protocolVersion).toBe('2024-11-05')
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file', 'list_directory', 'inspect_path'])
    expect(responses[2].result.content[0].text).toContain('read-only fixture')
    for (const response of responses.slice(3)) expect(response.result.isError).toBe(true)
    expect(stdout).not.toContain('must not appear')
    expect(await readFile(join(workspace, 'safe.txt'), 'utf8')).toBe('read-only fixture')
  })
})
