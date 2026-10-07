export const UI_SIZES = { compact: .85, standard: 1, comfortable: 1.1, large: 1.25 } as const
export const TERMINAL_FONT_SIZES = [10, 12, 14, 16, 18, 20] as const
export interface AppearanceSettings {
  uiSize: keyof typeof UI_SIZES
  terminalFontSize: 'auto' | typeof TERMINAL_FONT_SIZES[number]
}
export const DEFAULT_APPEARANCE_SETTINGS: Readonly<AppearanceSettings> = { uiSize: 'standard', terminalFontSize: 'auto' }

export function parseAppearanceSettings(value: unknown): AppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('界面设置格式不正确')
  const { uiSize, terminalFontSize } = value as Record<string, unknown>
  if (typeof uiSize !== 'string' || !Object.hasOwn(UI_SIZES, uiSize)) throw new Error('请选择有效的界面大小')
  if (terminalFontSize !== 'auto' && !TERMINAL_FONT_SIZES.some(size => size === terminalFontSize)) throw new Error('请选择有效的终端字号')
  return { uiSize: uiSize as AppearanceSettings['uiSize'], terminalFontSize: terminalFontSize as AppearanceSettings['terminalFontSize'] }
}
