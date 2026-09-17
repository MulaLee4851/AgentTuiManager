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
      <p className='rules-help'>Manager 异常退出时，可按此开关让受管 Agent 继续运行并等待下次接管，或停止进程并释放原生会话占用。</p>
      <label className='launcher-config-toggle'><span><strong>异常退出后保留运行中的 Agent</strong><small>默认开启。Manager 崩溃或启动进程被关闭后，Agent 继续运行；下次打开 Manager 自动接管。关闭后会停止 Agent 并释放原生会话。</small></span><input type='checkbox' role='switch' aria-label='异常退出后保留运行中的 Agent' checked={settings.preserveWorkspaceOnCrash} onChange={(event) => setSettings({ preserveWorkspaceOnCrash: event.target.checked })} /></label>
      <div className='launcher-config-security'><strong>不会保存的内容</strong><span>不保存终端正文、API Key 或代理密码，也不会改动 Codex / Claude Code 的原生历史文件。</span></div>
      <div className='launcher-config-security'><strong>正常退出与启动恢复</strong><span>退出时可选择让 Agent 继续运行或停止进程。两种方式都保留目录和配置，并保存退出前仍启动着的 Agent；下次启动提示恢复，已停止的旧窗口不加入快照。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
