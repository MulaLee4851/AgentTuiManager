import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { CCSwitchProviderSummary, LlmReviewerInput, LlmReviewerSummary, LlmReviewSettingsInput, LlmReviewSettingsSummary, LlmRuleAuditFinding, LlmRuleAuditResult } from './shared/manager-api'
import CCSwitchProviderList from './CCSwitchProviderList'
import AnimatedCollapse from './AnimatedCollapse'
import './llm-reviewer-pool.css'

type ReviewerDraft = LlmReviewerInput & { hasApiKey: boolean }
function fromLegacy(value: LlmReviewSettingsSummary): ReviewerDraft {
  return { id: 'legacy-reviewer', name: '默认审核器', enabled: true, backend: value.backend ?? 'api',
    protocol: value.protocol ?? 'openai-chat', anthropicAuth: value.anthropicAuth, baseUrl: value.baseUrl, model: value.model,
    cliExecutable: value.cliExecutable, cliModel: value.cliModel, hasApiKey: value.hasApiKey }
}

function hasConnectionDraft(entry: ReviewerDraft): boolean {
  return entry.backend !== 'api' || Boolean(entry.baseUrl || entry.model || entry.apiKey || entry.hasApiKey)
}

const DEFAULTS: LlmReviewSettingsSummary = {
  enabled: false,
  backend: 'api',
  level: 'high',
  hasApiKey: false,
  retryCount: 3,
  timeoutSeconds: 30,
  scheduledRuleAuditEnabled: false,
  scheduledRuleAuditHours: 24,
  proxyEnabled: false,
  proxyHost: '127.0.0.1',
  proxyPort: 7897,
  hasProxyPassword: false,
  ruleAuditState: { status: 'idle' },
}

function readableError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

function auditTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value)
}

const SEVERITY_LABEL: Record<LlmRuleAuditFinding['severity'], string> = {
  low: '低风险',
  medium: '需要复核',
  high: '高风险',
  critical: '严重危险',
}

function isDangerousFinding(finding: LlmRuleAuditFinding): boolean {
  return finding.severity === 'high' || finding.severity === 'critical'
}

export default function LlmReviewSettingsDialog({ onClose, initialView = 'settings' }: { onClose: () => void; initialView?: 'settings' | 'results' }): JSX.Element {
  const [settings, setSettings] = useState<LlmReviewSettingsSummary>(DEFAULTS)
  const [reviewers, setReviewers] = useState<ReviewerDraft[]>([])
  const [poolActive, setPoolActive] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importKind, setImportKind] = useState<'codex' | 'claude'>('codex')
  const [providers, setProviders] = useState<CCSwitchProviderSummary[]>([])
  const [providerId, setProviderId] = useState('')
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providerError, setProviderError] = useState('')
  const [testing, setTesting] = useState(false)
  const providerRequest = useRef(0)
  const [apiKey, setApiKey] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [clearProxyPassword, setClearProxyPassword] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelMessage, setModelMessage] = useState('')
  const [manualModel, setManualModel] = useState(false)
  const modelRequest = useRef(0)
  const saving = useRef(false)
  const [auditResult, setAuditResult] = useState<LlmRuleAuditResult>()
  const [view, setView] = useState<'settings' | 'results'>(initialView)
  const [approvalRules, setApprovalRules] = useState<string[]>([])
  const [rulesBusy, setRulesBusy] = useState(initialView === 'results')
  const [selectedFindingIndex, setSelectedFindingIndex] = useState(0)
  const [deleteBusyRule, setDeleteBusyRule] = useState('')
  const [deletedRules, setDeletedRules] = useState<Set<string>>(() => new Set())
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const apiAvailable = typeof window.agentManager.getLlmReviewSettings === 'function'
    && typeof window.agentManager.updateLlmReviewSettings === 'function'
    && typeof window.agentManager.reviewApprovalRules === 'function'

  const showReviewer = (entry: ReviewerDraft | LlmReviewerSummary): void => {
    setSelectedId(entry.id)
    setSettings(current => ({ ...current, backend: entry.backend, protocol: entry.protocol ?? 'openai-chat',
      anthropicAuth: entry.anthropicAuth,
      baseUrl: entry.baseUrl, model: entry.model, hasApiKey: entry.hasApiKey,
      cliExecutable: entry.cliExecutable, cliModel: entry.cliModel }))
    setApiKey('apiKey' in entry ? entry.apiKey ?? '' : '')
    setClearApiKey('clearApiKey' in entry ? Boolean(entry.clearApiKey) : false)
  }

  const loadSummary = (value: LlmReviewSettingsSummary, preferredId?: string): void => {
    setSettings(value)
    if (value.reviewers !== undefined) {
      setPoolActive(true)
      const entries = value.reviewers
      setReviewers(entries)
      const selected = entries.find(entry => entry.id === preferredId) ?? entries[0]
      if (selected) showReviewer(selected)
      else setSelectedId('')
    }
    setApiKey(''); setClearApiKey(false)
  }

  useEffect(() => {
    if (!apiAvailable) { setBusy(false); setError('LLM 审查需要重启 Manager 后启用'); return }
    void window.agentManager.getLlmReviewSettings().then((value) => {
      loadSummary(value)
      setAuditResult(value.lastRuleAudit)
    }).catch((reason) => setError(readableError(reason))).finally(() => setBusy(false))
  }, [apiAvailable])

  useEffect(() => {
    if (initialView !== 'results') return
    setRulesBusy(true)
    void window.agentManager.listApprovalRules().then(setApprovalRules)
      .catch((reason) => setError(readableError(reason)))
      .finally(() => setRulesBusy(false))
  }, [initialView])

  useEffect(() => {
    if (!apiAvailable || settings.ruleAuditState.status !== 'running') return
    let disposed = false
    const timer = setInterval(() => {
      void window.agentManager.getLlmReviewSettings().then((value) => {
        if (disposed) return
        setSettings((current) => ({ ...current, ruleAuditState: value.ruleAuditState, lastRuleAudit: value.lastRuleAudit }))
        if (value.lastRuleAudit) setAuditResult(value.lastRuleAudit)
      }).catch((reason) => { if (!disposed) setError(readableError(reason)) })
    }, 1_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [apiAvailable, settings.ruleAuditState.status])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    modelRequest.current += 1
    setModels([]); setModelMessage(''); setModelsLoading(false)
  }, [selectedId, settings.protocol, settings.anthropicAuth, settings.backend, settings.baseUrl, apiKey, clearApiKey, settings.proxyEnabled, settings.proxyHost,
    settings.proxyPort, settings.proxyUsername, proxyPassword, clearProxyPassword])
  useEffect(() => () => { modelRequest.current += 1 }, [])

  const refreshProviders = async (): Promise<void> => {
    const request = ++providerRequest.current
    setProvidersLoading(true); setProviderError('')
    try {
      const result = await window.agentManager.listCCSwitchProviders(importKind)
      if (request !== providerRequest.current) return
      setProviders(result)
      setProviderId(current => result.some(item => item.id === current) ? current : '')
    } catch (reason) { if (request === providerRequest.current) setProviderError(readableError(reason)) }
    finally { if (request === providerRequest.current) setProvidersLoading(false) }
  }
  useEffect(() => {
    if (importOpen) { setProviders([]); setProviderId(''); void refreshProviders() }
    return () => { providerRequest.current += 1 }
  }, [importOpen, importKind])

  const currentDraft = (): ReviewerDraft => ({
    ...(reviewers.find(entry => entry.id === selectedId) ?? fromLegacy(settings)),
    backend: settings.backend ?? 'api', protocol: settings.protocol ?? 'openai-chat', anthropicAuth: settings.anthropicAuth,
    baseUrl: settings.baseUrl, model: settings.model, cliExecutable: settings.cliExecutable, cliModel: settings.cliModel,
    apiKey: apiKey || undefined, clearApiKey, hasApiKey: settings.hasApiKey,
  })
  const draftPool = (): ReviewerDraft[] => reviewers.map(entry => entry.id === selectedId ? currentDraft() : entry)
  const selectReviewer = (id: string): void => {
    const entries = draftPool()
    setReviewers(entries)
    const next = entries.find(entry => entry.id === id)
    if (next) showReviewer(next)
  }
  const addReviewer = (): void => {
    const entry: ReviewerDraft = { id: crypto.randomUUID(), name: `审核器 ${reviewers.length + 1}`, enabled: false, backend: 'api', protocol: 'openai-chat', hasApiKey: false }
    setReviewers([...(poolActive ? draftPool() : [currentDraft()].filter(hasConnectionDraft)), entry]); setPoolActive(true); showReviewer(entry)
  }
  const moveReviewer = (id: string, direction: number): void => {
    const entries = draftPool(); const index = entries.findIndex(entry => entry.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= entries.length) return
    ;[entries[index], entries[target]] = [entries[target]!, entries[index]!]
    setReviewers(entries)
  }
  const removeReviewer = (id: string): void => {
    const entries = draftPool().filter(entry => entry.id !== id)
    setReviewers(entries)
    if (id === selectedId && entries[0]) showReviewer(entries[0])
    else if (!entries.length) { setSelectedId(''); setApiKey(''); setClearApiKey(false) }
  }

  const armBackdropClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }

  const resetBackdropClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }

  const formInput = (): LlmReviewSettingsInput => ({
        ...(poolActive ? { reviewers: draftPool().map(({ hasApiKey: _hasApiKey, ...entry }) => entry) } : {}),
        protocol: settings.protocol,
        anthropicAuth: settings.anthropicAuth,
        overallTimeoutSeconds: settings.overallTimeoutSeconds ?? 120,
        enabled: settings.enabled,
        backend: settings.backend ?? 'api',
        cliExecutable: settings.cliExecutable,
        cliModel: settings.cliModel,
        level: settings.level,
        baseUrl: settings.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
        model: settings.model,
        retryCount: settings.retryCount,
        timeoutSeconds: settings.timeoutSeconds,
        scheduledRuleAuditEnabled: settings.scheduledRuleAuditEnabled,
        scheduledRuleAuditHours: settings.scheduledRuleAuditHours,
        proxyEnabled: settings.proxyEnabled,
        proxyHost: settings.proxyHost,
        proxyPort: settings.proxyPort,
        proxyUsername: settings.proxyUsername,
        ...(proxyPassword ? { proxyPassword } : {}),
        ...(clearProxyPassword ? { clearProxyPassword: true } : {}),
      })

  const persistSettings = async (): Promise<void> => {
      if (!apiAvailable) throw new Error('LLM 审查需要重启 Manager 后启用')
      const saved = await window.agentManager.updateLlmReviewSettings(formInput())
      loadSummary(saved, selectedId); setProxyPassword(''); setClearProxyPassword(false)
      setAuditResult(saved.lastRuleAudit)
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving.current) return
    saving.current = true; setBusy(true); setError('')
    try { await persistSettings() }
    catch (reason) { setError(readableError(reason)) }
    finally { saving.current = false; setBusy(false) }
  }

  const runAudit = async (): Promise<void> => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      if (!apiAvailable) throw new Error('LLM 审查需要重启 Manager 后启用')
      if (!poolActive && (settings.backend ?? 'api') === 'api') {
        const missing = [!settings.baseUrl?.trim() && '服务地址',
          (clearApiKey || !apiKey.trim() && !settings.hasApiKey) && 'API Key', !settings.model?.trim() && '审核模型'].filter(Boolean)
        if (missing.length) throw new Error('开始审查前，请填写或选择：' + missing.join('、'))
      }
      await persistSettings()
      const state = await window.agentManager.reviewApprovalRules()
      setSettings((current) => ({ ...current, ruleAuditState: state }))
    } catch (reason) { setError(readableError(reason)) }
    finally { saving.current = false; setBusy(false) }
  }

  const loadModels = async (): Promise<void> => {
    if (modelsLoading) return
    const request = ++modelRequest.current
    setModelsLoading(true); setModelMessage(''); setError('')
    try {
      if (typeof window.agentManager.listLlmReviewModels !== 'function') throw new Error('获取模型列表需要重启更新后的 Manager')
      const result = poolActive ? await window.agentManager.listLlmReviewModels(formInput(), selectedId)
        : await window.agentManager.listLlmReviewModels(formInput())
      if (request !== modelRequest.current) return
      setModels(result); setManualModel(result.length === 0)
      setModelMessage(result.length ? `已获取 ${result.length} 个模型，请从列表选择。` : '服务未返回可用模型，可以手动输入。')
    } catch (reason) {
      if (request === modelRequest.current) setModelMessage(readableError(reason) + '；也可以手动输入模型。')
    } finally { if (request === modelRequest.current) setModelsLoading(false) }
  }

  const testConnection = async (): Promise<void> => {
    if (testing) return
    const request = ++modelRequest.current
    setTesting(true); setModelMessage(''); setError('')
    try {
      if (!window.agentManager.testLlmReviewer) throw new Error('测试连接需要重启更新后的 Manager')
      const result = await window.agentManager.testLlmReviewer(formInput(), poolActive ? selectedId : undefined)
      if (request === modelRequest.current) setModelMessage(`连接正常 · ${result.model}`)
    } catch (reason) { if (request === modelRequest.current) setModelMessage(readableError(reason)) }
    finally { setTesting(false) }
  }

  const importReviewer = async (): Promise<void> => {
    if (saving.current || !providerId) return
    saving.current = true; setBusy(true); setError('')
    try {
      // Import commits only the selected credential in main. Keep other form drafts
      // locally: validating/saving the whole pool first prevents incomplete setups
      // from importing the very connection they need to finish configuration.
      const drafts = poolActive ? draftPool() : [currentDraft()].filter(hasConnectionDraft)
      const saved = await window.agentManager.importLlmReviewer({ agentKind: importKind, providerId })
      const imported = saved.reviewers?.at(-1)
      if (!imported) throw new Error('导入未返回审核器，请重新打开设置后检查')
      setReviewers([...drafts, imported]); setPoolActive(true); showReviewer(imported)
      setImportOpen(false)
    } catch (reason) { setError(readableError(reason)) }
    finally { saving.current = false; setBusy(false) }
  }

  const openResults = async (): Promise<void> => {
    setView('results')
    setSelectedFindingIndex(0)
    setError('')
    setRulesBusy(true)
    try {
      setApprovalRules(await window.agentManager.listApprovalRules())
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setRulesBusy(false)
    }
  }

  const removeReviewedRule = async (finding: LlmRuleAuditFinding): Promise<void> => {
    if (!isDangerousFinding(finding) || !approvalRules.includes(finding.rule)) return
    setDeleteBusyRule(finding.rule)
    setError('')
    try {
      await window.agentManager.removeApprovalRule(finding.rule)
      setApprovalRules((current) => current.filter((rule) => rule !== finding.rule))
      setDeletedRules((current) => new Set(current).add(finding.rule))
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setDeleteBusyRule('')
    }
  }

  if (view === 'results') {
    const selectedFinding = auditResult?.findings[selectedFindingIndex]
    const selectedRuleExists = Boolean(selectedFinding && approvalRules.includes(selectedFinding.rule))
    const selectedRuleDeleted = Boolean(selectedFinding && deletedRules.has(selectedFinding.rule))
    return <div className='modal-backdrop' role='presentation'
      onMouseDown={(event) => { if (event.target === event.currentTarget) armBackdropClose() }}
      onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}>
      <section className='rules-dialog llm-review-results-dialog' role='dialog' aria-modal='true' aria-labelledby='llm-results-title' onMouseDown={resetBackdropClose}>
        <header><div><span className='eyebrow'>RULE AUDIT</span><h2 id='llm-results-title'>批准规则审查结果</h2></div><button type='button' className='button-secondary button-compact' onClick={() => { setView('settings'); setError('') }}>返回设置</button></header>

        {settings.ruleAuditState.status === 'running' && <div className='llm-audit-progress' role='status'><i /><span><strong>新一轮审查正在后台进行</strong><small>当前先展示上一次结果；完成后这里会自动更新。</small></span></div>}
        {settings.ruleAuditState.status === 'failed' && <div className='llm-audit-progress failed' role='alert'><i /><span><strong>最近一次审查失败</strong><small>{settings.ruleAuditState.error ?? '未记录具体错误'}</small></span></div>}

        {!auditResult ? <div className='llm-audit-result-empty'><strong>还没有可查看的审查结果</strong><span>返回设置并启动一次规则检查。</span></div> : <>
          <section className='llm-audit-result-summary'>
            <div><span className='eyebrow'>LATEST RESULT</span><strong>{auditResult.summary}</strong></div>
            <dl>
              <div><dt>审查时间</dt><dd>{auditTime(auditResult.reviewedAt)}</dd></div>
              <div><dt>模型</dt><dd>{auditResult.model}</dd></div>
              <div><dt>规则数量</dt><dd>{auditResult.ruleCount}</dd></div>
              <div><dt>发现问题</dt><dd>{auditResult.findings.length}</dd></div>
            </dl>
          </section>

          {auditResult.findings.length === 0 ? <div className='llm-audit-result-empty clear'><strong>未发现危险规则</strong><span>本次 LLM 审查和本地确定性扫描均未报告问题。</span></div> : <div className='llm-audit-result-layout'>
            <nav className='llm-audit-findings' aria-label='审查问题列表'>
              {auditResult.findings.map((finding, index) => <button type='button' key={`${finding.rule}\0${finding.issue}\0${index}`} className={'severity-' + finding.severity + (selectedFindingIndex === index ? ' active' : '')} aria-pressed={selectedFindingIndex === index} onClick={() => { setSelectedFindingIndex(index); setError('') }}>
                <span><i />{SEVERITY_LABEL[finding.severity]}</span>
                <code title={finding.rule}>{finding.rule}</code>
                <small>{finding.issue}</small>
              </button>)}
            </nav>

            {selectedFinding && <article className={'llm-audit-finding-detail severity-' + selectedFinding.severity}>
              <header><div><span>{SEVERITY_LABEL[selectedFinding.severity]}</span><h3>{isDangerousFinding(selectedFinding) ? '发现危险的自动批准规则' : '规则需要人工复核'}</h3></div></header>
              <section><strong>规则原文</strong><code>{selectedFinding.rule}</code></section>
              <section><strong>发现的问题</strong><p>{selectedFinding.issue}</p></section>
              <section><strong>处理建议</strong><p>{selectedFinding.recommendation}</p></section>
              <footer className='llm-audit-finding-actions'>
                {selectedRuleDeleted ? <span className='llm-rule-removed'>已从自动批准规则中删除</span> : isDangerousFinding(selectedFinding) && selectedRuleExists ? <><span>删除只会撤销自动批准，不会执行这条命令。</span><button type='button' className='button-danger' disabled={rulesBusy || deleteBusyRule === selectedFinding.rule} onClick={() => { void removeReviewedRule(selectedFinding) }}>{deleteBusyRule === selectedFinding.rule ? '正在删除…' : '删除这条批准规则'}</button></> : isDangerousFinding(selectedFinding) ? <span>{rulesBusy ? '正在核对当前批准规则…' : '当前批准规则中已不存在这条精确规则，无需删除。'}</span> : <span>该项未达到高危删除等级，请根据建议人工复核。</span>}
              </footer>
            </article>}
          </div>}
        </>}

        {error && <p className='form-error'>{error}</p>}{closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
        <footer><button type='button' className='button-secondary' onClick={() => { setView('settings'); setError('') }}>返回设置</button><button type='button' className='button-primary' onClick={onClose}>完成</button></footer>
      </section>
    </div>
  }

  return <div className='modal-backdrop' role='presentation'
    onMouseDown={(event) => { if (event.target === event.currentTarget) armBackdropClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}>
    <form className='rules-dialog llm-review-dialog' role='dialog' aria-modal='true' aria-labelledby='llm-review-title' onMouseDown={resetBackdropClose} onSubmit={(event) => { void save(event) }}>
      <header><div><span className='eyebrow'>SECURITY REVIEW</span><h2 id='llm-review-title'>审核器设置</h2></div><span className={'llm-review-state ' + (settings.enabled ? 'enabled' : '')}><i />{settings.enabled ? '审核器已启用' : '审核器已关闭'}</span></header>
      <div className='llm-review-scroll'>
      <p className='rules-help'>为“Agent 审核”模式配置审核器。命中高危规则的请求交给审核器判断，其余请求直接批准。未获批准的请求会被拒绝，并通知 Agent 修改，不会等待人工处理。</p>
      <fieldset className='llm-settings-fields' disabled={busy || modelsLoading || testing}>

      <label className='launcher-config-toggle'><span><strong>启用审核器</strong><small>配置并启用后，在 Agent 窗口中切换为“Agent 审核”模式。</small></span><input type='checkbox' role='switch' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <section className='reviewer-pool' aria-label='审核器列表'>
        <div className='reviewer-pool-toolbar'><strong>按顺序尝试审核服务</strong><button type='button' className='button-secondary' onClick={addReviewer}>添加审核器</button><button type='button' className='button-secondary' onClick={() => setImportOpen(value => !value)}>从 CC Switch 导入</button></div>
        <p>按列表顺序使用已启用的审核器。服务连接失败、超时或返回无法识别的结果时，尝试下一项；审核器明确拒绝或无法确认安全时，拒绝请求。</p>
        <p>添加或导入后，选择模型、测试连接，再勾选该审核器并保存。</p>
        {poolActive && <ol>{draftPool().map((entry, index) => <li key={entry.id} className={entry.id === selectedId ? 'selected' : ''}>
          <input type='checkbox' aria-label={`启用 ${entry.name}`} checked={entry.enabled} onChange={event => setReviewers(current => current.map(item => item.id === entry.id ? { ...item, enabled: event.target.checked } : item))} />
          <button type='button' className='reviewer-pool-select' aria-pressed={entry.id === selectedId} onClick={() => selectReviewer(entry.id)}>{index + 1}. {entry.name}<small>{entry.backend === 'api' ? '模型 API' : entry.backend === 'codex-cli' ? 'Codex' : 'Claude Code'}</small></button>
          <button type='button' aria-label={`上移 ${entry.name}`} disabled={index === 0} onClick={() => moveReviewer(entry.id, -1)}>↑</button>
          <button type='button' aria-label={`下移 ${entry.name}`} disabled={index === reviewers.length - 1} onClick={() => moveReviewer(entry.id, 1)}>↓</button>
          <button type='button' aria-label={`移除 ${entry.name}`} onClick={() => removeReviewer(entry.id)}>移除</button>
        </li>)}</ol>}
        <AnimatedCollapse open={importOpen}><div className='reviewer-pool-import'>
          <label>CC Switch 类型<select className='launcher-field' value={importKind} onChange={event => setImportKind(event.target.value as 'codex' | 'claude')}><option value='codex'>Codex</option><option value='claude'>Claude</option></select></label>
          <CCSwitchProviderList providers={providers} selectedId={providerId} loading={providersLoading} error={providerError} disabled={busy} onSelect={provider => setProviderId(provider.id)} onRefresh={() => { void refreshProviders() }} />
          <p>导入服务地址和 API Key 后，点击“获取模型”选择审核模型，再启用并保存。</p>
          <button type='button' className='button-secondary' disabled={!providerId || providersLoading} onClick={() => { void importReviewer() }}>导入所选配置</button>
        </div></AnimatedCollapse>
        {poolActive && reviewers.length > 0 && <label>审核器名称<input className='launcher-field' value={reviewers.find(entry => entry.id === selectedId)?.name ?? ''} onChange={event => setReviewers(current => current.map(entry => entry.id === selectedId ? { ...entry, name: event.target.value } : entry))} /></label>}
        {poolActive && !reviewers.length && <p>尚未配置审核服务，请添加审核器或从 CC Switch 导入。</p>}
      </section>
      {(!poolActive || reviewers.length > 0) && <>
      <label>审核方式<select className='launcher-field' aria-label='审核方式' value={settings.backend ?? 'api'} onChange={event => setSettings(current => ({ ...current, backend: event.target.value as LlmReviewSettingsSummary['backend'] }))}>
        <option value='api'>独立模型 API</option><option value='codex-cli'>Codex 审核 Agent</option><option value='claude-cli'>Claude 审核 Agent</option>
      </select></label>
      {(settings.backend ?? 'api') === 'api' ? <div className='llm-review-fields'>
        <label>API 协议<select className='launcher-field' value={settings.protocol ?? 'openai-chat'} onChange={event => setSettings(current => ({ ...current, protocol: event.target.value as LlmReviewSettingsSummary['protocol'] }))}><option value='openai-chat'>OpenAI Chat Completions</option><option value='openai-responses'>OpenAI Responses</option><option value='anthropic-messages'>Anthropic Messages</option></select></label>
        {settings.protocol === 'anthropic-messages' && <label>Anthropic 身份验证<select className='launcher-field' value={settings.anthropicAuth ?? 'api-key'} onChange={event => setSettings(current => ({ ...current, anthropicAuth: event.target.value as 'api-key' | 'bearer' }))}><option value='api-key'>API Key（x-api-key）</option><option value='bearer'>Bearer Token</option></select></label>}
        <label>服务地址（Base URL）<input className='launcher-field' value={settings.baseUrl ?? ''} onChange={event => setSettings(current => ({ ...current, baseUrl: event.target.value }))} placeholder='https://api.example.com/v1' /></label>
        <label>API Key<input className='launcher-field' type='password' autoComplete='off' disabled={clearApiKey} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? '已安全保存，留空保持不变' : '请输入 API Key'} /></label>
        {settings.hasApiKey && !clearApiKey && !apiKey && <p role='status'>API Key 已安全保存，无需重新填写。</p>}
        {settings.hasApiKey && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearApiKey} onChange={event => setClearApiKey(event.target.checked)} />清除已保存的 API Key</label>}
        <div className='llm-model-picker'><label>审核模型{manualModel
          ? <input className='launcher-field' value={settings.model ?? ''} onChange={event => setSettings(current => ({ ...current, model: event.target.value }))} />
          : <select className='launcher-field' value={settings.model ?? ''} onChange={event => setSettings(current => ({ ...current, model: event.target.value }))}>
            <option value=''>获取模型后选择</option>
            {settings.model && !models.includes(settings.model) && <option value={settings.model}>{settings.model}</option>}
            {models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>}</label>
          <button type='button' className='button-secondary' onClick={() => { void loadModels() }}>{modelsLoading ? '获取中…' : '获取模型'}</button>
          <button type='button' className='button-secondary' onClick={() => setManualModel(value => !value)}>{manualModel ? '从列表选择' : '手动输入模型'}</button>
          {modelMessage && <p role='status'>{modelMessage}</p>}
        </div>
      </div> : <div className='llm-review-fields'>
        <label>程序路径（可选）<input className='launcher-field' value={settings.cliExecutable ?? ''} onChange={event => setSettings(current => ({ ...current, cliExecutable: event.target.value }))} placeholder='留空自动查找本机 Codex / Claude' /></label>
        <label>审核模型（可选）<input className='launcher-field' value={settings.cliModel ?? ''} onChange={event => setSettings(current => ({ ...current, cliModel: event.target.value }))} placeholder='留空使用 CLI 配置的模型' /></label>
        <p>使用本机 Codex／Claude 的登录和服务商设置。审核时可以查看项目文件，但不会执行正在审核的命令。</p>
      </div>}
      <div className='reviewer-pool-test'><button type='button' className='button-secondary' onClick={() => { void testConnection() }}>{testing ? '测试中…' : '测试连接'}</button>{(settings.backend ?? 'api') !== 'api' && modelMessage && <p role='status'>{modelMessage}</p>}</div>
      </>}
      <label>单次审核超时（秒）<input className='launcher-field' type='number' min={5} max={600} value={settings.timeoutSeconds} onChange={event => setSettings(current => ({ ...current, timeoutSeconds: Number(event.target.value) }))} /></label>
      <label>整体审核时限（秒）<input className='launcher-field' type='number' min={5} max={600} value={settings.overallTimeoutSeconds ?? 120} onChange={event => setSettings(current => ({ ...current, overallTimeoutSeconds: Number(event.target.value) }))} /></label>
      <label>单个 API 审核器失败重试次数<input className='launcher-field' type='number' min={0} max={10} disabled={poolActive && reviewers.filter(entry => entry.enabled).length > 1} value={settings.retryCount} onChange={event => setSettings(current => ({ ...current, retryCount: Number(event.target.value) }))} /></label>
      <p className='reviewer-deadline-help'>只启用一个 API 审核器时，服务故障按上述次数重试；启用多个时，改为尝试下一项。</p>
      <p className='reviewer-deadline-help'>整体时限是一次审批最多允许等待的时间，包含排队和重试。超过时限仍未获批准，就拒绝请求。</p>

      <label className='launcher-config-toggle llm-schedule-toggle'><span><strong>定时检查批准规则</strong><small>审查只报告问题，不会自动删除或修改规则。</small></span><input type='checkbox' role='switch' checked={settings.scheduledRuleAuditEnabled} onChange={(event) => setSettings((current) => ({ ...current, scheduledRuleAuditEnabled: event.target.checked }))} /></label>
      <label className='llm-audit-interval'>审查周期（小时）<input className='launcher-field' type='number' min={1} max={720} disabled={!settings.scheduledRuleAuditEnabled} value={settings.scheduledRuleAuditHours} onChange={(event) => setSettings((current) => ({ ...current, scheduledRuleAuditHours: Number(event.target.value) }))} /></label>

      <label className='launcher-config-toggle'><span><strong>模型 API 使用 HTTP 代理</strong><small>审核 API 请求通过下方代理连接。</small></span><input type='checkbox' role='switch' checked={settings.proxyEnabled} onChange={(event) => setSettings((current) => ({ ...current, proxyEnabled: event.target.checked }))} /></label>
      <div className={'llm-proxy-fields' + (settings.proxyEnabled ? '' : ' disabled')}><label>主机<input className='launcher-field' disabled={!settings.proxyEnabled} value={settings.proxyHost} onChange={(event) => setSettings((current) => ({ ...current, proxyHost: event.target.value }))} /></label><label>端口<input className='launcher-field' disabled={!settings.proxyEnabled} type='number' min={1} max={65535} value={settings.proxyPort} onChange={(event) => setSettings((current) => ({ ...current, proxyPort: Number(event.target.value) }))} /></label><label>用户名（可选）<input className='launcher-field' disabled={!settings.proxyEnabled} value={settings.proxyUsername ?? ''} onChange={(event) => setSettings((current) => ({ ...current, proxyUsername: event.target.value }))} /></label><label>密码（可选）<input className='launcher-field' disabled={!settings.proxyEnabled || clearProxyPassword} type='password' value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder={settings.hasProxyPassword ? '已安全保存' : ''} /></label></div>
      {settings.hasProxyPassword && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearProxyPassword} onChange={(event) => setClearProxyPassword(event.target.checked)} />清除已保存的代理密码</label>}

      <section className='llm-rule-audit-panel'><div><strong>批准规则检查</strong><span>{settings.ruleAuditState.status === 'running' ? `后台运行中${settings.ruleAuditState.startedAt ? ' · ' + auditTime(settings.ruleAuditState.startedAt) : ''}` : auditResult ? `${auditTime(auditResult.reviewedAt)} · ${auditResult.findings.length} 项问题` : '尚未审查'}</span></div><div className='llm-rule-audit-actions'><button type='button' className='button-secondary' disabled={busy || settings.ruleAuditState.status === 'running'} onClick={() => { void runAudit() }}>{settings.ruleAuditState.status === 'running' ? '后台审查中…' : '保存并立即审查'}</button><button type='button' className='button-secondary' disabled={!auditResult && settings.ruleAuditState.status === 'idle'} onClick={() => { void openResults() }}>查看审查结果</button></div>
        {settings.ruleAuditState.status === 'running' && <div className='llm-audit-progress' role='status'><i /><span><strong>审查正在后台进行</strong><small>可以关闭设置，稍后从“查看审查结果”查看。</small></span></div>}
        {settings.ruleAuditState.status === 'failed' && <div className='llm-audit-progress failed' role='alert'><i /><span><strong>最近一次审查失败</strong><small>{settings.ruleAuditState.error ?? '未记录具体错误'}</small></span></div>}
        {auditResult && <p>{auditResult.summary}</p>}
      </section>

      </fieldset>
      </div>
      <div className='llm-review-save-status' aria-live='polite'>
      {error && <p className='form-error'>{error}</p>}{closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      </div>
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy || modelsLoading || testing || !apiAvailable}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
