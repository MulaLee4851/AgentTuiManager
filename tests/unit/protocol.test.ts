import { describe, expect, expectTypeOf, it } from 'vitest'

import type { HostCommand, HostEvent } from '../../src/shared/protocol'

describe('host protocol', () => {
  it('starts a native CLI using only executable terminal process data', () => {
    const command = {
      type: 'start',
      agentKind: 'codex',
      executable: 'codex',
      args: ['--resume', 'session-1'],
      cwd: 'B:/workspace',
      cols: 120,
      rows: 36,
    } satisfies HostCommand

    expectTypeOf(command).toMatchTypeOf<HostCommand>()
    expect(command).toEqual({
      type: 'start',
      agentKind: 'codex',
      executable: 'codex',
      args: ['--resume', 'session-1'],
      cwd: 'B:/workspace',
      cols: 120,
      rows: 36,
    })
  })

  it('reports process exit with an optional numeric signal', () => {
    const event = {
      type: 'exit',
      exitCode: 130,
      signal: 2,
    } satisfies HostEvent

    expectTypeOf(event).toMatchTypeOf<HostEvent>()
    expect(event).toEqual({ type: 'exit', exitCode: 130, signal: 2 })
  })

  it('carries structured Claude permission details without the edited content', () => {
    const event = {
      type: 'permission-request',
      requestId: 'request-1',
      toolName: 'Write',
      operation: 'write',
      filePath: 'B:/workspace/README.md',
      toolInputSummary: 'B:/workspace/README.md',
    } satisfies HostEvent

    expectTypeOf(event).toMatchTypeOf<HostEvent>()
    expect(event).not.toHaveProperty('toolInput')
  })
})
