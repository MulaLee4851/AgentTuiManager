import { describe, expect, it } from 'vitest'

import { tokenUsageDateRange } from '../../src/token-usage-range'

describe('tokenUsageDateRange', () => {
  it('uses local midnight for today instead of a rolling 24-hour window', () => {
    const now = new Date(2026, 8, 4, 15, 26, 30, 123)
    const range = tokenUsageDateRange(1, now.getTime())

    expect(range).toEqual({
      from: new Date(2026, 8, 4, 0, 0, 0, 0).getTime(),
      to: now.getTime(),
    })
  })

  it('includes today and the preceding six local calendar days for seven days', () => {
    const now = new Date(2026, 8, 4, 15, 26, 30, 123)
    const range = tokenUsageDateRange(7, now.getTime())

    expect(range).toEqual({
      from: new Date(2026, 7, 29, 0, 0, 0, 0).getTime(),
      to: now.getTime(),
    })
  })
})
