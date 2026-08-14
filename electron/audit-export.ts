import type { AuditEntry } from '../src/shared/manager-api'

export function safeAuditExport(entry: AuditEntry): AuditEntry {
  const details = entry.details ? Object.fromEntries(Object.entries(entry.details).map(([key, value]) =>
    /^(?:api[_-]?key|client[_-]?secret|password|authorization|access[_-]?token|auth[_-]?token)$/i.test(key)
      ? [key, '[已脱敏]']
      : [key, value])) : undefined
  return { ...entry, ...(details ? { details } : {}) }
}
