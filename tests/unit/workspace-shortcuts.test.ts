// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FavoriteWorkspaces from '../../src/FavoriteWorkspaces'
import {
  FAVORITE_WORKSPACES_KEY, RECENT_WORKSPACES_KEY, WORKSPACE_SHORTCUTS_CHANGED,
  isAbsoluteWorkspace, readFavoriteWorkspaces, readRecentWorkspaces, rememberRecentWorkspace, workspaceIdentity,
} from '../../src/workspace-shortcuts'

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'agentManager', { configurable: true, value: { platform: 'win32', chooseWorkspace: vi.fn() } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('workspace shortcut persistence', () => {
  it('keeps only the five most recently successful workspaces, even when the clock does not advance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    for (let index = 0; index < 7; index++) rememberRecentWorkspace(`C:\\synthetic\\project-${index}`, 'win32')
    expect(readRecentWorkspaces('win32').map(entry => entry.path)).toEqual([6, 5, 4, 3, 2].map(index => `C:\\synthetic\\project-${index}`))
    rememberRecentWorkspace('C:\\synthetic\\project-3', 'win32')
    const recent = readRecentWorkspaces('win32')
    expect(recent).toHaveLength(5)
    expect(recent[0]!.path).toBe('C:\\synthetic\\project-3')
    expect(recent[0]!.lastUsedAt).toBeGreaterThan(recent[1]!.lastUsedAt)
  })

  it('deduplicates Windows case, slash and trailing separator variants, including UNC shares', () => {
    rememberRecentWorkspace('C:\\Synthetic\\Project\\', 'win32')
    rememberRecentWorkspace('c:/synthetic/project', 'win32')
    rememberRecentWorkspace('\\\\server\\share\\Project\\', 'win32')
    rememberRecentWorkspace('\\\\SERVER\\SHARE\\project', 'win32')
    expect(readRecentWorkspaces('win32')).toHaveLength(2)
    expect(workspaceIdentity('C:\\', 'win32')).toBe(workspaceIdentity('c:/', 'win32'))
    expect(workspaceIdentity('/synthetic/Project', 'linux')).not.toBe(workspaceIdentity('/synthetic/project', 'linux'))
  })

  it('rejects relative paths and controls without creating history or dispatching updates', () => {
    const changed = vi.fn()
    window.addEventListener(WORKSPACE_SHORTCUTS_CHANGED, changed)
    try {
      for (const path of ['', 'project', 'C:project', '\\project', 'C:\\synthetic\u0000bad', 'C:\\' + 'a'.repeat(4096)]) {
        expect(isAbsoluteWorkspace(path, 'win32')).toBe(false)
        rememberRecentWorkspace(path, 'win32')
      }
      expect(localStorage.getItem(RECENT_WORKSPACES_KEY)).toBeNull()
      expect(changed).not.toHaveBeenCalled()
    } finally { window.removeEventListener(WORKSPACE_SHORTCUTS_CHANGED, changed) }
  })

  it('sorts and sanitizes loaded history before limiting it', () => {
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify([
      { path: 'C:\\synthetic\\a', lastUsedAt: 3 },
      { path: 'c:/synthetic/a/', lastUsedAt: 9 },
      { path: 'relative', lastUsedAt: 12 },
      { path: 'C:\\synthetic\\b', lastUsedAt: 6 },
    ]))
    expect(readRecentWorkspaces('win32')).toEqual([
      { path: 'c:/synthetic/a/', lastUsedAt: 9 }, { path: 'C:\\synthetic\\b', lastUsedAt: 6 },
    ])
  })

  it.each(['{broken', '{}', '[{"path":"C:/synthetic","lastUsedAt":"yesterday"}]'])(
    'tolerates malformed stored recent history: %s', saved => {
      localStorage.setItem(RECENT_WORKSPACES_KEY, saved)
      expect(readRecentWorkspaces('win32')).toEqual([])
      expect(() => rememberRecentWorkspace('C:\\synthetic\\valid', 'win32')).not.toThrow()
      expect(readRecentWorkspaces('win32')[0]!.path).toBe('C:\\synthetic\\valid')
    },
  )

  it('preserves custom favorites under the original storage key when recent history changes', () => {
    const favorite = { id: 'existing-favorite', name: 'Synthetic favorite', path: 'C:\\synthetic\\favorite' }
    localStorage.setItem('agent-tui-manager:favorite-workspaces:v1', JSON.stringify([favorite]))
    rememberRecentWorkspace('C:\\synthetic\\recent', 'win32')
    expect(readFavoriteWorkspaces()).toEqual([favorite])
    expect(JSON.parse(localStorage.getItem(FAVORITE_WORKSPACES_KEY)!)).toEqual([favorite])
  })

  it('never turns a successful launch into a failure when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    expect(readRecentWorkspaces('win32')).toEqual([])
    expect(readFavoriteWorkspaces()).toEqual([])
    expect(() => rememberRecentWorkspace('C:\\synthetic\\running', 'win32')).not.toThrow()
  })
})

describe('workspace picker', () => {
  it('refreshes a mounted collapsed picker, selects immediately, and pins recent workspaces with editable names', () => {
    const onSelect = vi.fn()
    render(createElement(FavoriteWorkspaces, { workspace: '', disabled: false, onSelect }))
    act(() => { rememberRecentWorkspace('C:\\synthetic\\project', 'win32') })
    expect(screen.queryByRole('button', { name: '选择工作区 C:\\synthetic\\project' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开工作区列表' }))
    fireEvent.click(screen.getByRole('button', { name: '选择工作区 C:\\synthetic\\project' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('C:\\synthetic\\project')
    fireEvent.click(screen.getByRole('button', { name: '保留工作区 C:\\synthetic\\project' }))
    fireEvent.click(screen.getByRole('button', { name: '管理列表' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑工作区 project' }))
    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: 'Named synthetic project' } })
    fireEvent.click(screen.getByRole('button', { name: '保存工作区' }))
    expect(readFavoriteWorkspaces()[0]).toMatchObject({ name: 'Named synthetic project', path: 'C:\\synthetic\\project' })
    expect(screen.getByRole('button', { name: 'Named synthetic project' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除工作区 Named synthetic project' }))
    expect(readFavoriteWorkspaces()).toEqual([])
    expect(screen.getByRole('button', { name: '选择工作区 C:\\synthetic\\project' })).toBeInTheDocument()
  })

  it('does not record selection as a successful workspace launch', () => {
    localStorage.setItem(FAVORITE_WORKSPACES_KEY, JSON.stringify([{ id: 'f', name: 'Synthetic', path: 'C:\\synthetic\\favorite' }]))
    const onSelect = vi.fn()
    render(createElement(FavoriteWorkspaces, { workspace: '', disabled: false, onSelect }))
    fireEvent.click(screen.getByRole('button', { name: '展开工作区列表' }))
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(readRecentWorkspaces('win32')).toEqual([])
  })
})
