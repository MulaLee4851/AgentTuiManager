export interface TokenUsageDateRange {
  from: number
  to: number
}

/**
 * Returns calendar-day ranges in the user's local timezone.
 * "Today" starts at local midnight; longer presets include today plus the
 * preceding whole calendar days.
 */
export function tokenUsageDateRange(days: number, now = Date.now()): TokenUsageDateRange {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1
  const end = new Date(now)
  const start = new Date(end)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (safeDays - 1))
  return { from: start.getTime(), to: end.getTime() }
}
