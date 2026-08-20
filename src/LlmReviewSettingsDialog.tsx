import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { LlmReviewSettingsSummary, LlmRuleAuditFinding, LlmRuleAuditResult } from './shared/manager-api'

const DEFAULTS: LlmReviewSettingsSummary = {
  enabled: false,
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
  const [apiKey, setApiKey] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [clearProxyPassword, setClearProxyPassword] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
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

  useEffect(() => {
    if (!apiAvailable) { setBusy(false); setError('LLM 审查需要重启 Manager 后启用'); return }
    void window.agentManager.getLlmReviewSettings().then((value) => {
      setSettings(value)
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

  const armBackdropClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }

  const resetBackdropClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      if (!apiAvailable) throw new Error('LLM 审查需要重启 Manager 后启用')
      const saved = await window.agentManager.updateLlmReviewSettings({
        enabled: settings.enabled,
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
      setSettings(saved); setApiKey(''); setProxyPassword(''); setClearApiKey(false); setClearProxyPassword(false)
      setAuditResult(saved.lastRuleAudit)
    } catch (reason) { setError(readableError(reason)) } finally { setBusy(false) }
  }

  const runAudit = async (): Promise<void> => {
    setError('')
    try {
      if (!apiAvailable) throw new Error('LLM 审查需要重启 Manager 后启用')
      const state = await window.agentManager.reviewApprovalRules()
      setSettings((current) => ({ ...current, ruleAuditState: state }))
    } catch (reason) { setError(readableError(reason)) }
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

        {!auditResult ? <div className='llm-audit-result-empty'><strong>还没有可查看的审查结果</strong><span>返回设置并启动一次规则集合审查。</span></div> : <>
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
      <header><div><span className='eyebrow'>SECURITY REVIEW</span><h2 id='llm-review-title'>LLM 安全审查</h2></div><span className={'llm-review-state ' + (settings.enabled ? 'enabled' : '')}><i />{settings.enabled ? '运行时已启用' : '运行时已关闭'}</span></header>
      <p className='rules-help'>LLM 只辅助判断普通请求，不能覆盖内置或自定义高危规则。请求失败、格式错误和不确定结论都会进入处理中心。</p>

      <label className='launcher-config-toggle'><span><strong>启用运行时审查</strong><small>仅在 Agent 开启全自动模式时生效。</small></span><input type='checkbox' role='switch' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <fieldset className='llm-review-levels'><legend>审查等级</legend>
        <label className={settings.level === 'low' ? 'active' : ''}><input type='radio' name='review-level' value='low' checked={settings.level === 'low'} onChange={() => setSettings((current) => ({ ...current, level: 'low' }))} /><span><strong>低</strong><small>仅命中高危规则时审查；硬规则仍转人工。</small></span></label>
        <label className={settings.level === 'medium' ? 'active' : ''}><input type='radio' name='review-level' value='medium' checked={settings.level === 'medium'} onChange={() => setSettings((current) => ({ ...current, level: 'medium' }))} /><span><strong>中</strong><small>所有写入、删除和高危命中都审查。</small></span></label>
        <label className={settings.level === 'high' ? 'active' : ''}><input type='radio' name='review-level' value='high' checked={settings.level === 'high'} onChange={() => setSettings((current) => ({ ...current, level: 'high' }))} /><span><strong>高</strong><small>所有未命中确定性安全规则的请求都审查。</small></span></label>
      </fieldset>

      <div className='llm-review-fields'>
        <label>Base URL<input className='launcher-field' value={settings.baseUrl ?? ''} onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))} placeholder='https://api.example.com/v1' /></label>
        <label>API Key<input className='launcher-field' type='password' autoComplete='off' disabled={clearApiKey} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? '已安全保存，留空保持不变' : '请输入 API Key'} /></label>
        {settings.hasApiKey && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />清除已保存的 API Key</label>}
        <label>Model<input className='launcher-field' value={settings.model ?? ''} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} /></label>
        <label>失败重试次数<input className='launcher-field' type='number' min={0} max={10} value={settings.retryCount} onChange={(event) => setSettings((current) => ({ ...current, retryCount: Number(event.target.value) }))} /><small>只重试网络错误、超时、限流和服务端错误。</small></label>
        <label>单次请求超时（秒）<input className='launcher-field' type='number' min={5} max={600} value={settings.timeoutSeconds} onChange={(event) => setSettings((current) => ({ ...current, timeoutSeconds: Number(event.target.value) }))} /><small>默认 30 秒；运行时审批和规则集合审查共同使用，范围 5–600 秒。</small></label>
      </div>

      <label className='launcher-config-toggle llm-schedule-toggle'><span><strong>定时审查批准规则集合</strong><small>审查只报告问题，不会自动删除或修改规则。</small></span><input type='checkbox' role='switch' checked={settings.scheduledRuleAuditEnabled} onChange={(event) => setSettings((current) => ({ ...current, scheduledRuleAuditEnabled: event.target.checked }))} /></label>
      <label className='llm-audit-interval'>审查周期（小时）<input className='launcher-field' type='number' min={1} max={720} disabled={!settings.scheduledRuleAuditEnabled} value={settings.scheduledRuleAuditHours} onChange={(event) => setSettings((current) => ({ ...current, scheduledRuleAuditHours: Number(event.target.value) }))} /></label>

      <label className='launcher-config-toggle'><span><strong>使用 HTTP 代理</strong><small>仅用于 LLM 审查请求，默认 127.0.0.1:7897。</small></span><input type='checkbox' role='switch' checked={settings.proxyEnabled} onChange={(event) => setSettings((current) => ({ ...current, proxyEnabled: event.target.checked }))} /></label>
      <div className={'llm-proxy-fields' + (settings.proxyEnabled ? '' : ' disabled')}><label>主机<input className='launcher-field' disabled={!settings.proxyEnabled} value={settings.proxyHost} onChange={(event) => setSettings((current) => ({ ...current, proxyHost: event.target.value }))} /></label><label>端口<input className='launcher-field' disabled={!settings.proxyEnabled} type='number' min={1} max={65535} value={settings.proxyPort} onChange={(event) => setSettings((current) => ({ ...current, proxyPort: Number(event.target.value) }))} /></label><label>用户名（可选）<input className='launcher-field' disabled={!settings.proxyEnabled} value={settings.proxyUsername ?? ''} onChange={(event) => setSettings((current) => ({ ...current, proxyUsername: event.target.value }))} /></label><label>密码（可选）<input className='launcher-field' disabled={!settings.proxyEnabled || clearProxyPassword} type='password' value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder={settings.hasProxyPassword ? '已安全保存' : ''} /></label></div>
      {settings.hasProxyPassword && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearProxyPassword} onChange={(event) => setClearProxyPassword(event.target.checked)} />清除已保存的代理密码</label>}

      <section className='llm-rule-audit-panel'><div><strong>批准规则集合审查</strong><span>{settings.ruleAuditState.status === 'running' ? `后台运行中${settings.ruleAuditState.startedAt ? ' · ' + auditTime(settings.ruleAuditState.startedAt) : ''}` : auditResult ? `${auditTime(auditResult.reviewedAt)} · ${auditResult.findings.length} 项问题` : '尚未审查'}</span></div><div className='llm-rule-audit-actions'><button type='button' className='button-secondary' disabled={busy || settings.ruleAuditState.status === 'running'} onClick={() => { void runAudit() }}>{settings.ruleAuditState.status === 'running' ? '后台审查中…' : '立即审查'}</button><button type='button' className='button-secondary' disabled={!auditResult && settings.ruleAuditState.status === 'idle'} onClick={() => { void openResults() }}>查看审查结果</button></div>
        {settings.ruleAuditState.status === 'running' && <div className='llm-audit-progress' role='status'><i /><span><strong>审查正在后台进行</strong><small>可以关闭此抽屉；重新打开后仍会显示进度和最终结果。</small></span></div>}
        {settings.ruleAuditState.status === 'failed' && <div className='llm-audit-progress failed' role='alert'><i /><span><strong>最近一次审查失败</strong><small>{settings.ruleAuditState.error ?? '未记录具体错误'}</small></span></div>}
        {auditResult && <p>{auditResult.summary}</p>}
      </section>

      <div className='launcher-config-security'><strong>不可绕过的边界</strong><span>递归删除、提权、下载执行、敏感文件覆盖、系统破坏和本机高危规则命中始终需要人工确认。</span></div>
      <div className='launcher-config-security'><strong>凭据保护</strong><span>API Key 和代理密码使用 Electron 安全存储加密，不返回页面、不写入审计。</span></div>
      {error && <p className='form-error'>{error}</p>}{closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy || !apiAvailable}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
