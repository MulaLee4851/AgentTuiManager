import { describe, expect, it } from 'vitest'
import { TerminalFontSizer } from '../../src/terminal-font-size'

describe('terminal font independent of UI scale', () => {
  it('keeps automatic text size when larger UI chrome consumes width, but still follows real panel resizing', () => {
    const sizer = new TerminalFontSizer()
    expect(sizer.measure(900, 'standard', 'auto')).toBe(14)
    expect(sizer.measure(980, 'compact', 'auto')).toBe(14)
    expect(sizer.measure(900, 'standard', 'auto')).toBe(14)
    expect(sizer.measure(830, 'large', 'auto')).toBe(14)
    expect(sizer.measure(830, 'large', 'auto')).toBe(14)
    expect(sizer.measure(600, 'large', 'auto')).toBe(10)
    expect(sizer.measure(670, 'standard', 'auto')).toBe(10)
  })
  it('honors fixed fonts at every width and recalculates on returning to automatic', () => {
    const sizer = new TerminalFontSizer()
    expect(sizer.measure(900, 'standard', 16)).toBe(16)
    expect(sizer.measure(500, 'large', 16)).toBe(16)
    expect(sizer.measure(500, 'large', 'auto')).toBe(8)
    expect(sizer.measure(1500, 'large', 'auto')).toBe(18)
  })
})
