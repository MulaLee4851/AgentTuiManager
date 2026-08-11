import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface StoredRecoveryPolicy {
  version: 1
  reasons: string[]
}

const MAX_REASONS = 200
const MAX_REASON_LENGTH = 2_048
const MAX_FILE_BYTES = 512 * 1024

export function normalizeRecoveryReason(reason: string): string | undefined {
  if (!reason || reason.length > MAX_REASON_LENGTH || reason.includes('\0')) return undefined
  const normalized = reason.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  return normalized || undefined
}

function parseStoredPolicy(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.reasons) || record.reasons.length > MAX_REASONS) return []
  return record.reasons.filter((reason): reason is string => normalizeRecoveryReason(typeof reason === 'string' ? reason : '') !== undefined)
}

export class RecoveryPolicyStore {
  private readonly reasons = new Set<string>()

  private constructor(private readonly path: string, reasons: string[]) {
    for (const reason of reasons) {
      const normalized = normalizeRecoveryReason(reason)
      if (normalized) this.reasons.add(normalized)
    }
  }

  static async load(path: string): Promise<RecoveryPolicyStore> {
    let reasons: string[] = []
    try {
      const content = await readFile(path, 'utf8')
      if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) reasons = parseStoredPolicy(JSON.parse(content))
    } catch {
      // Missing or corrupt Manager settings must not block native Agents.
    }
    return new RecoveryPolicyStore(path, reasons)
  }

  hasRule(reason: string): boolean {
    const normalized = normalizeRecoveryReason(reason)
    return normalized !== undefined && this.reasons.has(normalized)
  }

  async addRule(reason: string): Promise<void> {
    const normalized = normalizeRecoveryReason(reason)
    if (!normalized) throw new Error('无法保存这条恢复规则：异常原因为空或过长')
    this.reasons.add(normalized)
    await this.persist()
  }

  listRules(): string[] {
    return [...this.reasons].sort()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const policy: StoredRecoveryPolicy = { version: 1, reasons: this.listRules() }
      await writeFile(temporary, JSON.stringify(policy, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
