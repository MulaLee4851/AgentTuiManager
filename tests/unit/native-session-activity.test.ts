import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeSessionActivityMonitor, parseNativeActivity } from '../../electron/native-session-activity'
import { sessionDisplayStatus, parseSessionDisplayStatus } from '../../src/shared/session-state'
import type { SessionSummary } from '../../src/shared/manager-api'

describe('native task activity', () => {
  it('treats a failed task_complete as an error so overnight recovery uses backoff', () => {
    expect(parseNativeActivity('codex', { timestamp: 1000, type: 'event_msg',
      payload: { type: 'task_complete', error: { message: 'retries exhausted' } } }, 'native-one'))
      .toEqual({ timestamp: 1000, activity: 'error', error: 'retries exhausted' })
  })
  it('extracts assistant output without mistaking user prompts or commentary for completion', () => {
    const event = { timestamp: 1000, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'TASK-DONE' } }
    expect(parseNativeActivity('codex', event, 'native-one')?.assistantMessage?.text).toBe('TASK-DONE')
    expect(parseNativeActivity('codex', { ...event, payload: { type: 'user_message', message: 'continue TASK-DONE' } }, 'native-one')?.assistantMessage).toBeUndefined()
    expect(parseNativeActivity('codex', { timestamp: 1000, type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'TASK-DONE' }] } }, 'native-one')).toBeUndefined()
  })
  it('only exposes real parent user messages as delivery receipts', () => {
    const codex = { timestamp: 1000, type: 'event_msg', payload: { type: 'user_message', message: 'continue' } }
    expect(parseNativeActivity('codex', codex, 'native-one')?.userMessage).toEqual({ text: 'continue', timestamp: 1000 })
    const claude = { timestamp: 1000, type: 'user', message: { content: [{ type: 'text', text: 'continue' }] } }
    expect(parseNativeActivity('claude', claude, 'native-one')?.userMessage?.text).toBe('continue')
    expect(parseNativeActivity('claude', { ...claude, isSidechain: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('claude', { ...claude, isMeta: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('claude', { ...claude, message: { content: [{ type: 'tool_result', content: 'continue' }] } }, 'native-one')?.userMessage).toBeUndefined()
  })
  it.each([
    ['task_started', 'running'], ['task_complete', 'completed'], ['turn_aborted', 'idle'],
  ])('maps Codex %s to %s', (type, activity) => {
    expect(parseNativeActivity('codex', {
      timestamp: 1000, type: 'event_msg', payload: { type },
    }, 'native-one')).toEqual({ timestamp: 1000, activity })
  })

  it('distinguishes errors from retries and ignores subagent or foreign events', () => {
    const event = { timestamp: 1000, type: 'event_msg', payload: { type: 'error', message: 'failed' } }
    expect(parseNativeActivity('codex', event, 'native-one')?.activity).toBe('error')
    expect(parseNativeActivity('codex', { ...event, payload: { ...event.payload, will_retry: true } }, 'native-one')?.activity).toBe('running')
    expect(parseNativeActivity('claude', { timestamp: 1000, type: 'assistant', isSidechain: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('codex', { ...event, sessionId: 'native-two' }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('codex', { ...event, timestamp: 'invalid' }, 'native-one')).toBeUndefined()
  })

  it('recognizes Claude completion and API errors', () => {
    expect(parseNativeActivity('claude', {
      timestamp: 1000, type: 'assistant', message: { stop_reason: 'end_turn' },
    }, 'native-one')?.activity).toBe('completed')
    expect(parseNativeActivity('claude', {
      timestamp: 1001, type: 'assistant', isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'service unavailable' }] },
    }, 'native-one')).toEqual({ timestamp: 1001, activity: 'error', error: 'service unavailable' })
  })

  it('projects five display states without changing lifecycle or approvals', () => {
    expect(sessionDisplayStatus({ status: 'running', activity: 'idle' })).toBe('idle')
    expect(sessionDisplayStatus({ status: 'running', activity: 'completed' })).toBe('idle')
    expect(sessionDisplayStatus({ status: 'needs_approval', activity: 'completed' })).toBe('needs_approval')
    expect(sessionDisplayStatus({ status: 'stopped', activity: 'running' })).toBe('stopped')
    expect(parseSessionDisplayStatus('待命')).toBe('idle')
    expect(parseSessionDisplayStatus('异常')).toBe('error')
  })

  it('polls complete records only, skips unchanged files and respects the current run boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atm-activity-'))
    try {
      const folder = join(root, '2026', '09')
      await mkdir(folder, { recursive: true })
      const path = join(folder, 'rollout-test-native-one.jsonl')
      const row = (timestamp: number, type: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })
      await writeFile(path, row(100, 'task_complete') + '\n' + row(300, 'task_started') + '\n' + row(400, 'task_complete'))
      const session = { sessionId: 'manager-one', nativeSessionId: 'native-one',
        agentKind: 'codex', status: 'running', activitySince: 200 } as SessionSummary
      const onActivity = vi.fn()
      const monitor = new NativeSessionActivityMonitor(() => [session], onActivity, { codex: root, claude: root })
      await monitor.poll()
      expect(onActivity).toHaveBeenLastCalledWith(session, { activity: 'running', timestamp: 300 })
      await monitor.poll()
      expect(onActivity).toHaveBeenCalledTimes(1)
      await appendFile(path, '\n')
      await monitor.poll()
      expect(onActivity).toHaveBeenLastCalledWith(session, { activity: 'completed', timestamp: 400 })
      monitor.stop()
      await appendFile(path, row(500, 'task_started') + '\n')
      await monitor.poll()
      expect(onActivity).toHaveBeenCalledTimes(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
