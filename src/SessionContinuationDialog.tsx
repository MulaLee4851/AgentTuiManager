import { useState } from 'react'
import type { SessionSummary } from './shared/manager-api'

export default function SessionContinuationDialog({ source, onClose, onCreated, onRemoved }: {
  source: SessionSummary; onClose: () => void
  onCreated: (session: SessionSummary) => void; onRemoved: () => void
}): JSX.Element {
  const [created, setCreated] = useState<SessionSummary>()
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')
  const create = async () => {
    setBusy(true); setError('')
    try {
      if (!window.agentManager.createContinuation) throw new Error('此功能需要重启 Manager 后启用')
      const result = await window.agentManager.createContinuation(source.sessionId)
      setCreated(result.session); setWarning(result.warning ?? ''); onCreated(result.session)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const removeOld = async () => {
    if (!created || warning) return
    setBusy(true); setError('')
    try {
      const sessions = await window.agentManager.listSessions()
      const current = sessions.find(item => item.sessionId === source.sessionId)
      if (current) {
        if (!['stopped', 'completed', 'failed'].includes(current.status)) await window.agentManager.stopSession(source.sessionId)
        await window.agentManager.removeSession(source.sessionId)
      }
      onRemoved(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  if (created) return <div className='modal-backdrop continuation-confirm-backdrop' role='presentation' onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
    <section className='continuation-confirm-dialog' role='dialog' aria-modal='true' aria-labelledby='continuation-confirm-heading'>
      <header><div><p className='detail-kicker read'>新窗口已创建</p><h2 id='continuation-confirm-heading'>是否移除旧窗口？</h2></div></header>
      <div className='continuation-confirm-body'>
        <p><strong>{created.displayName}</strong> 已启动，并已收到读取旧会话、继续任务的提示。</p>
        <p>是否从 Agent TUI Manager 移除旧窗口「{source.displayName}」？</p>
        <p className='continuation-confirm-note'>移除会停止旧 Agent，并从列表中移除该窗口。历史对话和工作区文件仍会保留。</p>
        {warning && <p className='continuation-confirm-error' role='alert'>{warning}</p>}
        {error && <p className='continuation-confirm-error' role='alert'>{error}</p>}
      </div>
      <footer><span>{busy ? '请稍后…' : '默认保留旧窗口和所有原生历史'}</span><button className='button-secondary' type='button' disabled={busy} onClick={onClose}>保留旧窗口</button><button className='button-danger' type='button' disabled={busy || Boolean(warning)} onClick={() => void removeOld()}>仅从 Manager 移除旧窗口</button></footer>
    </section>
  </div>
  return <div className='launcher-scrim' role='presentation' onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
    <section className='agent-launcher session-continuation-dialog' role='dialog' aria-modal='true' aria-labelledby='continuation-heading'>
      <header className='launcher-head'><h1 id='continuation-heading'>新窗口清洗续写</h1><button className='icon-button' type='button' disabled={busy} aria-label='关闭续写窗口' onClick={onClose}>×</button></header>
      <div className='launcher-content'><section className='launcher-panel'>
        <div className='launcher-config-intro'><strong>{source.displayName}</strong><span>{source.workspace}</span></div>
        <>
          <p>新建会话，并提示 Agent：请读取 {source.nativeSessionId} 会话的内容，并继续进行开发。</p>
          <p>新窗口沿用当前 Agent 的模型、代理和任务设置，并使用带版本后缀的新名称。</p>
          <p>Agent 按需读取旧对话。创建后可选择移除旧窗口；两个窗口共用工作区，同时运行时请避免修改相同文件。</p>
        </>
        {error && <p className='launcher-error' role='alert'>{error}</p>}
      </section></div>
      <footer className='launcher-foot'><span>{busy ? '请稍后…' : '不修改旧窗口，不复用原生会话 ID'}</span>
        <button className='button-secondary' type='button' disabled={busy} onClick={onClose}>取消</button>
        <button className='button-primary' type='button' disabled={busy || !source.nativeSessionId} onClick={() => void create()}>创建并续写</button>
      </footer>
    </section>
  </div>
}
