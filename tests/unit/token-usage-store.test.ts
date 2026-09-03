import { describe, expect, it, vi } from 'vitest'

import type { SessionSummary } from '../../src/shared/manager-api'

vi.mock('../../electron/native-session-usage', () => ({
  readNativeSessionUsage: vi.fn(async () => [
    { sourceKey: 'usage:1', timestamp: 1_000, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 12 },
    { sourceKey: 'usage:2', timestamp: 2_000, inputTokens: 20, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 24 },
    { sourceKey: 'usage:3', timestamp: 3_000, inputTokens: 30, outputTokens: 6, cacheReadTokens: 9, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 36 },
  ]),
}))

import { TokenUsageStore } from '../../electron/token-usage-store'

const session: SessionSummary = {
  sessionId: 'manager-session', nativeSessionId: 'native-session', displayName: 'Backend', agentKind: 'codex', workspace: 'B:\\demo',
  status: 'running', recoveryAttempts: 0, userStopRequested: false,
  agentConfig: { enabled: true, source: 'custom', profileId: 'config-c', providerId: 'provider-c', model: 'model-c', extraArgs: [], hasApiKey: true },
}

describe('TokenUsageStore', () => {
  it('attributes usage to the configuration active at the event timestamp', async () => {
    const store = new TokenUsageStore()
    store.noteSessionConfig(session.sessionId, { ...session.agentConfig!, profileId: 'config-a', providerId: 'provider-a', model: 'model-a' }, 500)
    store.noteSessionConfig(session.sessionId, { ...session.agentConfig!, profileId: 'config-b', providerId: 'provider-b', model: 'model-b' }, 1_500)
    store.noteSessionConfig(session.sessionId, session.agentConfig, 2_500)

    const page = await store.listDetails({ pageSize: 10 }, [session])
    expect(page.records.map((record) => [record.timestamp, record.profileId, record.model])).toEqual([
      [3_000, 'config-c', 'model-c'], [2_000, 'config-b', 'model-b'], [1_000, 'config-a', 'model-a'],
    ])
  })
})
