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
    expect(persisted).toEqual({ version: 1, rules: ['get-content special.txt'] })
    expect(Object.keys(persisted)).toEqual(['version', 'rules'])
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
})
