import { describe, expect, expectTypeOf, it } from 'vitest'

import type { HostCommand, HostEvent } from '../../src/shared/protocol'

describe('host protocol', () => {
  it('starts a native CLI using only executable terminal process data', () => {
    const command = {
      type: 'start',
      executable: 'codex',
      args: ['--resume', 'session-1'],
      cwd: 'B:/workspace',
      cols: 120,
      rows: 36,
    } satisfies HostCommand

    expectTypeOf(command).toMatchTypeOf<HostCommand>()
    expect(command).toEqual({
      type: 'start',
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
})
