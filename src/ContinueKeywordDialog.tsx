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
      <p className='rules-help'>优先检查当前轮最后一条 Agent 回复或错误，终端兜底只取最新输出行。命中关键词且处于待命、完成或异常时才尝试续跑；运行中、等待审批、未提交输入、Esc 或 Ctrl+C 不会触发。无监管开启时由无监管接管。</p>
      <label className='launcher-config-toggle'><span><strong>启用关键词 Continue</strong><small>默认关闭。仅在 Agent 停止工作并命中关键词时续跑，连续次数受下方上限控制。</small></span><input type='checkbox' role='switch' aria-label='启用关键词 Continue' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <div className={'continue-keyword-fields' + (settings.enabled ? '' : ' disabled')}>
        <label>最大连续续跑次数<input className='launcher-field' aria-label='最大连续续跑次数' disabled={!settings.enabled} type='number' min={1} max={100} value={settings.maxRetries ?? 3} onChange={(event) => setSettings(current => ({ ...current, maxRetries: Number(event.target.value) }))} /><span>每个 Agent 独立计数；手动输入新任务或正常完成后重置。</span></label>
        <label>关键词（每行一个）<textarea className='launcher-field' aria-label='Continue 关键词列表' disabled={!settings.enabled} rows={7} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={'例如：\nSelected model is at capacity\nconnection temporarily unavailable'} /></label>
      </div>
      <div className='launcher-config-security'><strong>触发边界</strong><span>仅匹配用户维护的关键词，同一次输出只尝试一次。最新回复或活动状态变化会重新校验；不扫描全部历史，不把用户输入作为匹配来源。</span></div>
      {error && <p className='form-error'>{error}</p>}
      {closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭，已填写内容会保留</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
