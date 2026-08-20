import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ApprovalPolicyStore } from '../../electron/approval-policy-store'

describe('ApprovalPolicyStore', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('persists accepted rules and reloads them without Agent conversation data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-approval-'))
    roots.push(root)
    const path = join(root, 'approval-policy.json')
    const store = await ApprovalPolicyStore.load(path)
    await store.addRule('Get-Content special.txt')

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(persisted).toEqual({ version: 2, rules: ['get-content special.txt'], dangerRules: [] })
    expect(Object.keys(persisted)).toEqual(['version', 'rules', 'dangerRules'])
    expect((await ApprovalPolicyStore.load(path)).decide('Get-Content special.txt').action).toBe('auto-approve')
  })

  it('fails closed on corrupt settings and refuses risky rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-approval-'))
    roots.push(root)
    const path = join(root, 'approval-policy.json')
    await writeFile(path, '{bad json', 'utf8')
    const store = await ApprovalPolicyStore.load(path)
    expect(store.listRules()).toEqual([])
    await expect(store.addRule('Remove-Item -Recurse build')).rejects.toThrow(/不能加入自动批准/)

    await writeFile(path, JSON.stringify({ version: 1, rules: ['Remove-Item -Recurse build'] }), 'utf8')
    const handEdited = await ApprovalPolicyStore.load(path)
    expect(handEdited.listRules()).toEqual([])
  })

  it('migrates v1 settings and persists maintainable custom danger rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-approval-'))
    roots.push(root)
    const path = join(root, 'approval-policy.json')
    await writeFile(path, JSON.stringify({ version: 1, rules: ['git log --oneline'] }), 'utf8')
    const store = await ApprovalPolicyStore.load(path)

    const rule = await store.addDangerRule({ name: '生产环境', keyword: 'prod-db' })
    expect(rule).toMatchObject({ name: '生产环境', pattern: 'prod-db', enabled: true, origin: 'custom' })
    expect(store.canBulkApproveCommand('deploy prod-db')).toBe(false)
    expect(store.testDangerCommand('deploy prod-db').matches).toEqual([
      expect.objectContaining({ id: rule.id, name: '生产环境' }),
    ])

    await store.setDangerRuleEnabled(rule.id, false)
    expect(store.canFullAutoApprove({ command: 'deploy prod-db', risk: 'unknown', workspace: 'B:\\work' }).allowed).toBe(true)
    const reloaded = await ApprovalPolicyStore.load(path)
    expect(reloaded.listRules()).toContain('git log --oneline')
    expect(reloaded.listDangerRules().find((item) => item.id === rule.id)).toMatchObject({ enabled: false })

    await reloaded.removeDangerRule(rule.id)
    expect(reloaded.listDangerRules().some((item) => item.id === rule.id)).toBe(false)
  })
})
