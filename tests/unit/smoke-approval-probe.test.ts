import { describe, expect, it } from 'vitest'

describe('smoke approval probe', () => {
  it('passes a trivial assertion so the session can exercise approval UI', () => {
    expect(1 + 1).toBe(2)
  })
})
