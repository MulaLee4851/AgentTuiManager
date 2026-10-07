import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { ApprovalPolicyEngine } from '../../electron/approval-policy'
import { LlmSecurityReviewer } from '../../electron/llm-security-reviewer'
import type { StoredLlmReviewSettings } from '../../electron/llm-review-settings-store'
import { SessionController, type FullAutoActivityPort, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostHandle } from '../../electron/session-host-manager'
import type { ApprovalRequest, LlmReviewConclusion } from '../../src/shared/manager-api'
import type { HostEvent } from '../../src/shared/protocol'

// Only the Agent host is simulated: policy, routing, review serialization,
// HTTP transport, response parsing and delivery all use production classes.
// Commands are fixture strings and are never executed by this handle.
class FixtureHost implements HostHandle {
  readonly hostId = 'approval-http-fixture'
  readonly writes: string[] = []
  readonly responses: Array<{ requestId: string; action: 'allow' | 'ask' | 'deny'; reason?: string }> = []
  private readonly events: HostEvent[] = []
  private readonly waiters: Array<(event: HostEvent) => void> = []
  constructor(readonly permissionHook: 'codex' | 'claude') {}
  nextEvent(): Promise<HostEvent> {
    const event = this.events.shift()
    return event ? Promise.resolve(event) : new Promise(resolve => this.waiters.push(resolve))
  }
  emit(event: HostEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.events.push(event)
  }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  async replay(): Promise<string> { return '' }
  async stop(): Promise<void> { this.emit({ type: 'exit', exitCode: 0 }) }
  async preserveOnDisconnect(): Promise<void> {}
  resumeManagement(): void {}
  async ping(): Promise<'managed'> { return 'managed' }
  disconnect(): void {}
  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny', reason?: string): void {
    this.responses.push({ requestId, action, reason })
  }
}

type Reply = 'allow' | 'deny' | 'unavailable' | 'malformed'
type HttpCall = { service: string; method?: string; path?: string; body: {
  model?: string; messages?: Array<{ role: string; content: string }>
} }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

async function loopbackReviewServices(plan: Record<string, Reply[]>) {
  const calls: HttpCall[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const service = request.url?.split('/')[1] ?? ''
      let body: HttpCall['body']
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HttpCall['body'] }
      catch { response.writeHead(400).end(); return }
      calls.push({ service, method: request.method, path: request.url, body })
      const reply = plan[service]?.shift()
      response.setHeader('Content-Type', 'application/json')
      if (!reply || reply === 'unavailable') {
        response.writeHead(503).end(JSON.stringify({ error: 'fixture service unavailable' }))
        return
      }
      const conclusion = reply === 'malformed' ? { unrelated: true } : {
        verdict: reply, riskScore: reply === 'allow' ? 5 : 90,
        summary: reply === 'allow' ? 'Fixture scope accepted' : 'Fixture deletion target is not constrained; use a scoped preview',
        reasons: ['Synthetic local HTTP evidence'], hazards: [], assumptions: [],
      }
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(conclusion) } }] }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address() as AddressInfo
  return { calls, baseUrl: `http://127.0.0.1:${address.port}` }
}

const workspace = 'C:\\approval-http-fixture'
const highRisk = 'Remove-Item -LiteralPath .\\fixture-cache-a -Recurse -Force'

async function fixture(kind: 'codex' | 'claude', plan: Record<string, Reply[]>) {
  const http = await loopbackReviewServices(plan)
  const settings: StoredLlmReviewSettings = {
    enabled: true, level: 'high', retryCount: 0, timeoutSeconds: 2, overallTimeoutSeconds: 5,
    scheduledRuleAuditEnabled: false, scheduledRuleAuditHours: 24,
    proxyEnabled: false, proxyHost: '127.0.0.1', proxyPort: 7897,
    reviewers: Object.keys(plan).map(id => ({ id, name: `Fixture ${id}`, enabled: true, backend: 'api',
      protocol: 'openai-chat', baseUrl: `${http.baseUrl}/${id}/v1`, apiKey: 'synthetic-fixture-key', model: `fixture-model-${id}` })),
  }
  const host = new FixtureHost(kind)
  const manager: SessionHostManagerPort = {
    start: async () => host, reconnect: async () => host, listLiveHosts: async () => [],
    readLastExit: async () => undefined, updateMetadata: async () => undefined,
    removeArtifacts: async () => undefined, release: async () => undefined,
  }
  const reviewed: LlmReviewConclusion[] = []
  const failures: ApprovalRequest[] = []
  const userPending: ApprovalRequest[] = []
  const activity: FullAutoActivityPort = {
    approved: () => undefined, blocked: () => undefined,
    reviewed: (_request, conclusion) => { reviewed.push(conclusion) },
    reviewFailed: request => { failures.push(request) },
    pending: request => { userPending.push(request) },
  }
  const reviewer = new LlmSecurityReviewer()
  const controller = new SessionController(manager, undefined, undefined, new ApprovalPolicyEngine(), undefined, activity,
    undefined, undefined, undefined, {
      getSettings: () => settings,
      reviewApproval: (request, localRiskReason, signal) => reviewer.reviewApproval(request, settings, localRiskReason, signal),
    })
  cleanup.push(async () => { await controller.stopAllSessions() })
  const session = await controller.startSession({ displayName: 'HTTP routing fixture', agentKind: kind, workspace,
    executable: 'fixture-never-executed', args: [], cols: 100, rows: 30, nativeSessionId: 'fixture-native-session' })
  await controller.setApprovalMode(session.sessionId, 'agent-review')
  const emit = (requestId: string, command = highRisk, operation: 'read' | 'write' | 'delete' | 'unknown' = 'delete') => {
    host.emit({ type: 'permission-request', hookSource: kind, requestId, toolName: 'PowerShell', command,
      operation, cwd: workspace, toolInput: { command, cwd: workspace } })
  }
  const waitForResponses = async (count: number) => {
    await expect.poll(() => host.responses.length, { timeout: 4000, interval: 10 }).toBe(count)
    expect(controller.listPendingApprovals()).toEqual([])
    expect(userPending).toEqual([])
    expect(host.writes).toEqual([])
  }
  return { ...http, host, controller, reviewed, failures, emit, waitForResponses }
}

describe.each(['codex', 'claude'] as const)('%s AI approval routing over real loopback HTTP', kind => {
  it('bypasses HTTP for ordinary commands and delivers parsed allow/deny for high-risk commands', async () => {
    const f = await fixture(kind, { A: ['allow', 'deny'] })
    f.emit('ordinary-read', 'git status --short', 'read')
    f.emit('ordinary-write', 'Set-Content -LiteralPath .\\fixture-notes.txt updated', 'write')
    f.emit('ordinary-build', 'npm test', 'unknown')
    await f.waitForResponses(3)
    expect(f.calls).toEqual([])
    f.emit('risky-allowed')
    await f.waitForResponses(4)
    const secondRisk = highRisk.replace('cache-a', 'cache-b')
    f.emit('risky-denied', secondRisk)
    await f.waitForResponses(5)
    expect(f.host.responses.map(({ requestId, action }) => ({ requestId, action }))).toEqual([
      { requestId: 'ordinary-read', action: 'allow' }, { requestId: 'ordinary-write', action: 'allow' },
      { requestId: 'ordinary-build', action: 'allow' }, { requestId: 'risky-allowed', action: 'allow' },
      { requestId: 'risky-denied', action: 'deny' },
    ])
    expect(f.calls).toHaveLength(2)
    for (const [index, call] of f.calls.entries()) {
      expect(call).toMatchObject({ method: 'POST', path: '/A/v1/chat/completions', body: { model: 'fixture-model-A' } })
      const payload = JSON.parse(call.body.messages!.find(message => message.role === 'user')!.content)
      expect(payload).toMatchObject({ agentKind: kind, source: `${kind}-hook`, workspace, cwd: workspace,
        command: index === 0 ? highRisk : secondRisk, localRiskReason: expect.any(String) })
    }
    expect(f.reviewed.map(result => result.verdict)).toEqual(['allow', 'deny'])
    expect(f.failures).toEqual([])
  })

  it('fails over a service error from A to B and delivers B approval once', async () => {
    const f = await fixture(kind, { A: ['unavailable'], B: ['allow'] })
    f.emit('failover')
    await f.waitForResponses(1)
    expect(f.calls.map(call => call.service)).toEqual(['A', 'B'])
    expect(f.host.responses[0]).toMatchObject({ requestId: 'failover', action: 'allow' })
    expect(f.reviewed).toEqual([expect.objectContaining({ verdict: 'allow', reviewerId: 'B', attempts: [
      expect.objectContaining({ reviewerId: 'A', status: 'failed', failure: 'http' }),
      expect.objectContaining({ reviewerId: 'B', status: 'completed' }),
    ] })])
    expect(f.failures).toEqual([])
  })

  it('treats a valid A denial as final and never contacts B', async () => {
    const f = await fixture(kind, { A: ['deny'], B: ['allow'] })
    f.emit('final-denial')
    await f.waitForResponses(1)
    expect(f.calls.map(call => call.service)).toEqual(['A'])
    expect(f.host.responses[0]).toMatchObject({ requestId: 'final-denial', action: 'deny' })
    expect(f.reviewed).toEqual([expect.objectContaining({ verdict: 'deny', reviewerId: 'A', requiresHumanApproval: false })])
    expect(f.failures).toEqual([])
  })

  it('denies once when every service fails, retaining attempt evidence and no pending approval', async () => {
    const f = await fixture(kind, { A: ['unavailable'], B: ['malformed'] })
    f.emit('pool-exhausted')
    await f.waitForResponses(1)
    expect(f.calls.map(call => call.service)).toEqual(['A', 'B'])
    expect(f.host.responses[0]).toMatchObject({ requestId: 'pool-exhausted', action: 'deny' })
    expect(f.host.responses[0]?.reason).toContain('审核不可用不代表该命令已被判定危险')
    expect(f.reviewed).toEqual([])
    expect(f.failures).toEqual([expect.objectContaining({ llmReviewStatus: 'failed', llmReview: expect.objectContaining({
      verdict: 'deny', requiresHumanApproval: false, attempts: [
        expect.objectContaining({ reviewerId: 'A', status: 'failed', failure: 'http' }),
        expect.objectContaining({ reviewerId: 'B', status: 'failed', failure: 'invalid-response' }),
      ],
    }) })])
  })
})
