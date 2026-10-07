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
        maxRetries: settings.maxRetries ?? 3,
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
      <header><div><span className='eyebrow'>RECOVERY</span><h2 id='continue-keyword-title'>关键词续跑</h2></div><button type='button' className='icon-button' onClick={onClose} aria-label='关闭关键词续跑设置'>×</button></header>
      <p className='rules-help'>Agent 停止工作，且最新回复或错误包含下方关键词时，自动发送继续提示。可用于连接中断、模型繁忙等临时错误。</p>
      <label className='launcher-config-toggle'><span><strong>启用关键词续跑</strong><small>默认关闭。仅在 Agent 停止工作并命中关键词时续跑，连续次数受下方上限控制。</small></span><input type='checkbox' role='switch' aria-label='启用关键词续跑' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <div className={'continue-keyword-fields' + (settings.enabled ? '' : ' disabled')}>
        <label>最大连续续跑次数<input className='launcher-field' aria-label='最大连续续跑次数' disabled={!settings.enabled} type='number' min={1} max={100} value={settings.maxRetries ?? 3} onChange={(event) => setSettings(current => ({ ...current, maxRetries: Number(event.target.value) }))} /><span>每个 Agent 独立计数；手动输入新任务或正常完成后重置。</span></label>
        <label>关键词（每行一个）<textarea className='launcher-field' aria-label='Continue 关键词列表' disabled={!settings.enabled} rows={7} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={'例如：\nSelected model is at capacity\nconnection temporarily unavailable'} /></label>
      </div>
      <div className='launcher-config-security'><strong>不会续跑的情况</strong><span>Agent 正在运行、等待审批、输入框中有未发送内容，或你按 Esc／Ctrl+C 停止任务时，不会触发。只检查最新输出，同一次输出只尝试一次；无监管模式使用自己的续跑设置。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭，已填写内容会保留</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
