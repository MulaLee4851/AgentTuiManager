import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { trapDialogTab } from './dialog-focus'
import type { NativeSessionSummary, SessionSummary } from './shared/manager-api'

export default function SessionBindingDialog({ session, mode, onClose, onChanged }: {
  session: SessionSummary; mode: 'history' | 'fresh'; onClose: () => void; onChanged: () => void
}): JSX.Element {
  const [bindingMode, setBindingMode] = useState(mode)
  const dialog = useRef<HTMLElement>(null)
  const submitting = useRef(false)
  useLayoutEffect(() => { dialog.current?.focus() }, [bindingMode])
  const [items, setItems] = useState<NativeSessionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(bindingMode === 'history')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (bindingMode !== 'history') return
    let active = true
    setLoading(true); setError(''); setSelected('')
    void (async () => {
      try {
        if (!window.agentManager.listBindingSessions) throw new Error('请重启 Manager 后使用')
        const result = await window.agentManager.listBindingSessions(session.sessionId)
        if (active) setItems(result)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [session.sessionId, bindingMode, revision])
  const submit = async () => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      if (!window.agentManager.replaceSessionBinding) throw new Error('请重启 Manager 后使用')
      await window.agentManager.replaceSessionBinding(session.sessionId, bindingMode === 'fresh' ? null : selected)
      onChanged(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const filtered = items.filter(item => `${item.managerDisplayName ?? ''} ${item.title} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className='launcher-scrim' role='presentation' onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }; trapDialogTab(event, dialog.current) }}>
    <section ref={dialog} tabIndex={-1} className='agent-launcher session-continuation-dialog' role='dialog' aria-modal='true' aria-labelledby='binding-heading'>
      <header className='launcher-head'><h1 id='binding-heading'>{bindingMode === 'fresh' ? '按原配置开启新会话' : '选择历史会话'}</h1><button type='button' className='icon-button' disabled={busy} onClick={onClose} aria-label='关闭会话切换'>×</button></header>
      <div className='launcher-content'><section className='launcher-panel'>
        <div className='launcher-config-intro'><strong>{session.displayName}</strong><span>{session.workspace}</span></div>
        <p>沿用当前 Agent 的名称和设置，历史对话文件会保留。</p>
        {session.status === 'needs_attention' && <p>确认后先停止当前异常进程，再启动所选会话。</p>}
        <p>更换会话后先使用普通审批模式，首次输入前暂停关键词续跑。确认会话无误后可重新选择审批模式；点击“继续重试”则保留当前模式。</p>
        {bindingMode === 'fresh' ? <p>新会话从空白对话开始。需要继续旧对话时，可使用 /resume 查找历史。</p> : <>
          <div className='launcher-section-title'><h2>当前目录的会话</h2><button type='button' className='button-secondary' disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>刷新</button></div>
          <input className='launcher-field' aria-label='搜索历史会话' placeholder='搜索名称或会话 ID' value={search} onChange={event => setSearch(event.target.value)} />
          {loading ? <p>正在检查对话文件…</p> : <div className='launcher-session-list'>{filtered.map(item => <button type='button' disabled={busy} className={`launcher-session-item${selected === item.id ? ' active' : ''}`} aria-pressed={selected === item.id} key={item.id} onClick={() => setSelected(item.id)}><span><strong>{item.managerDisplayName ?? item.title}</strong><small>{item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}{!filtered.length && <p>该目录没有匹配的有效对话。可取消后按原配置开启新会话。</p>}</div>}
        </>}
        {error && <p className='launcher-error' role='alert'>{error}</p>}
      </section></div>
      <footer className='launcher-foot'><span>在当前窗口打开所选会话</span><button type='button' className='button-secondary' disabled={busy} onClick={onClose}>取消</button>{bindingMode === 'history' && ['stopped', 'failed', 'completed'].includes(session.status) && <button type='button' className='button-secondary' disabled={busy} onClick={() => { if (!window.agentManager.restartSession) { setError('请重启 Manager 后使用'); return } setBusy(true); void window.agentManager.restartSession(session.sessionId).then(() => { onChanged(); onClose() }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)) }}>继续重试</button>}{bindingMode === 'history' && <button type='button' className='button-secondary' disabled={busy} onClick={() => { setBindingMode('fresh'); setError('') }}>按原配置开启新会话</button>}<button type='button' className='button-primary' disabled={busy || (bindingMode === 'history' && (loading || !selected))} onClick={() => void submit()}>{busy ? '正在切换…' : bindingMode === 'fresh' ? '确认开启新会话' : '关联并启动'}</button></footer>
    </section>
  </div>
}
