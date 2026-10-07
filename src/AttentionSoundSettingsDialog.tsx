import { type FormEvent, useEffect, useState } from 'react'
import { DEFAULT_ATTENTION_AUDIO_SETTINGS, type AttentionAudioSettings, type AttentionSoundKind } from './shared/attention-audio-settings'

function readableError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

export default function AttentionSoundSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<AttentionAudioSettings>({ ...DEFAULT_ATTENTION_AUDIO_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    let mounted = true
    void window.agentManager.getAttentionSoundSettings().then(value => {
      if (mounted) { setSettings(value); setLoaded(true) }
    }).catch(reason => { if (mounted) setError(readableError(reason)) })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try { await window.agentManager.updateAttentionSoundSettings(settings); onClose() }
    catch (reason) { setError(readableError(reason)) }
    finally { setBusy(false) }
  }

  const preview = async (): Promise<void> => {
    setBusy(true); setError(''); setStatus('')
    try {
      await window.agentManager.testAttentionSound(settings)
      setStatus(settings.volume === 0 ? '当前音量为 0%，试听已静音。' : '若未听到声音，请检查系统中的应用音量和输出设备。')
    } catch (reason) { setError(readableError(reason)) }
    finally { setBusy(false) }
  }

  return <div className='modal-backdrop' role='presentation' onDoubleClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <form className='rules-dialog attention-sound-dialog' role='dialog' aria-modal='true' aria-labelledby='attention-sound-title' onSubmit={event => { void save(event) }}>
      <header><div><span className='eyebrow'>ATTENTION SOUND</span><h2 id='attention-sound-title'>提示音设置</h2></div><button type='button' className='icon-button' onClick={onClose} aria-label='关闭提示音设置'>×</button></header>
      <p className='rules-help'>Agent 提问、完成任务或等待你审批时播放提示音；仅当 Manager 位于前台且你正在查看该 Agent 时不响。自动处理的审批不提醒。</p>
      <fieldset disabled={loading || busy || !loaded}>
        <label htmlFor='attention-sound-kind'>声音类型</label>
        <select id='attention-sound-kind' value={settings.sound} onChange={event => { setSettings({ ...settings, sound: event.target.value as AttentionSoundKind }); setStatus('') }}>
          <option value='classic'>经典双音（默认）</option><option value='soft'>柔和低音</option><option value='bell'>清亮三音</option><option value='pulse'>短促双响</option>
        </select>
        <label htmlFor='attention-sound-volume'>音量 <output htmlFor='attention-sound-volume'>{settings.volume}%</output></label>
        <input id='attention-sound-volume' type='range' min={0} max={100} step={1} value={settings.volume} aria-valuetext={`${settings.volume}%${settings.volume === 0 ? '，静音' : ''}`} onChange={event => { setSettings({ ...settings, volume: Number(event.target.value) }); setStatus('') }} />
        <p className='field-note'>0% 为静音。可先试听，保存后用于后续提醒。响度也受系统音量影响。</p>
        <div className='attention-sound-actions'><button type='button' className='button-secondary' onClick={() => { void preview() }}>试听</button><button type='button' className='button-secondary' onClick={() => { setSettings({ ...DEFAULT_ATTENTION_AUDIO_SETTINGS }); setStatus('已恢复默认选项，保存后生效。') }}>恢复默认</button></div>
      </fieldset>
      {loading && <p role='status'>正在读取设置…</p>}
      {status && <p className='rules-help' role='status'>{status}</p>}
      {error && <p className='form-error' role='alert'>{error}</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={loading || busy || !loaded}>{busy ? '请稍后…' : '保存设置'}</button></footer>
    </form>
  </div>
}
