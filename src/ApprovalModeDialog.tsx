import { useState } from 'react'
import type { ApprovalMode, SessionSummary } from './shared/manager-api'
import { APPROVAL_MODES, APPROVAL_MODE_LABEL, approvalModeOf } from './shared/approval-mode'
import UnattendedControls from './UnattendedControls'

const DESCRIPTION: Record<ApprovalMode, string> = {
  manual: '每个审批请求都由你手动批准或拒绝。',
  'agent-review': '普通请求直接批准；命中高危规则时，交给独立审核器决定批准或拒绝。',
  'rules-auto': '普通请求直接批准；命中高危规则时直接拒绝，不调用模型。',
  unattended: '全部请求自动批准，包括高危操作，并按配置自动续跑和恢复任务。',
}

export default function ApprovalModeDialog({ session, onClose, onChanged, onConfigureReviewer }: {
  session: SessionSummary
  onClose: () => void
  onChanged: () => void
  onConfigureReviewer?: () => void
}): JSX.Element {
  const active = approvalModeOf(session)
  const [selected, setSelected] = useState<ApprovalMode>(active)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const apply = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (!window.agentManager.setApprovalMode) throw new Error('请重启新版 Manager 后切换审批模式')
      await window.agentManager.setApprovalMode(session.sessionId, selected)
      onChanged(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className='modal-backdrop full-auto-backdrop' role='presentation'>
    <section className='full-auto-dialog approval-mode-dialog' role='dialog' aria-modal='true' aria-labelledby='approval-mode-title'>
      <header><div><p className='detail-kicker'>当前：{APPROVAL_MODE_LABEL[active]}</p><h2 id='approval-mode-title'>切换审批模式</h2></div></header>
      <div className='full-auto-dialog-body'>
        <p>仅对 <strong>{session.displayName}</strong> 生效。切换后，尚未处理的请求按新模式判断。</p>
        <fieldset className='approval-mode-options'><legend>审批模式</legend>
          {APPROVAL_MODES.map(mode => <label key={mode} className={selected === mode ? 'selected' : ''}>
            <input type='radio' name='session-approval-mode' value={mode} checked={selected === mode} disabled={busy || mode === 'unattended' && !['codex', 'claude'].includes(session.agentKind)} onChange={() => setSelected(mode)} />
            <span><strong>{APPROVAL_MODE_LABEL[mode]}</strong><small>{DESCRIPTION[mode]}</small></span>
          </label>)}
        </fieldset>
        {selected === 'agent-review' && <div className='full-auto-safe-note'>
          <p>先配置审核器，可使用模型 API 或本机 Codex／Claude。审核未获批准时，会拒绝请求并通知 Agent 修改，不会等待你手动审核。</p>
          {onConfigureReviewer && <button type='button' className='button-secondary' onClick={onConfigureReviewer}>配置审核器</button>}
        </div>}
        {selected === 'unattended' && <UnattendedControls session={session} onChanged={onChanged} />}
        {error && <p className='form-error' role='alert'>{error}</p>}
      </div>
      <footer><button type='button' className='button-secondary' disabled={busy} onClick={onClose}>关闭</button>
        {selected !== 'unattended' && <button type='button' className='button-primary' disabled={busy || selected === active} onClick={() => { void apply() }}>{busy ? '切换中…' : '切换为' + APPROVAL_MODE_LABEL[selected]}</button>}
      </footer>
    </section>
  </div>
}
