import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import MotionPresence from './MotionPresence'
import { usePreference } from './ui-preferences'
import './top-navigation.css'
import { useAppearanceSettings } from './appearance-settings'
import { UI_SIZES } from './shared/appearance-settings'

export type NavigationAction = 'overview' | 'attention' | 'audit' | 'tokens' | 'attention-sound' | 'terminal-settings' | 'appearance' | 'approval-rules' | 'continue-keywords' | 'session-safety' | 'dingtalk' | 'llm-review'
type NavigationView = 'overview' | 'attention' | 'audit' | 'tokens'
type MenuName = 'statistics' | 'settings' | 'shortcuts'
type ShortcutSlot = { id: string; action: NavigationAction; visible: boolean }

export const TOP_NAVIGATION_SHORTCUTS_KEY = 'agent-tui-manager:top-navigation-shortcuts:v1'
export const NAVIGATION_ACTIONS: ReadonlyArray<{ action: NavigationAction; label: string }> = [
  { action: 'overview', label: 'Agent 总览' }, { action: 'attention', label: '处理中心' },
  { action: 'audit', label: '审计' }, { action: 'tokens', label: 'Token 用量' },
  { action: 'appearance', label: '界面与文字' },
  { action: 'terminal-settings', label: '终端显示模式' },
  { action: 'attention-sound', label: '提示音设置' }, { action: 'approval-rules', label: '安全规则' },
  { action: 'continue-keywords', label: '关键词续跑' }, { action: 'session-safety', label: '会话安全' },
  { action: 'dingtalk', label: '钉钉远程' }, { action: 'llm-review', label: '审核器设置' },
]
const DEFAULT_SHORTCUTS: ShortcutSlot[] = [
  { id: 'shortcut-1', action: 'approval-rules', visible: true },
  { id: 'shortcut-2', action: 'continue-keywords', visible: true },
  { id: 'shortcut-3', action: 'llm-review', visible: false },
]
const isShortcuts = (value: unknown): value is ShortcutSlot[] => Array.isArray(value) && value.length === 3
  && value.every((slot) => slot && typeof slot === 'object'
    && DEFAULT_SHORTCUTS.some((item) => item.id === slot.id)
    && NAVIGATION_ACTIONS.some((item) => item.action === slot.action) && typeof slot.visible === 'boolean')
  && new Set(value.map((slot) => slot.id)).size === 3
const labelFor = (action: NavigationAction): string => NAVIGATION_ACTIONS.find((item) => item.action === action)!.label

function NavigationIcon({ action }: { action: NavigationAction | MenuName | 'configure' }): JSX.Element {
  const paths: Record<NavigationAction | MenuName | 'configure', string> = {
    overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    attention: 'M4 4h16v16H4zM4 13h5l1 3h4l1-3h5M9 8h6',
    statistics: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
    audit: 'M5 4h14v17H5zM8 9h8M8 13h8M8 17h5',
    tokens: 'M5 4h14M5 20h14M18 4l-8 8 8 8',
    settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    appearance: 'M3 4h18v13H3zM8 21h8M12 17v4M7 13l3-6 3 6M8 11h4M16 8v5',
    'terminal-settings': 'M3 4h18v16H3zM6 8l4 4-4 4M12 16h6',
    'attention-sound': 'M11 4v13M11 6l8-2v11M11 17a3 3 0 1 1-3-3 3 3 0 0 1 3 3M19 15a3 3 0 1 1-3-3 3 3 0 0 1 3 3',
    'approval-rules': 'M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6zM8 12l3 3 5-6',
    'continue-keywords': 'M19 8a8 8 0 1 0 1 7M19 3v5h-5M10 8l5 4-5 4z',
    'session-safety': 'M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
    dingtalk: 'M4 5l16 7-16 7 3-7zM7 12h13',
    'llm-review': 'M12 3l9 9-9 9-9-9zM8 12l3 3 5-6',
    shortcuts: 'M5 11h1v2H5zM11 11h1v2h-1zM17 11h1v2h-1z',
    configure: 'M4 6h6M14 6h6M4 12h10M18 12h2M4 18h2M10 18h10M10 3v6M14 9v6M6 15v6',
  }
  return <svg className='top-navigation-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d={paths[action]} /></svg>
}

function NavigationMenu({ name, label, open, active = false, onToggle, onClose, triggerRef, children }: {
  name: MenuName; label: string; open: boolean; active?: boolean; onToggle: () => void; onClose: () => void
  triggerRef?: React.RefObject<HTMLButtonElement>; children: ReactNode
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const localTrigger = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef ?? localTrigger
  const menu = useRef<HTMLDivElement>(null)
  const focusLast = useRef(false)
  const id = useId()
  const restoreFocus = (): void => { onClose(); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ;(focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        if (menu.current?.contains(document.activeElement)) trigger.current?.focus()
        onClose()
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, onClose, trigger])
  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restoreFocus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div className={`top-navigation-dropdown top-navigation-dropdown-${name}`} ref={root}
    onKeyDown={navigateMenu} onBlur={(event) => {
      if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose()
    }}>
    <button ref={trigger} type='button' className={`top-navigation-button${active ? ' active' : ''}`} aria-label={label}
      aria-haspopup='menu' aria-expanded={open} aria-controls={id} title={label}
      onClick={() => { focusLast.current = false; onToggle() }}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault(); event.stopPropagation(); focusLast.current = event.key === 'ArrowUp'; onToggle()
        }
      }}>
      <NavigationIcon action={name} /><span className='top-navigation-button-label'>{label}</span><span className='top-navigation-chevron' aria-hidden='true'>⌄</span>
    </button>
    <MotionPresence open={open}><div ref={menu} id={id} role='menu' aria-label={label} className='top-navigation-menu'>{children}</div></MotionPresence>
  </div>
}

export default function TopNavigation({ view, pendingCount, onNavigate, onMenuOpenChange }: {
  view: NavigationView; pendingCount: number; onNavigate: (action: NavigationAction) => void; onMenuOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [shortcuts, setShortcuts] = usePreference(TOP_NAVIGATION_SHORTCUTS_KEY, DEFAULT_SHORTCUTS, isShortcuts)
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null)
  const [configurationOpen, setConfigurationOpen] = useState(false)
  const { settings: appearance } = useAppearanceSettings()
  const compactWidth = 1080 * UI_SIZES[appearance.uiSize]
  const [compact, setCompact] = useState(() => window.matchMedia?.(`(max-width: ${compactWidth}px)`).matches ?? window.innerWidth <= compactWidth)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const overlayCallback = useRef(onMenuOpenChange)
  overlayCallback.current = onMenuOpenChange
  const dialogTitle = useId()
  const dialogDescription = useId()
  const overlayOpen = Boolean(openMenu || configurationOpen)
  useEffect(() => { overlayCallback.current?.(overlayOpen) }, [overlayOpen])
  useEffect(() => () => overlayCallback.current?.(false), [])
  useEffect(() => {
    const media = window.matchMedia?.(`(max-width: ${compactWidth}px)`)
    const resize = (): void => {
      setCompact(media?.matches ?? window.innerWidth <= compactWidth)
      setOpenMenu((current) => current === 'shortcuts' ? null : current)
    }
    resize()
    media?.addEventListener?.('change', resize)
    window.addEventListener('resize', resize)
    return () => { media?.removeEventListener?.('change', resize); window.removeEventListener('resize', resize) }
  }, [compactWidth])
  useLayoutEffect(() => {
    if (configurationOpen) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [configurationOpen])
  const closeConfiguration = (): void => { setConfigurationOpen(false); settingsTrigger.current?.focus() }
  const activate = (action: NavigationAction): void => {
    const activeMenu = document.activeElement?.closest('.top-navigation-dropdown')
    activeMenu?.querySelector<HTMLButtonElement>(':scope > button')?.focus()
    setOpenMenu(null)
    onNavigate(action)
  }
  const closeMenu = (name: MenuName): void => setOpenMenu((current) => current === name ? null : current)
  const toggleMenu = (name: MenuName): void => setOpenMenu((current) => current === name ? null : name)
  const actionButton = (action: NavigationAction, menu = false, key: string = action): JSX.Element => <button
    key={key} type='button' role={menu ? 'menuitem' : undefined} tabIndex={menu ? -1 : undefined}
    className={`${menu ? 'top-navigation-menu-item' : 'top-navigation-button top-navigation-shortcut'}${view === action ? ' active' : ''}`}
    aria-label={labelFor(action)} aria-current={view === action ? 'page' : undefined} title={labelFor(action)} onClick={() => activate(action)}>
    <NavigationIcon action={action} /><span>{labelFor(action)}</span>
    {action === 'attention' && pendingCount > 0 && <span className='top-navigation-count' aria-label={`${pendingCount} 个待处理项`}>{pendingCount > 99 ? '99+' : pendingCount}</span>}
  </button>
  const menuAction = (action: NavigationAction): JSX.Element => actionButton(action, true)
  const visibleShortcuts = shortcuts.filter((slot) => slot.visible)
  const updateSlot = (id: string, patch: Partial<ShortcutSlot>): void => setShortcuts(shortcuts.map((slot) => slot.id === id ? { ...slot, ...patch } : slot))
  const moveSlot = (index: number, step: number): void => {
    const next = [...shortcuts]
    const target = index + step
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setShortcuts(next)
  }
  const trapDialogFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The OS owns the select popup's keyboard interaction, including Escape.
    if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault(); event.stopPropagation(); closeConfiguration(); return
    }
    if (event.key !== 'Tab') return
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input') ?? [])]
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <nav className='top-navigation' aria-label='主导航'>
    <div className='top-navigation-main'>
      {actionButton('overview')}{actionButton('attention')}
      <NavigationMenu name='statistics' label='统计' open={openMenu === 'statistics'} active={view === 'audit' || view === 'tokens'}
        onToggle={() => toggleMenu('statistics')} onClose={() => closeMenu('statistics')}>
        {menuAction('audit')}{menuAction('tokens')}
      </NavigationMenu>
      <NavigationMenu name='settings' label='设置' open={openMenu === 'settings'} triggerRef={settingsTrigger}
        onToggle={() => toggleMenu('settings')} onClose={() => closeMenu('settings')}>
        {NAVIGATION_ACTIONS.slice(4).map(({ action }) => menuAction(action))}
        <div className='top-navigation-menu-separator' role='separator' />
        <button type='button' role='menuitem' tabIndex={-1} className='top-navigation-menu-item' onClick={() => { setOpenMenu(null); setConfigurationOpen(true) }}>
          <NavigationIcon action='configure' /><span>配置快捷入口</span>
        </button>
      </NavigationMenu>
    </div>
    <div className='top-navigation-spacer' />
    {visibleShortcuts.length > 0 && (compact
      ? <NavigationMenu name='shortcuts' label='更多快捷入口' open={openMenu === 'shortcuts'}
        onToggle={() => toggleMenu('shortcuts')} onClose={() => closeMenu('shortcuts')}>
        {visibleShortcuts.map((slot) => actionButton(slot.action, true, slot.id))}
      </NavigationMenu>
      : <div className='top-navigation-shortcuts' role='group' aria-label='快捷入口'>
        {visibleShortcuts.map((slot) => actionButton(slot.action, false, slot.id))}
      </div>)}
    <MotionPresence open={configurationOpen}><div className='top-navigation-dialog-backdrop' onPointerDown={(event) => {
      if (event.target === event.currentTarget) closeConfiguration()
    }}>
      <div ref={dialog} className='top-navigation-dialog' role='dialog' aria-modal='true' aria-labelledby={dialogTitle}
        aria-describedby={dialogDescription} onKeyDown={trapDialogFocus}>
        <header><h2 id={dialogTitle}>配置快捷入口</h2><button type='button' className='top-navigation-dialog-close' aria-label='关闭快捷入口设置' onClick={closeConfiguration}>×</button></header>
        <p id={dialogDescription}>选择顶部右侧的常用入口。调整会自动保存；窄窗口中可从“更多快捷入口”访问。</p>
        <div className='top-navigation-shortcut-editor'>
          {shortcuts.map((slot, index) => <div key={slot.id} className={`top-navigation-slot${slot.visible ? '' : ' is-hidden'}`}>
            <label className='top-navigation-slot-label' htmlFor={`${dialogTitle}-${slot.id}`}>快捷入口 {index + 1}{index === 2 && <small>可选</small>}</label>
            <select id={`${dialogTitle}-${slot.id}`} aria-label={`快捷入口 ${index + 1}`} value={slot.action}
              onChange={(event) => updateSlot(slot.id, { action: event.target.value as NavigationAction })}>
              {NAVIGATION_ACTIONS.map(({ action, label }) => <option key={action} value={action}>{label}</option>)}
            </select>
            <label className='top-navigation-slot-visible'><input type='checkbox' aria-label={`显示快捷入口 ${index + 1}`} checked={slot.visible}
              onChange={(event) => updateSlot(slot.id, { visible: event.target.checked })} />显示</label>
            <div className='top-navigation-slot-order'>
              <button type='button' disabled={index === 0} aria-label={`上移快捷入口 ${index + 1}`} title='上移' onClick={() => moveSlot(index, -1)}>↑</button>
              <button type='button' disabled={index === shortcuts.length - 1} aria-label={`下移快捷入口 ${index + 1}`} title='下移' onClick={() => moveSlot(index, 1)}>↓</button>
            </div>
          </div>)}
        </div>
        <footer><button type='button' className='top-navigation-reset' onClick={() => setShortcuts(DEFAULT_SHORTCUTS)}>恢复默认</button><button type='button' className='top-navigation-done' onClick={closeConfiguration}>完成</button></footer>
      </div>
    </div></MotionPresence>
  </nav>
}
