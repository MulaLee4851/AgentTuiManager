interface AttentionWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
}

/** Selection alone is insufficient: the user must actually be viewing this Agent. */
export function isAttentionSessionActive(
  sessionId: string, selectedSessionId: string | undefined, window: AttentionWindow | undefined,
): boolean {
  if (sessionId !== selectedSessionId || !window) return false
  try {
    return !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused()
  } catch { return false }
}
