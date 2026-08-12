import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { ContinueKeywordSettings } from './shared/manager-api'

const DEFAULT_SETTINGS: ContinueKeywordSettings = { enabled: false, quietSeconds: 10, keywords: [] }

function readableError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

export default function ContinueKeywordDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<ContinueKeywordSettings>(DEFAULT_SETTINGS)
  const [keywords, setKeywords] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void window.agentManager.getContinueKeywordSettings()
      .then((value) => { setSettings(value); setKeywords(value.keywords.join('\n')) })
      .catch((reason) => setError(readableError(reason)))
      .finally(() => setBusy(false))
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current) }
  }, [])

  const armClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }
  const resetClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const saved = await window.agentManager.updateContinueKeywordSettings({
        ...settings,
        keywords: keywords.split(/\r?\n/).map((keyword) => keyword.trim()).filter(Boolean),
      })
      setSettings(saved); setKeywords(saved.keywords.join('\n')); onClose()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setBusy(false)
    }
  }

  return <div className='modal-backdrop' role='presentation'
    onMouseDown={(event) => { if (event.target === event.currentTarget) armClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetClose(); onClose() } }}>
    <form className='rules-dialog continue-keyword-dialog' role='dialog' aria-modal='true' aria-labelledby='continue-keyword-title' onMouseDown={resetClose} onSubmit={(event) => { void save(event) }}>
      <header><div><span className='eyebrow'>RECOVERY</span><h2 id='continue-keyword-title'>Continue 关键词</h2></div><button type='button' className='icon-button' onClick={onClose} aria-label='关闭 Continue 关键词设置'>×</button></header>
      <p className='rules-help'>仅在命中关键词后持续没有新输出时尝试一次。Agent 自己继续输出、等待授权、正常结束、Esc 或 Ctrl+C 都不会触发。</p>
      <label className='launcher-config-toggle'><span><strong>启用关键词 Continue</strong><small>默认关闭。每次命中最多发送一次，不循环重试。</small></span><input type='checkbox' role='switch' aria-label='启用关键词 Continue' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <div className={'continue-keyword-fields' + (settings.enabled ? '' : ' disabled')}>
        <label>关键词（每行一个）<textarea className='launcher-field' aria-label='Continue 关键词列表' disabled={!settings.enabled} rows={7} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={'例如：\nSelected model is at capacity\nconnection temporarily unavailable'} /></label>
        <label>无新输出等待时间<input className='launcher-field' aria-label='Continue 静默等待秒数' disabled={!settings.enabled} type='number' min={3} max={60} value={settings.quietSeconds} onChange={(event) => setSettings((current) => ({ ...current, quietSeconds: Number(event.target.value) }))} /><span>秒</span></label>
      </div>
      <div className='launcher-config-security'><strong>触发边界</strong><span>只按文本包含匹配；命中后有任何新输出都会重新等待。Agent 自带重试优先，不会并发发送 Continue。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭，已填写内容会保留</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
