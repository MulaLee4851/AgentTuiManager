// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FavoriteWorkspaces, { FAVORITE_WORKSPACES_KEY, isAbsoluteWorkspace } from '../../src/FavoriteWorkspaces'
import CCSwitchProviderList from '../../src/CCSwitchProviderList'
import type { AgentManagerApi } from '../../src/shared/manager-api'

beforeEach(() => {
  localStorage.clear()
  window.agentManager = { platform: 'win32', chooseWorkspace: vi.fn(async () => 'G:\\projects\\chart') } as unknown as AgentManagerApi
})
afterEach(cleanup)

describe('favorite workspaces', () => {
  it('persists named shortcuts, selects in one click, edits and removes records without filesystem operations', () => {
    const onSelect = vi.fn()
    const view = render(<FavoriteWorkspaces workspace='' disabled={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: '管理列表' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '图表项目' } })
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: 'G:\\projects\\chart' } })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    view.unmount()
    render(<FavoriteWorkspaces workspace='' disabled={false} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: '展开工作区列表' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '图表项目' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开工作区列表' }))
    fireEvent.click(screen.getByRole('button', { name: '图表项目' }))
    expect(onSelect).toHaveBeenCalledWith('G:\\projects\\chart')
    expect(window.agentManager.chooseWorkspace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '管理列表' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑工作区 图表项目' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '新版图表' } })
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: 'G:\\projects\\chart-next' } })
    fireEvent.click(screen.getByRole('button', { name: '保存工作区' }))
    expect(JSON.parse(localStorage.getItem(FAVORITE_WORKSPACES_KEY)!)[0]).toMatchObject({ name: '新版图表', path: 'G:\\projects\\chart-next' })
    fireEvent.click(screen.getByRole('button', { name: '移除工作区 新版图表' }))
    expect(JSON.parse(localStorage.getItem(FAVORITE_WORKSPACES_KEY)!)).toEqual([])
  })
  it('rejects relative paths and recovers from invalid persisted data', () => {
    localStorage.setItem(FAVORITE_WORKSPACES_KEY, '{invalid')
    render(<FavoriteWorkspaces workspace='' disabled={false} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '管理列表' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '相对目录' } })
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '..\\parent' } })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    expect(screen.getByRole('alert')).toHaveTextContent('完整工作区路径')
    expect(isAbsoluteWorkspace('C:relative', 'win32')).toBe(false)
    expect(isAbsoluteWorkspace('\\\\server\\share\\project', 'win32')).toBe(true)
    expect(isAbsoluteWorkspace('/home/project', 'linux')).toBe(true)
  })
})

describe('searchable provider picker', () => {
  it('filters names, addresses and models while retaining a selected provider outside the results', () => {
    const providers = [{ id: 'a', name: '常用服务', agentKind: 'codex' as const, baseUrl: 'https://alpha.example/v1', model: 'review-large', isCurrent: true, hasApiKey: true }, { id: 'b', name: '备用服务', agentKind: 'codex' as const, baseUrl: 'https://beta.example/v1', model: 'review-small', isCurrent: false, hasApiKey: true }]
    const onSelect = vi.fn()
    render(<CCSwitchProviderList providers={providers} selectedId='a' loading={false} error='' disabled={false} onSelect={onSelect} onRefresh={vi.fn()} />)
    const search = screen.getByRole('searchbox', { name: '搜索 CC Switch 配置' })
    fireEvent.change(search, { target: { value: 'BETA.example' } })
    expect(screen.getByRole('status')).toHaveTextContent('找到 1 / 2 个配置 · 已选择：常用服务')
    fireEvent.click(screen.getByRole('button', { name: /备用服务/ }))
    expect(onSelect).toHaveBeenCalledWith(providers[1])
    fireEvent.change(search, { target: { value: 'review-large' } })
    expect(screen.getByRole('button', { name: /常用服务/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的配置，请尝试其他关键词')).toBeVisible()
  })
})
