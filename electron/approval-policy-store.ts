import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ApprovalPolicyEngine, type ApprovalDecision, type ApprovalSuggestion } from './approval-policy'

interface StoredApprovalPolicy {
  version: 1
  rules: string[]
}

const MAX_RULES = 500
const MAX_FILE_BYTES = 512 * 1024

function parseStoredPolicy(value: unknown): StoredApprovalPolicy {
  if (!value || typeof value !== 'object') return { version: 1, rules: [] }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.rules) || record.rules.length > MAX_RULES) return { version: 1, rules: [] }
  const rules = record.rules.filter((rule): rule is string => typeof rule === 'string' && rule.length > 0 && rule.length <= 2_048)
  return { version: 1, rules }
}

export class ApprovalPolicyStore {
  private readonly engine: ApprovalPolicyEngine

  private constructor(private readonly path: string, rules: string[]) {
    this.engine = new ApprovalPolicyEngine()
    for (const rule of rules) {
      try {
        this.engine.addRule(rule)
      } catch {
        // A hand-edited risky rule is ignored rather than widening approval or blocking startup.
      }
    }
  }

  static async load(path: string): Promise<ApprovalPolicyStore> {
    let rules: string[] = []
    try {
      const content = await readFile(path, 'utf8')
      if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) rules = parseStoredPolicy(JSON.parse(content)).rules
    } catch {
      // Missing or corrupt Manager settings must never stop native Agents from starting.
    }
    return new ApprovalPolicyStore(path, rules)
  }

  decide(command: string | undefined): ApprovalDecision {
    return this.engine.decide(command)
  }

  noteManualApproval(command: string | undefined): ApprovalSuggestion | undefined {
    return this.engine.noteManualApproval(command)
  }

  async addRule(command: string): Promise<void> {
    this.engine.addRule(command)
    await this.persist()
  }

  async removeRule(command: string): Promise<void> {
    this.engine.removeRule(command)
    await this.persist()
  }

  listRules(): string[] {
    return this.engine.listRules()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, rules: this.engine.listRules() }, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
