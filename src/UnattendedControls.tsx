import { useState } from 'react'
import type { SessionSummary } from './shared/manager-api'
import { normalizeUnattendedEndWords } from './shared/unattended-settings'

export default function UnattendedControls({ session, onChanged }: { session: SessionSummary; onChanged: () => void }): JSX.Element | null {
  const [endWordsText, setEndWordsText] = useState((session.unattended?.endWords ?? [session.unattended?.endWord ?? 'TASK-DONE']).join('\n'))
  const [recoveryEndWord, setRecoveryEndWord] = useState(session.unattended?.recoveryEndWord ?? session.unattended?.endWords?.[0] ?? session.unattended?.endWord ?? 'TASK-DONE')
  const [recoveryWord, setRecoveryWord] = useState(session.unattended?.recoveryWord ?? 'continue')
  const [enterDelay, setEnterDelay] = useState(session.unattended?.approvalEnterDelaySeconds ?? 5)
  const [enterCount, setEnterCount] = useState(session.unattended?.approvalEnterCount ?? 1)
  const [errorAttempts, setErrorAttempts] = useState(session.unattended?.errorRecoveryAttempts ?? 3)
  const [errorCooldown, setErrorCooldown] = useState(session.unattended?.errorRecoveryCooldownMinutes ?? 1)
  const [saved, setSaved] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = [...new Set(endWordsText.split(/\r?\n/).map(word => word.trim()).filter(Boolean))]
  const selectedEndWord = options.includes(recoveryEndWord) ? recoveryEndWord : options[0] ?? ''
  if (!['codex', 'claude'].includes(session.agentKind)) return null
  const active = session.unattended?.enabled === true
  const submit = async (saveOnly = false) => {
    setBusy(true); setError(''); setSaved(false)
    try {
      if (!window.agentManager.setUnattendedMode) throw new Error('请重启新版 Manager 后使用无监管模式')
      const endWords = active ? session.unattended?.endWords : normalizeUnattendedEndWords({ endWords: endWordsText.split(/\r?\n/) })
      const settings = { enabled: saveOnly ? false : !active, endWord: endWords?.[0] ?? session.unattended?.endWord, endWords, recoveryEndWord: selectedEndWord, recoveryWord, approvalEnterDelaySeconds: enterDelay, approvalEnterCount: enterCount, errorRecoveryAttempts: errorAttempts, errorRecoveryCooldownMinutes: errorCooldown }
      if (saveOnly) {
        if (!window.agentManager.saveUnattendedSettings) throw new Error('请重启新版 Manager 后保存配置')
        await window.agentManager.saveUnattendedSettings(session.sessionId, settings)
        setSaved(true)
      } else await window.agentManager.setUnattendedMode(session.sessionId, settings)
      setConfirmed(false)
      onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className='unattended-settings' aria-label='无监管模式'>
    <h3>{active ? '无监管运行中' : '无监管模式（可选）'}</h3>
    <p>仅对当前 Agent 生效。所有请求都会自动批准，包括删除、提权等高风险操作，不经过规则或审核器检查。</p>
    <label>Agent 结束词（每行一个）<textarea aria-label='Agent 结束词' rows={4} value={endWordsText} maxLength={2020} disabled={active || busy} onChange={event => setEndWordsText(event.target.value)} /></label>
    <p>支持 1～20 个结束词，自动去重；每个不含空白、不超过 100 字符，总长不超过 1000 字符。命中任意一个即停止无监管。</p>
    <label>继续提示中使用的结束词<select aria-label='继续提示中使用的结束词' value={selectedEndWord} disabled={active || busy || !options.length} onChange={event => setRecoveryEndWord(event.target.value)}>
      {!options.length && <option value=''>请先填写结束词</option>}
      {options.map(word => <option key={word} value={word}>{word}</option>)}
    </select></label>
    <label>Agent 恢复词<input aria-label='Agent 恢复词' value={recoveryWord} maxLength={2000} disabled={active || busy} onChange={event => setRecoveryWord(event.target.value)} /></label>
    <p>继续提示会要求 Agent：如果没有剩余任务，仅输出 {selectedEndWord || '选中的结束词'}，不要输出其他内容。其他结束词仍可用于识别完成。</p>
    <p>Agent 停止工作 5 秒后自动发送继续提示。只有 Agent 回复中的结束词会停止无监管，你输入的结束词不会触发。等待审批时先处理审批。</p>
    <p>Agent 完成一部分任务但未回复结束词时，会继续执行。异常退出后尝试恢复原会话。</p>
    <label>异常恢复尝试次数<input type='number' aria-label='异常恢复尝试次数' min={1} max={100} step={1} value={errorAttempts} disabled={active || busy} onChange={event => { setErrorAttempts(event.target.valueAsNumber); setSaved(false) }} /></label>
    <label>每轮重试间隔（分钟）<input type='number' aria-label='每轮重试间隔（分钟）' min={1} max={1440} step={1} value={errorCooldown} disabled={active || busy} onChange={event => { setErrorCooldown(event.target.valueAsNumber); setSaved(false) }} /></label>
    <p>网络或模型出错时，每轮按上述次数重试，至少间隔 10 秒；一轮结束后等待指定分钟数，再开始下一轮。Agent 正在运行、等待审批或有未发送的输入时，不发送继续提示。</p>
    <p>手动停止或按 Esc／Ctrl+C 会关闭无监管。无法恢复原会话或终端失去响应时会提示原因。重启 Manager 后需重新开启，已保存的设置会保留。</p>
    <label>审批后补按 Enter 延迟（秒）<input type='number' aria-label='审批后补按 Enter 延迟（秒）' min={0} max={60} step={1} value={enterDelay} disabled={active || busy} onChange={event => setEnterDelay(event.target.valueAsNumber)} /></label>
    <label>Enter 发送次数<input type='number' aria-label='Enter 发送次数' min={1} max={20} step={1} value={enterCount} disabled={active || busy} onChange={event => { setEnterCount(event.target.valueAsNumber); setSaved(false) }} /></label>
    <p>用于已批准但终端仍等待确认的情况。延迟设为 0 可关闭；开启后按指定次数补按 Enter，每次至少间隔 1 秒。补按可能确认其他提示，请谨慎开启。手动输入或停止任务会取消后续补按。</p>
    {session.unattended?.reason && <p role='status'>{session.unattended.reason}</p>}
    {!active && <label className='full-auto-confirm'><input type='checkbox' checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认允许此窗口自动执行全部高风险操作，并自动恢复任务</label>}
    {error && <p className='form-error' role='alert'>{error}</p>}
    {saved && <p role='status'>配置已保存。点击“开启无监管模式”后开始使用。</p>}
    {!active && <button type='button' className='button-secondary' disabled={busy} onClick={() => { void submit(true) }}>保存配置</button>}
    <button type='button' className={active ? 'button-secondary' : 'button-danger'} disabled={busy || (!active && (!confirmed || !endWordsText.trim() || !recoveryWord.trim()))} onClick={() => { void submit() }}>{busy ? '请稍后…' : active ? '停止无监管模式' : '开启无监管模式'}</button>
  </section>
}
