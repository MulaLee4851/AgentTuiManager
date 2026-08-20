import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import type { DangerRuleScope, DangerRuleSummary, DangerRuleTestResult } from './shared/manager-api'

function readableError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

const SCOPE_LABEL: Record<DangerRuleScope, string> = {
  'safe-rule': '禁止加入安全命令',
  'bulk-approval': '批量批准跳过',
  'full-auto': '全自动模式拦截',
}

export default function ApprovalRulesDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<'approval' | 'danger'>('approval')
  const [rules, setRules] = useState<string[]>([])
  const [dangerRules, setDangerRules] = useState<DangerRuleSummary[]>([])
  const [command, setCommand] = useState('')
  const [dangerName, setDangerName] = useState('')
  const [dangerKeyword, setDangerKeyword] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [testResult, setTestResult] = useState<DangerRuleTestResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [actionBusy, setActionBusy] = useState('')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const dangerApiAvailable = typeof window.agentManager.listDangerRules === 'function'
    && typeof window.agentManager.addDangerRule === 'function'
    && typeof window.agentManager.setDangerRuleEnabled === 'function'
    && typeof window.agentManager.removeDangerRule === 'function'
    && typeof window.agentManager.testDangerCommand === 'function'

  const builtInDangerRules = useMemo(
    () => dangerRules.filter((rule) => rule.origin === 'built-in'),
    [dangerRules],
  )
  const customDangerRules = useMemo(
    () => dangerRules.filter((rule) => rule.origin === 'custom'),
    [dangerRules],
  )

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const armBackdropClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }

  const resetBackdropClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }

  const reload = async (): Promise<void> => {
    const [approvalRules, highRiskRules] = await Promise.all([
      window.agentManager.listApprovalRules(),
      typeof window.agentManager.listDangerRules === 'function'
        ? window.agentManager.listDangerRules()
        : Promise.resolve([]),
    ])
    setRules(approvalRules)
    setDangerRules(highRiskRules)
  }

  useEffect(() => {
    void reload().catch((reason) => setError(readableError(reason))).finally(() => setBusy(false))
  }, [])

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      await window.agentManager.addApprovalRule(command)
      setCommand('')
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  const remove = async (rule: string): Promise<void> => {
    setError('')
    try {
      await window.agentManager.removeApprovalRule(rule)
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  const addDanger = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setActionBusy('add-danger')
    try {
      if (!dangerApiAvailable) throw new Error('高危规则管理需要重启 Manager 后启用')
      await window.agentManager.addDangerRule({ name: dangerName, keyword: dangerKeyword })
      setDangerName('')
      setDangerKeyword('')
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setActionBusy('')
    }
  }

  const toggleDanger = async (rule: DangerRuleSummary): Promise<void> => {
    setError('')
    setActionBusy(rule.id)
    try {
      if (!dangerApiAvailable) throw new Error('高危规则管理需要重启 Manager 后启用')
      await window.agentManager.setDangerRuleEnabled(rule.id, !rule.enabled)
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setActionBusy('')
    }
  }

  const removeDanger = async (rule: DangerRuleSummary): Promise<void> => {
    setError('')
    setActionBusy(rule.id)
    try {
      if (!dangerApiAvailable) throw new Error('高危规则管理需要重启 Manager 后启用')
      await window.agentManager.removeDangerRule(rule.id)
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setActionBusy('')
    }
  }

  const testDanger = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setActionBusy('test-danger')
    try {
      if (!dangerApiAvailable) throw new Error('高危规则管理需要重启 Manager 后启用')
      setTestResult(await window.agentManager.testDangerCommand(testCommand))
    } catch (reason) {
      setTestResult(undefined)
      setError(readableError(reason))
    } finally {
      setActionBusy('')
    }
  }

  const renderDangerRule = (rule: DangerRuleSummary): JSX.Element => <article
    className={'danger-rule-row' + (rule.enabled ? '' : ' disabled')}
    key={rule.id}
  >
    <div className='danger-rule-head'>
      <strong>{rule.name}</strong>
      <span className={rule.origin === 'built-in' ? 'rule-origin built-in' : 'rule-origin'}>{rule.origin === 'built-in' ? '内置底线' : rule.enabled ? '自定义 · 已启用' : '自定义 · 已停用'}</span>
    </div>
    <code title={rule.pattern}>{rule.pattern}</code>
    <p>{rule.description}</p>
    <div className='danger-rule-foot'>
      <span>{rule.scopes.map((scope) => SCOPE_LABEL[scope]).join(' · ')}</span>
      {rule.origin === 'custom' && <div>
        <button type='button' className='button-secondary button-compact' disabled={actionBusy === rule.id} onClick={() => { void toggleDanger(rule) }}>{rule.enabled ? '停用' : '启用'}</button>
        <button type='button' className='button-danger button-compact' disabled={actionBusy === rule.id} onClick={() => { void removeDanger(rule) }}>删除</button>
      </div>}
    </div>
  </article>

  return <div className='modal-backdrop' role='presentation'
    onMouseDown={(event) => { if (event.target === event.currentTarget) armBackdropClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}>
    <section className='rules-dialog' role='dialog' aria-modal='true' aria-labelledby='approval-rules-title' onMouseDown={resetBackdropClose}>
      <header><div><span className='eyebrow'>SAFETY</span><h2 id='approval-rules-title'>{tab === 'approval' ? '自动批准规则' : '高危命令规则'}</h2></div><button type='button' className='icon-button' onClick={onClose} aria-label='关闭规则设置'>×</button></header>
      <nav className='rules-tabs' aria-label='审批规则类型'>
        <button type='button' className={tab === 'approval' ? 'active' : ''} aria-pressed={tab === 'approval'} onClick={() => { setTab('approval'); setError('') }}>自动批准</button>
        <button type='button' className={tab === 'danger' ? 'active danger' : ''} aria-pressed={tab === 'danger'} onClick={() => { setTab('danger'); setError('') }}>高危命令 <span>{dangerRules.filter((rule) => rule.enabled).length}</span></button>
      </nav>

      {tab === 'approval' ? <>
        <p className='rules-help'>填写一条实际执行的完整命令。规则只做完整匹配；命中高危规则的命令不会加入。</p>
        <form className='rule-add' onSubmit={(event) => { void add(event) }}>
          <input aria-label='新增批准命令' required value={command} onChange={(event) => setCommand(event.target.value)} placeholder='例如：git log --oneline' />
          <button type='submit' className='button-primary'>添加</button>
        </form>
        {error && <p className='form-error'>{error}</p>}
        <div className='rules-list'>
          {busy ? <p className='field-note'>正在读取规则…</p> : rules.length === 0 ? <p className='field-note'>还没有自定义规则</p> : rules.map((rule) => <div className='rule-row' key={rule}><code title={rule}>{rule}</code><button type='button' className='button-danger' onClick={() => { void remove(rule) }}>撤销</button></div>)}
        </div>
      </> : <>
        <p className='rules-help'>内置底线始终生效且不能删除。自定义规则按关键词包含匹配且不区分大小写，只会扩大拦截范围，不会放宽现有安全边界。</p>
        {!dangerApiAvailable && <p className='form-error'>当前主进程尚未加载高危规则接口，请重启 Manager 后使用。</p>}
        <form className='danger-rule-add' onSubmit={(event) => { void addDanger(event) }}>
          <input aria-label='高危规则名称' required maxLength={80} value={dangerName} onChange={(event) => setDangerName(event.target.value)} placeholder='例如：生产环境部署' />
          <input aria-label='高危命令关键词' required minLength={2} maxLength={256} value={dangerKeyword} onChange={(event) => setDangerKeyword(event.target.value)} placeholder='例如：kubectl delete' />
          <button type='submit' className='button-danger' disabled={!dangerApiAvailable || actionBusy === 'add-danger'}>{actionBusy === 'add-danger' ? '请稍后…' : '添加拦截'}</button>
        </form>
        <form className='danger-rule-test' onSubmit={(event) => { void testDanger(event) }}>
          <label htmlFor='danger-command-test'>测试一条命令会命中哪些规则</label>
          <div><input id='danger-command-test' required value={testCommand} onChange={(event) => { setTestCommand(event.target.value); setTestResult(undefined) }} placeholder='粘贴完整命令，不会执行' /><button type='submit' className='button-secondary' disabled={!dangerApiAvailable || actionBusy === 'test-danger'}>{actionBusy === 'test-danger' ? '检测中…' : '检测'}</button></div>
          {testResult && <div className={'danger-test-result ' + (testResult.matches.length ? 'matched' : 'clear')}>
            <strong>{testResult.matches.length ? '命中 ' + testResult.matches.length + ' 条高危规则' : '未命中高危规则'}</strong>
            {testResult.matches.length > 0 && <span>{testResult.matches.map((rule) => rule.name).join(' · ')}</span>}
          </div>}
        </form>
        {error && <p className='form-error'>{error}</p>}
        <div className='danger-rules-list'>
          {busy ? <p className='field-note'>正在读取规则…</p> : <>
            <div className='danger-rule-section'><strong>自定义规则</strong><span>{customDangerRules.length} 条</span></div>
            {customDangerRules.length === 0 ? <p className='field-note'>还没有自定义高危规则</p> : customDangerRules.map(renderDangerRule)}
            <div className='danger-rule-section'><strong>内置安全底线</strong><span>{builtInDangerRules.length} 条 · 始终启用</span></div>
            {builtInDangerRules.map(renderDangerRule)}
          </>}
        </div>
      </>}

      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭，已填写内容会保留</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
