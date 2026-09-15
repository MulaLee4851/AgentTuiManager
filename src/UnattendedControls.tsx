import { useState } from 'react'
import type { SessionSummary } from './shared/manager-api'
import { normalizeUnattendedEndWords } from './shared/unattended-settings'

export default function UnattendedControls({ session, onChanged }: { session: SessionSummary; onChanged: () => void }): JSX.Element | null {
  const [endWordsText, setEndWordsText] = useState((session.unattended?.endWords ?? [session.unattended?.endWord ?? 'TASK-DONE']).join('\n'))
  const [recoveryEndWord, setRecoveryEndWord] = useState(session.unattended?.recoveryEndWord ?? session.unattended?.endWords?.[0] ?? session.unattended?.endWord ?? 'TASK-DONE')
  const [recoveryWord, setRecoveryWord] = useState(session.unattended?.recoveryWord ?? 'continue')
  const [enterDelay, setEnterDelay] = useState(session.unattended?.approvalEnterDelaySeconds ?? 5)
  const [enterCount, setEnterCount] = useState(session.unattended?.approvalEnterCount ?? 1)
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
      const settings = { enabled: saveOnly ? false : !active, endWord: endWords?.[0] ?? session.unattended?.endWord, endWords, recoveryEndWord: selectedEndWord, recoveryWord, approvalEnterDelaySeconds: enterDelay, approvalEnterCount: enterCount }
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
    <p>仅作用于此窗口。包括删除、提权等高风险请求在内，全部自动批准，不受普通全自动风险规则限制。</p>
    <label>Agent 结束词（每行一个）<textarea aria-label='Agent 结束词' rows={4} value={endWordsText} maxLength={2020} disabled={active || busy} onChange={event => setEndWordsText(event.target.value)} /></label>
    <p>支持 1～20 个结束词，自动去重；每个不含空白、不超过 100 字符，总长不超过 1000 字符。命中任意一个即停止无监管。</p>
    <label>拼接到恢复提示的结束词<select aria-label='拼接到恢复提示的结束词' value={selectedEndWord} disabled={active || busy || !options.length} onChange={event => setRecoveryEndWord(event.target.value)}>
      {!options.length && <option value=''>请先填写结束词</option>}
      {options.map(word => <option key={word} value={word}>{word}</option>)}
    </select></label>
    <label>Agent 恢复词<input aria-label='Agent 恢复词' value={recoveryWord} maxLength={2000} disabled={active || busy} onChange={event => setRecoveryWord(event.target.value)} /></label>
    <p>只拼接上面选中的一个词：如果没有剩余任务，仅输出 {selectedEndWord || '选中的结束词'}，不要输出其他内容。其他结束词仍可用于识别完成。</p>
    <p>待命持续 5 秒且未完成时发送恢复提示。仅匹配 Agent 自己的完整回复；恢复消息、用户输入和终端回显中的结束词不会触发停止。待审批时只批准，不发恢复词。</p>
    <p>阶段性完成但没有结束词时继续任务；网络或模型连续异常按 30 秒至 5 分钟退避恢复，不因重试耗尽关闭。恢复消息不等待接收回执。连续退出先冷却再恢复原生会话，不另开新会话。</p>
    <p>手动停止、Esc / Ctrl+C 会关闭无监管。缺少原生会话、终端连接无响应或提交状态不安全时仍需人工处理。保存的配置会保留；Manager 重启后需重新开启无监管。</p>
    <label>审批后补按 Enter 延迟（秒）<input type='number' aria-label='审批后补按 Enter 延迟（秒）' min={0} max={60} step={1} value={enterDelay} disabled={active || busy} onChange={event => setEnterDelay(event.target.valueAsNumber)} /></label>
    <label>Enter 发送次数<input type='number' aria-label='Enter 发送次数' min={1} max={20} step={1} value={enterCount} disabled={active || busy} onChange={event => { setEnterCount(event.target.valueAsNumber); setSaved(false) }} /></label>
    <p>临时兼容：延迟 1～60 秒后补按 Enter，0 为关闭。按指定次数发送（1～20 次），每次间隔至少 1 秒。不判断终端是否仍待审批，可能确认其他提示，请按需启用。补按期间不发恢复词；手动输入、停止、重启或命中结束词会取消剩余补按。</p>
    {session.unattended?.reason && <p role='status'>{session.unattended.reason}</p>}
    {!active && <label className='full-auto-confirm'><input type='checkbox' checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认允许此窗口自动执行全部高风险操作，并自动恢复任务</label>}
    {error && <p className='form-error' role='alert'>{error}</p>}
    {saved && <p role='status'>配置已保存，未开启无监管。关闭再打开设置仍会保留。</p>}
    {!active && <button type='button' className='button-secondary' disabled={busy} onClick={() => { void submit(true) }}>保存配置</button>}
    <button type='button' className={active ? 'button-secondary' : 'button-danger'} disabled={busy || (!active && (!confirmed || !endWordsText.trim() || !recoveryWord.trim()))} onClick={() => { void submit() }}>{busy ? '请稍后…' : active ? '停止无监管模式' : '开启无监管模式'}</button>
  </section>
}
