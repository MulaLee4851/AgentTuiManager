import { useLayoutEffect, useRef } from 'react'
import { useAppearanceSettings } from './appearance-settings'
import { DEFAULT_APPEARANCE_SETTINGS, TERMINAL_FONT_SIZES, type AppearanceSettings } from './shared/appearance-settings'
import { trapDialogTab } from './dialog-focus'

export default function AppearanceSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, loaded, saving, error, update, reload } = useAppearanceSettings()
  const dialog = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    dialog.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <div className='modal-backdrop' role='presentation'>
    <div ref={dialog} tabIndex={-1} className='rules-dialog appearance-dialog' role='dialog' aria-modal='true' aria-labelledby='appearance-title'
      onKeyDown={event => { trapDialogTab(event, dialog.current); if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); event.stopPropagation(); onClose() } }}>
      <header><h2 id='appearance-title'>界面与文字</h2><button type='button' className='icon-button' onClick={onClose} aria-label='关闭界面设置'>×</button></header>
      <div className='appearance-body'>
        <p className='rules-help'>调整后立即生效并自动保存。</p>
        <fieldset disabled={!loaded}>
          <legend>界面大小</legend>
          <div className='appearance-size-options'>
            {([['compact', '紧凑', '85%'], ['standard', '标准', '100%'], ['comfortable', '舒适', '110%'], ['large', '大号', '125%']] as const).map(([value, label, scale]) =>
              <label key={value} className={settings.uiSize === value ? 'selected' : ''}>
                <input type='radio' name='ui-size' value={value} checked={settings.uiSize === value} onChange={() => update({ ...settings, uiSize: value })} />
                <span>{label}<small>{scale}</small></span>
              </label>)}
          </div>
          <p className='field-note'>调整菜单、按钮和列表的大小，不改变终端文字。</p>
          <label className='appearance-font-label' htmlFor='terminal-font-size'>终端文字大小</label>
          <select id='terminal-font-size' value={settings.terminalFontSize} onChange={event => update({ ...settings, terminalFontSize: event.target.value === 'auto' ? 'auto' : Number(event.target.value) as AppearanceSettings['terminalFontSize'] })}>
            <option value='auto'>自动适应面板（默认）</option>
            {TERMINAL_FONT_SIZES.map(size => <option key={size} value={size}>{size} px</option>)}
          </select>
          <p className='field-note'>单独设置所有 Agent 的终端字号。自动适应会随面板宽度调整；选择固定字号后，文字大小保持不变。</p>
        </fieldset>
      </div>
      <div className='appearance-save-status' aria-live='polite'>
        {error ? <p className='form-error' role='alert'>{error} <button type='button' className='button-secondary button-compact' onClick={() => loaded ? update(settings) : reload()}>重试{loaded ? '保存' : '读取'}</button></p> : <span>{!loaded ? '正在读取设置…' : saving ? '正在保存…' : '已保存'}</span>}
      </div>
      <footer><button type='button' className='button-secondary' disabled={!loaded} onClick={() => update({ ...DEFAULT_APPEARANCE_SETTINGS })}>恢复默认</button><button type='button' className='button-primary' onClick={onClose}>完成</button></footer>
    </div>
  </div>
}
