import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { migrateCodexSessionProvider } from '../../electron/codex-session-provider-migrator'

describe('Codex session Provider migration', () => {
  it('only replaces managed thread settings in the requested session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-migrator-'))
    const sessionId = '019f649d-147c-7161-a424-73073c65f441'
    const file = join(root, `rollout-${sessionId}.jsonl`)
    await writeFile(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model_provider_id: 'agent_tui_manager' } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model_provider_id: 'custom' } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model_provider_id: 'agent_tui_manager' } } }),
      'not-json',
    ].join('\n') + '\n')

    const result = await migrateCodexSessionProvider(sessionId, 'custom', root)
    expect(result.changed).toBe(true)
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    expect(JSON.parse(lines[0]!).payload.thread_settings.model_provider_id).toBe('agent_tui_manager')
    expect(JSON.parse(lines[1]!).payload.thread_settings.model_provider_id).toBe('custom')
    expect(JSON.parse(lines[2]!).payload.thread_settings.model_provider_id).toBe('custom')
    expect(lines[3]).toBe('not-json')
  })

  it('does not touch an unaffected session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-migrator-'))
    const sessionId = '019f649d-147c-7161-a424-73073c65f440'
    const file = join(root, `rollout-${sessionId}.jsonl`)
    const source = JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model_provider_id: 'custom' } } }) + '\n'
    await writeFile(file, source)
    const result = await migrateCodexSessionProvider(sessionId, 'custom', root)
    expect(result.changed).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(source)
  })
})
