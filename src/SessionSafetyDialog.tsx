import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { SessionSafetySettings } from './shared/manager-api'

function readableError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

export default function SessionSafetyDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<SessionSafetySettings>({ preserveWorkspaceOnCrash: true })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [soundStatus, setSoundStatus] = useState('')
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
      <p className='rules-help'>选择 Manager 意外关闭后，Agent 是否继续执行任务。</p>
      <div className='launcher-config-security'><strong>提示音</strong><span>测试当前提示音。声音和音量可在“设置 → 提示音设置”中调整。</span>
        <button type='button' className='button-secondary' onClick={() => {
          setSoundStatus('')
          void window.agentManager.testAttentionSound().then(() => setSoundStatus('已发送试音；若没有听到，请检查应用音量和输出设备。'))
            .catch(() => setSoundStatus('试音失败，请重启更新后的 Manager 再试。'))
        }}>测试提示音</button>{soundStatus && <span role='status'>{soundStatus}</span>}
      </div>
      <label className='launcher-config-toggle'><span><strong>异常退出后保留运行中的 Agent</strong><small>开启：Manager 意外关闭后，Agent 继续运行，下次打开时重新连接。关闭：Agent 随之停止。</small></span><input type='checkbox' role='switch' aria-label='异常退出后保留运行中的 Agent' checked={settings.preserveWorkspaceOnCrash} onChange={(event) => setSettings({ preserveWorkspaceOnCrash: event.target.checked })} /></label>
      <div className='launcher-config-security'><strong>正常退出与启动恢复</strong><span>正常退出时可选择保留或停止 Agent。下次打开会提示恢复退出前仍在运行的会话，工作区文件和配置会保留。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
