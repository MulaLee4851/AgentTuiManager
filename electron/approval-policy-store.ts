import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { DangerRuleInput, DangerRuleSummary, DangerRuleTestResult } from '../src/shared/manager-api'
import { ApprovalPolicyEngine, type ApprovalDecision, type ApprovalSuggestion, type CustomDangerRule, type FullAutoApprovalInput } from './approval-policy'

interface StoredApprovalPolicy {
  version: 2
  rules: string[]
  dangerRules: CustomDangerRule[]
}

const MAX_RULES = 500
const MAX_DANGER_RULES = 200
const MAX_FILE_BYTES = 512 * 1024

function parseStoredPolicy(value: unknown): StoredApprovalPolicy {
  if (!value || typeof value !== 'object') return { version: 2, rules: [], dangerRules: [] }
  const record = value as Record<string, unknown>
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.rules) || record.rules.length > MAX_RULES) {
    return { version: 2, rules: [], dangerRules: [] }
  }
  const rules = record.rules.filter((rule): rule is string => typeof rule === 'string' && rule.length > 0 && rule.length <= 2_048)
  const dangerRules = record.version === 2 && Array.isArray(record.dangerRules) && record.dangerRules.length <= MAX_DANGER_RULES
    ? record.dangerRules.filter((value): value is CustomDangerRule => {
        if (!value || typeof value !== 'object') return false
        const rule = value as Record<string, unknown>
        return typeof rule.id === 'string' && typeof rule.name === 'string'
          && typeof rule.keyword === 'string' && typeof rule.enabled === 'boolean'
      })
    : []
  return { version: 2, rules, dangerRules }
}

export class ApprovalPolicyStore {
  private readonly engine: ApprovalPolicyEngine

  private constructor(private readonly path: string, rules: string[], dangerRules: CustomDangerRule[]) {
    this.engine = new ApprovalPolicyEngine()
    for (const rule of dangerRules) {
      try {
        this.engine.addDangerRule(rule)
      } catch {
        // Invalid hand-edited custom blockers are ignored; built-in rules remain active.
      }
    }
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
    let dangerRules: CustomDangerRule[] = []
    try {
      const content = await readFile(path, 'utf8')
      if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) {
        const stored = parseStoredPolicy(JSON.parse(content))
        rules = stored.rules
        dangerRules = stored.dangerRules
      }
    } catch {
      // Missing or corrupt Manager settings must never stop native Agents from starting.
    }
    return new ApprovalPolicyStore(path, rules, dangerRules)
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

  async addDangerRule(input: DangerRuleInput): Promise<DangerRuleSummary> {
    if (this.engine.listCustomDangerRules().length >= MAX_DANGER_RULES) throw new Error('自定义高危规则最多 200 条')
    const rule = this.engine.addDangerRule({ id: randomUUID(), name: input.name, keyword: input.keyword, enabled: true })
    await this.persist()
    return rule
  }

  async setDangerRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
    this.engine.setDangerRuleEnabled(ruleId, enabled)
    await this.persist()
  }

  async removeDangerRule(ruleId: string): Promise<void> {
    this.engine.removeDangerRule(ruleId)
    await this.persist()
  }

  listDangerRules(): DangerRuleSummary[] {
    return this.engine.listDangerRules()
  }

  testDangerCommand(command: string): DangerRuleTestResult {
    return this.engine.testDangerCommand(command)
  }

  canBulkApproveCommand(command: string | undefined): boolean {
    return this.engine.canBulkApproveCommand(command)
  }

  canFullAutoApprove(input: FullAutoApprovalInput): { allowed: boolean; reason: string } {
    return this.engine.canFullAutoApprove(input)
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({
        version: 2,
        rules: this.engine.listRules(),
        dangerRules: this.engine.listCustomDangerRules(),
      }, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
