import { describe, expect, it } from 'vitest'

import { safeAuditExport } from '../../electron/audit-export'
import type { AuditEntry } from '../../src/shared/manager-api'

describe('audit export redaction', () => {
  it('redacts known secret fields without mutating the source entry', () => {
    const entry: AuditEntry = {
      id: 'audit-1', timestamp: 1, level: 'info', category: 'remote', action: 'configured', message: 'updated',
      details: { apiKey: 'key', clientSecret: 'secret', password: 'password', accessToken: 'token', workspace: 'B:/work' },
    }
    const exported = safeAuditExport(entry)
    expect(exported.details).toEqual({ apiKey: '[已脱敏]', clientSecret: '[已脱敏]', password: '[已脱敏]', accessToken: '[已脱敏]', workspace: 'B:/work' })
    expect(entry.details?.apiKey).toBe('key')
  })
})
