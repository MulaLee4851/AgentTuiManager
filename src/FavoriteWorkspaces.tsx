import { useEffect, useId, useState } from 'react'
import AnimatedCollapse from './AnimatedCollapse'
import { FAVORITE_WORKSPACES_KEY, RECENT_WORKSPACES_KEY, WORKSPACE_SHORTCUTS_CHANGED, isAbsoluteWorkspace,
  readFavoriteWorkspaces, readRecentWorkspaces, workspaceIdentity, workspaceLabel, type FavoriteWorkspace } from './workspace-shortcuts'
export { FAVORITE_WORKSPACES_KEY, isAbsoluteWorkspace } from './workspace-shortcuts'
export type { FavoriteWorkspace } from './workspace-shortcuts'

export default function FavoriteWorkspaces({ workspace, disabled, onSelect }: { workspace: string; disabled: boolean; onSelect: (path: string) => void }): JSX.Element {
  const platform = window.agentManager.platform
  const [items, setItems] = useState(readFavoriteWorkspaces)
  const [recent, setRecent] = useState(() => readRecentWorkspaces(platform))
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const [managing, setManaging] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    const refresh = (): void => { setItems(readFavoriteWorkspaces()); setRecent(readRecentWorkspaces(platform)) }
    const storage = (event: StorageEvent): void => {
      if (!event.key || event.key === FAVORITE_WORKSPACES_KEY || event.key === RECENT_WORKSPACES_KEY) refresh()
    }
    window.addEventListener(WORKSPACE_SHORTCUTS_CHANGED, refresh)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener(WORKSPACE_SHORTCUTS_CHANGED, refresh); window.removeEventListener('storage', storage) }
  }, [platform])
  const persist = (next: FavoriteWorkspace[]): boolean => {
    try { window.localStorage.setItem(FAVORITE_WORKSPACES_KEY, JSON.stringify(next)); setItems(next); setError(''); return true }
    catch { setError('常用工作区保存失败，请检查本地存储是否可用'); return false }
  }
  const reset = (): void => { setEditingId(undefined); setName(''); setPath('') }
  const save = (): void => {
    const normalized = path.trim()
    if (!name.trim() || name.trim().length > 80 || normalized.length > 4096 || !isAbsoluteWorkspace(normalized, window.agentManager.platform)) {
      setError('请填写名称（最多 80 字）和完整工作区路径'); return
    }
    if (!editingId && items.length >= 100) { setError('最多保存 100 个常用工作区'); return }
    if (items.some(item => item.id !== editingId && workspaceIdentity(item.path, platform) === workspaceIdentity(normalized, platform))) {
      setError('这个工作区已经保留，可编辑现有记录'); return
    }
    const item = { id: editingId ?? crypto.randomUUID(), name: name.trim(), path: normalized }
    if (persist(editingId ? items.map(old => old.id === editingId ? item : old) : [...items, item])) reset()
  }
  const choose = async (): Promise<void> => {
    setChoosing(true); setError('')
    try { const selected = await window.agentManager.chooseWorkspace(); if (selected) { setPath(selected); if (!name.trim()) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? selected) } }
    catch { setError('无法打开文件夹选择器，请直接填写完整路径') }
    finally { setChoosing(false) }
  }
  const keep = (selected: string): void => {
    if (items.length >= 100) { setError('最多保存 100 个常用工作区'); return }
    persist([...items, { id: crypto.randomUUID(), name: workspaceLabel(selected), path: selected }])
  }
  const recentOptions = recent.filter(entry => !items.some(item => workspaceIdentity(item.path, platform) === workspaceIdentity(entry.path, platform)))
  return <section className='favorite-workspaces' aria-label='常用工作区'>
    <div className='favorite-workspaces-heading'>
      <button type='button' className='workspace-list-toggle' aria-label={expanded ? '收起工作区列表' : '展开工作区列表'} aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}><span className='collapse-chevron' aria-hidden='true'>›</span><strong>常用工作区</strong><small>最近 {recentOptions.length} · 已保留 {items.length}</small></button>
      <button type='button' className='button-secondary mini-button' disabled={disabled} aria-expanded={managing && expanded} onClick={() => { const next = !expanded || !managing; setExpanded(true); setManaging(next); setError(''); if (next && !editingId) setPath(workspace) }}>{managing && expanded ? '收起管理' : '管理列表'}</button>
    </div>
    <AnimatedCollapse open={expanded} id={contentId}>
    <div className='workspace-shortcuts-scroll'>
      {items.length > 0 && <div className='workspace-shortcut-group' aria-label='已保留工作区'><h3>已保留</h3>{items.map(item =>
        <button type='button' className='workspace-shortcut-select' key={item.id} disabled={disabled} title={item.path} aria-label={item.name}
          aria-pressed={workspaceIdentity(workspace, platform) === workspaceIdentity(item.path, platform)} onClick={() => onSelect(item.path)}><strong>{item.name}</strong><small>{item.path}</small></button>)}</div>}
      {recentOptions.length > 0 && <div className='workspace-shortcut-group' aria-label='最近使用工作区'><h3>最近使用</h3>{recentOptions.map(item => <div className='workspace-recent-row' key={workspaceIdentity(item.path, platform)}>
        <button type='button' className='workspace-shortcut-select' disabled={disabled} title={item.path} aria-label={`选择工作区 ${item.path}`}
          aria-pressed={workspaceIdentity(workspace, platform) === workspaceIdentity(item.path, platform)} onClick={() => onSelect(item.path)}><strong>{workspaceLabel(item.path)}</strong><small>{item.path}</small></button>
        <button type='button' className='workspace-keep-button' disabled={disabled} aria-label={`保留工作区 ${item.path}`} onClick={() => keep(item.path)}>保留</button>
      </div>)}</div>}
      {items.length === 0 && recentOptions.length === 0 && <p className='workspace-shortcuts-empty'>这里显示最近使用的 5 个工作区。常用项目可点击“保留”，或在“管理列表”中添加。</p>}
    <AnimatedCollapse open={managing}>
    <div className='favorite-workspace-manager' onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); if (!disabled) save() } }}>
      {items.map(item => <div className='favorite-workspace-row' key={item.id}><span title={item.path}><strong>{item.name}</strong><small>{item.path}</small></span><button type='button' disabled={disabled} aria-label={`编辑工作区 ${item.name}`} onClick={() => { setEditingId(item.id); setName(item.name); setPath(item.path); setError('') }}>编辑</button><button type='button' disabled={disabled} aria-label={`移除工作区 ${item.name}`} onClick={() => { if (persist(items.filter(old => old.id !== item.id)) && editingId === item.id) reset() }}>移除</button></div>)}
      <label>工作区名称<input className='launcher-field' maxLength={80} value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder='例如：趋势分析' /></label>
      <label>工作区路径<div className='workspace-picker'><input className='launcher-field' value={path} disabled={disabled} onChange={event => setPath(event.target.value)} placeholder='完整目录路径' /><button type='button' disabled={disabled || choosing} onClick={() => { void choose() }}>浏览</button></div></label>
      <div className='favorite-workspace-actions'><small>移除不会删除文件夹，最近使用的项目仍可在“最近”列表中找到。</small>{editingId && <button type='button' onClick={reset}>取消编辑</button>}<button type='button' disabled={disabled || !name.trim() || !path.trim()} onClick={save}>{editingId ? '保存工作区' : '添加工作区'}</button></div>
    </div>
    </AnimatedCollapse>
    </div>
    </AnimatedCollapse>
    {error && <p role='alert' className='launcher-state error'>{error}</p>}
  </section>
}
