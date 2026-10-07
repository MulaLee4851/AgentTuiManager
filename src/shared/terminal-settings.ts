export type CodexTerminalMode = 'scrollback' | 'native-fullscreen'

export interface TerminalSettings {
  codexMode: CodexTerminalMode
}

export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = { codexMode: 'native-fullscreen' }

export function parseTerminalSettings(value: unknown): TerminalSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('终端设置格式不正确')
  const mode = (value as Record<string, unknown>).codexMode
  if (mode !== 'scrollback' && mode !== 'native-fullscreen') throw new Error('请选择有效的 Codex 终端显示模式')
  return { codexMode: mode }
}
