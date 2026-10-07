import { describe, it, expect, vi } from 'vitest'
import { NativeResumeCoordinator } from '../../electron/native-resume-coordinator'
import type { SessionSummary, StartSessionRequest } from '../../src/shared/manager-api'
const request: StartSessionRequest = { agentKind: 'codex', nativeSessionId: 'native-1', workspace: 'C:\\project', displayName: 'History', executable: 'codex', args: ['resume', 'native-1'], cols: 80, rows: 24 }
const active: SessionSummary = { sessionId: 'managed-1', nativeSessionId: 'native-1', agentKind: 'codex', workspace: 'C:\\project', displayName: 'History', status: 'running', recoveryAttempts: 0, userStopRequested: false }
describe('native resume coordination', () => {
  it('focuses the existing live session without applying profiles or launching another process', async () => {
    const start = vi.fn()
    expect(await new NativeResumeCoordinator().run(request, () => [active], start)).toEqual(active)
    expect(start).not.toHaveBeenCalled()
  })
  it('coalesces concurrent restoration and permits retry after a failed launch', async () => {
    const coordinator = new NativeResumeCoordinator()
    const start = vi.fn().mockRejectedValueOnce(new Error('fixture launch failure')).mockResolvedValue(active)
    const first = coordinator.run(request, () => [], start)
    const second = coordinator.run(request, () => [], start)
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('fixture launch failure')
    expect(await coordinator.run(request, () => [], start)).toEqual(active)
    expect(start).toHaveBeenCalledTimes(2)
  })
  it('allows restoring a stopped session and treats different Agent kinds separately', async () => {
    const start = vi.fn(async () => active)
    const coordinator = new NativeResumeCoordinator()
    await coordinator.run(request, () => [{ ...active, status: 'stopped' }], start)
    await coordinator.run({ ...request, agentKind: 'claude' }, () => [active], start)
    expect(start).toHaveBeenCalledTimes(2)
  })
})
