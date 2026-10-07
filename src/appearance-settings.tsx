import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_APPEARANCE_SETTINGS, parseAppearanceSettings, UI_SIZES, type AppearanceSettings } from './shared/appearance-settings'

interface AppearanceState {
  settings: AppearanceSettings
  loaded: boolean
  saving: boolean
  error: string
  update: (settings: AppearanceSettings) => void
  reload: () => void
}
const AppearanceContext = createContext<AppearanceState>({ settings: { ...DEFAULT_APPEARANCE_SETTINGS }, loaded: false, saving: false, error: '', update: () => undefined, reload: () => undefined })
export const useAppearanceSettings = (): AppearanceState => useContext(AppearanceContext)

export function AppearanceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<AppearanceSettings>({ ...DEFAULT_APPEARANCE_SETTINGS })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadVersion, setLoadVersion] = useState(0)
  const version = useRef(0)
  const pending = useRef(0)
  const loadedRef = useRef(false)
  const writes = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let active = true
    const started = version.current
    void window.agentManager.getAppearanceSettings().then(value => {
      if (!active || version.current !== started) return
      setSettings(parseAppearanceSettings(value)); setLoaded(true); loadedRef.current = true; setError('')
    }).catch(() => { if (active) setError('无法读取界面设置，请重试。') })
    const unsubscribe = window.agentManager.onAppearanceSettingsChanged(value => {
      if (pending.current) return
      version.current++
      setSettings(parseAppearanceSettings(value)); setLoaded(true); loadedRef.current = true; setError('')
    })
    return () => { active = false; unsubscribe() }
  }, [loadVersion])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.fontSize = `${16 * UI_SIZES[settings.uiSize]}px`
    root.dataset.uiSize = settings.uiSize
  }, [settings.uiSize])

  const update = useCallback((value: AppearanceSettings): void => {
    if (!loadedRef.current) return
    const next = parseAppearanceSettings(value)
    const current = ++version.current
    pending.current++
    setSettings(next); setSaving(true); setError('')
    // One queue keeps rapid changes ordered even if the dialog is closed while saving.
    writes.current = writes.current.catch(() => undefined).then(() => window.agentManager.updateAppearanceSettings(next)).then(() => {
      if (current === version.current) setError('')
    }).catch(() => {
      if (current === version.current) setError('保存失败，当前仅为预览。请重试保存。')
    }).finally(() => { pending.current--; if (!pending.current) setSaving(false) })
  }, [])
  return <AppearanceContext.Provider value={{ settings, loaded, saving, error, update, reload: () => setLoadVersion(value => value + 1) }}>{children}</AppearanceContext.Provider>
}
