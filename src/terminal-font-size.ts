import type { AppearanceSettings } from './shared/appearance-settings'

/** UI chrome can consume more width without changing the CLI's automatic font. */
export class TerminalFontSizer {
  private measurement?: { width: number; referenceWidth: number; uiSize: AppearanceSettings['uiSize']; preference: AppearanceSettings['terminalFontSize'] }

  measure(width: number, uiSize: AppearanceSettings['uiSize'], preference: AppearanceSettings['terminalFontSize']): number {
    const previous = this.measurement
    const referenceWidth = !previous || previous.preference !== preference ? width
      : previous.uiSize !== uiSize ? previous.referenceWidth
        : previous.referenceWidth + width - previous.width
    this.measurement = { width, referenceWidth, uiSize, preference }
    return preference === 'auto' ? Math.max(8, Math.min(18, Math.floor(referenceWidth / (100 * .62)))) : preference
  }
}
