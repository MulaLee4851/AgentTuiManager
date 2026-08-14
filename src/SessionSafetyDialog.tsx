import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { SessionSafetySettings } from './shared/manager-api'

function readableError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

export default function SessionSafetyDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<SessionSafetySettings>({ preserveWorkspaceOnCrash: true })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void window.agentManager.getSessionSafetySettings().then(setSettings).catch((reason) => setError(readableError(reason))).finally(() => setBusy(false))
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current) }
  }, [])

  const armClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setCloseArmed(false), 500)
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try { await window.agentManager.updateSessionSafetySettings(settings); onClose() }
    catch (reason) { setError(readableError(reason)) }
    finally { setBusy(false) }
  }

  return <div className='modal-backdrop' role='presentation' onMouseDown={(event) => { if (event.target === event.currentTarget) armClose() }} onDoubleClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <form className='rules-dialog session-safety-dialog' role='dialog' aria-modal='true' aria-labelledby='session-safety-title' onMouseDown={() => setCloseArmed(false)} onSubmit={(event) => { void save(event) }}>
      <header><div><span className='eyebrow'>SESSION SAFETY</span><h2 id='session-safety-title'>会话安全</h2></div><button type='button' className='icon-button' onClick={onClose} aria-label='关闭会话安全设置'>×</button></header>
      <p className='rules-help'>Manager 异常退出时始终停止受管终端并释放原生会话占用。此设置只决定下次打开时是否保留 Agent 和工作区记录。</p>
      <label className='launcher-config-toggle'><span><strong>异常退出后保留运行中的 Agent</strong><small>默认开启。Manager 崩溃或启动进程被关闭后，Agent 继续运行；下次打开 Manager 自动接管。关闭后会停止 Agent 并释放原生会话。</small></span><input type='checkbox' role='switch' aria-label='异常退出后保留运行中的 Agent' checked={settings.preserveWorkspaceOnCrash} onChange={(event) => setSettings({ preserveWorkspaceOnCrash: event.target.checked })} /></label>
      <div className='launcher-config-security'><strong>不会保存的内容</strong><span>不保存终端正文、API Key 或代理密码，也不会改动 Codex / Claude Code 的原生历史文件。</span></div>
      <div className='launcher-config-security'><strong>正常退出</strong><span>退出 Manager 时会单独询问是否保留。选择保留时 Agent 继续运行；选择不保留时释放并清除 Manager 记录。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
