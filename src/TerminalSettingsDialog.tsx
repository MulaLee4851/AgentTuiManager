import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { trapDialogTab } from './dialog-focus'
import AnimatedDetails from './AnimatedDetails'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from './shared/terminal-settings'

export default function TerminalSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<TerminalSettings>({ ...DEFAULT_TERMINAL_SETTINGS })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLFormElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    dialog.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let mounted = true
    void window.agentManager.getTerminalSettings().then(value => {
      if (mounted) { setSettings(value); setLoaded(true) }
    }).catch(reason => { if (mounted) setError(String(reason instanceof Error ? reason.message : reason)) })
    return () => { mounted = false }
  }, [])
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!loaded || busy) return
    setBusy(true); setError('')
    try { await window.agentManager.updateTerminalSettings(settings); onClose() }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setBusy(false) }
  }
  return <div className='modal-backdrop' role='presentation'>
    <form ref={dialog} tabIndex={-1} className='rules-dialog terminal-settings-dialog' role='dialog' aria-modal='true' aria-labelledby='terminal-settings-title'
      onSubmit={event => { void save(event) }} onKeyDown={event => {
        trapDialogTab(event, dialog.current)
        if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
      }}>
      <header><div><span className='eyebrow'>TERMINAL</span><h2 id='terminal-settings-title'>终端显示模式</h2></div><button type='button' className='icon-button' onClick={onClose} disabled={busy} aria-label='关闭终端设置'>×</button></header>
      <div className='terminal-settings-body'>
        <p className='rules-help'>选择 Codex 的显示和鼠标操作方式。</p>
        {loaded && <section className='terminal-mode-guide' aria-label='当前模式的操作方式'>
          <p className='terminal-mode-summary' role='status'>所选模式：{settings.codexMode === 'scrollback' ? '兼容模式' : 'Codex 原生模式（默认）'}</p>
          {settings.codexMode === 'scrollback' ? <ul>
            <li><strong>查看与复制：</strong>通过终端滚动查看历史，鼠标拖选屏幕文字后复制。</li>
            <li><strong>编辑输入：</strong>使用键盘移动光标、输入和删除文字；Ctrl+V 粘贴。</li>
          </ul> : <ul>
            <li><strong>鼠标编辑输入：</strong>点击移动光标，拖选后可直接输入替换，或按 Delete 删除。</li>
            <li><strong>复制与粘贴：</strong>Ctrl+C 复制输入选区，Ctrl+V 粘贴。</li>
            <li><strong>查看对话：</strong>在 Codex 中滚动查看历史；按住 Shift 拖选屏幕文字，再按 Ctrl+C 复制。</li>
          </ul>}
        </section>}
        <AnimatedDetails title='高级设置' className='advanced-settings'>
          <fieldset disabled={!loaded || busy}>
            <label className='terminal-compatibility-option' htmlFor='codex-terminal-compatibility'>
              <input id='codex-terminal-compatibility' type='checkbox' checked={settings.codexMode === 'scrollback'} onChange={event => setSettings({ codexMode: event.target.checked ? 'scrollback' : 'native-fullscreen' })} />
              启用兼容模式
            </label>
            <p className='field-note'>兼容模式用于解决显示或滚动异常，输入文字需用键盘编辑。</p>
          </fieldset>
        </AnimatedDetails>
        <p className='field-note terminal-settings-scope'>保存后，下次新建、重启或恢复 Codex 会话时使用所选模式。正在运行的会话保持当前模式。</p>
        {!loaded && !error && <p role='status'>正在读取设置…</p>}
        {error && <p className='form-error' role='alert'>{error}</p>}
      </div>
      <footer><button type='button' className='button-secondary' disabled={busy} onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={!loaded || busy}>{busy ? '保存中…' : '保存设置'}</button></footer>
    </form>
  </div>
}
