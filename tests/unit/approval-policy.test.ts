import { describe, expect, it } from 'vitest'

import { ApprovalPolicyEngine, classifyApprovalRisk } from '../../electron/approval-policy'

describe('ApprovalPolicyEngine', () => {
  it('classifies directory listing aliases as read-only with arguments', () => {
    const engine = new ApprovalPolicyEngine()
    expect(engine.decide('ls -la')).toMatchObject({ action: 'auto-approve', risk: 'read' })
    expect(engine.decide('dir /b')).toMatchObject({ action: 'auto-approve', risk: 'read' })
    expect(engine.decide('Get-ChildItem -Force')).toMatchObject({ action: 'auto-approve', risk: 'read' })
  })

  it('explains when a shell approval has no complete command payload', () => {
    expect(new ApprovalPolicyEngine().decide('tool:Shell')).toMatchObject({
      action: 'manual',
      risk: 'unknown',
      reason: expect.stringContaining('尚未提供完整命令和参数'),
    })
  })
  it.each(['tool:Read', 'tool:Glob', 'tool:Grep', 'pwd', 'Get-Location', 'Get-Content -LiteralPath package.json', 'Get-ChildItem -Force', 'git status --short', 'rg -n TODO src'])('auto-approves a bounded built-in read command: %s', (command) => {
    expect(new ApprovalPolicyEngine().decide(command)).toMatchObject({ action: 'auto-approve', risk: 'read' })
  })

  it.each([
    ['Remove-Item -Recurse build', 'delete'],
    ['git reset --hard', 'delete'],
    ['Set-Content file.txt hello', 'write'],
    ['npm install foo', 'write'],
    ['Get-Content a.txt | Set-Content b.txt', 'write'],
    ['rg TODO . --pre dangerous.exe', 'unknown'],
    ['Get-Content a.txt; Remove-Item a.txt', 'delete'],
    ['tool:Edit', 'write'],
    ['tool:Write', 'write'],
    ['tool:Task', 'unknown'],
  ] as const)('never auto-approves %s', (command, risk) => {
    expect(new ApprovalPolicyEngine([/* configured rules cannot cross the hard boundary */]).decide(command)).toMatchObject({ action: 'manual', risk })
    expect(() => new ApprovalPolicyEngine().addRule(command)).toThrow(/不能加入自动批准/)
  })

  it('learns only after repeated manual approval of the same read-only command', () => {
    const policy = new ApprovalPolicyEngine()
    expect(policy.noteManualApproval('Get-Content custom.txt')).toBeUndefined()
    expect(policy.noteManualApproval('  Get-Content   custom.txt ')).toBeUndefined()
    expect(policy.noteManualApproval('Get-Content custom.txt')).toEqual({ command: 'Get-Content custom.txt', approvalCount: 3 })
    expect(policy.noteManualApproval('Remove-Item custom.txt')).toBeUndefined()
  })

  it('supports removable exact user rules without widening to similar commands', () => {
    const policy = new ApprovalPolicyEngine()
    policy.addRule('Get-Content special.txt')
    expect(policy.decide('get-content special.txt').action).toBe('auto-approve')
    expect(policy.decide('Get-Content other.txt').matchedRule).toBe('read-file')
    policy.removeRule('GET-CONTENT SPECIAL.TXT')
    expect(policy.listRules()).toEqual([])
  })

  it('treats unparsed and compound commands as unknown', () => {
    expect(classifyApprovalRisk('custom-tool --inspect')).toBe('unknown')
    expect(classifyApprovalRisk('pwd && whoami')).toBe('unknown')
    expect(new ApprovalPolicyEngine().decide(undefined).action).toBe('manual')
  })

  it('allows an explicitly configured simple command while keeping exact matching', () => {
    const policy = new ApprovalPolicyEngine()
    policy.addRule('read')
    expect(policy.decide('read')).toMatchObject({ action: 'auto-approve', matchedRule: 'read' })
    expect(policy.decide('read secret.txt').action).toBe('manual')
  })
})
