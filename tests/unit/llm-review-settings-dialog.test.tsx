// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LlmReviewSettingsDialog from '../../src/LlmReviewSettingsDialog'
import type { AgentManagerApi, LlmReviewSettingsSummary } from '../../src/shared/manager-api'

const initial: LlmReviewSettingsSummary = {enabled:false,backend:'api',level:'high',hasApiKey:false,retryCount:0,
  timeoutSeconds:30,scheduledRuleAuditEnabled:false,scheduledRuleAuditHours:24,proxyEnabled:false,
  proxyHost:'127.0.0.1',proxyPort:7897,hasProxyPassword:false,ruleAuditState:{status:'idle'}}
let api: Pick<AgentManagerApi,'getLlmReviewSettings'|'updateLlmReviewSettings'|'reviewApprovalRules'|'listLlmReviewModels'|'listApprovalRules'|'testLlmReviewer'|'importLlmReviewer'|'listCCSwitchProviders'>
beforeEach(()=>{
  api={getLlmReviewSettings:vi.fn(async()=>({...initial})),
    updateLlmReviewSettings:vi.fn(async input=>({...initial,...input,apiKey:undefined,proxyPassword:undefined,hasApiKey:Boolean(input.apiKey)})),
    reviewApprovalRules:vi.fn(async()=>({status:'running' as const,source:'manual' as const})),
    listLlmReviewModels:vi.fn(async()=>['review-a','review-b']),listApprovalRules:vi.fn(async()=>[]),
    testLlmReviewer:vi.fn(async()=>({model:'connection-model'})),
    importLlmReviewer:vi.fn(async()=>({...initial})),listCCSwitchProviders:vi.fn(async()=>[])}
  window.agentManager=api as AgentManagerApi
})

const pool: LlmReviewSettingsSummary = { ...initial, reviewers: [
  { id: 'A', name: 'Alpha', enabled: true, backend: 'api', protocol: 'openai-chat', baseUrl: 'https://alpha.example/v1', model: 'alpha-model', hasApiKey: true },
  { id: 'B', name: 'Beta', enabled: false, backend: 'claude-cli', cliModel: 'claude-fixture', hasApiKey: false },
] }

describe('reviewer pool settings form', () => {
  beforeEach(() => {
    vi.mocked(api.getLlmReviewSettings).mockResolvedValue(pool)
    vi.mocked(api.updateLlmReviewSettings).mockImplementation(async input => ({ ...initial, ...input, hasApiKey: true,
      reviewers: input.reviewers?.map(({ apiKey, clearApiKey: _clear, ...entry }) => ({ ...entry, hasApiKey: Boolean(apiKey) || entry.id === 'A' })),
    }))
  })
  it('preserves edits and new secrets per ID while selecting, renaming, disabling and reordering entries', async () => {
    await open()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('审核器名称'), { target: { value: 'Edited Alpha' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fictional-draft-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /2\. Beta/ }))
    expect(screen.getByLabelText('审核方式')).toHaveValue('claude-cli')
    fireEvent.change(screen.getByLabelText('审核模型（可选）'), { target: { value: 'updated-cli-model' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 Beta' }))
    fireEvent.click(screen.getByRole('button', { name: '上移 Beta' }))
    fireEvent.click(screen.getByRole('button', { name: /2\. Edited Alpha/ }))
    expect(screen.getByLabelText('API Key')).toHaveValue('fictional-draft-secret')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(api.updateLlmReviewSettings).toHaveBeenCalledOnce())
    expect(vi.mocked(api.updateLlmReviewSettings).mock.calls[0]?.[0].reviewers).toEqual([
      expect.objectContaining({ id: 'B', enabled: true, cliModel: 'updated-cli-model' }),
      expect.objectContaining({ id: 'A', name: 'Edited Alpha', apiKey: 'fictional-draft-secret' }),
    ])
    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue(''))
  })
  it('can add an entry and remove every entry from a disabled pool', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '添加审核器' }))
    expect(screen.getByLabelText('审核器名称')).toHaveValue('审核器 3')
    fireEvent.click(screen.getByRole('button', { name: '移除 审核器 3' }))
    fireEvent.click(screen.getByRole('button', { name: '移除 Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: '移除 Beta' }))
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({ reviewers: [] })))
  })
  it('passes the selected reviewer ID when fetching models and testing a connection', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
    await screen.findByRole('option', { name: 'review-a' })
    expect(api.listLlmReviewModels).toHaveBeenCalledWith(expect.objectContaining({ reviewers: expect.any(Array) }), 'A')
    fireEvent.click(screen.getByRole('button', { name: /2\. Beta/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText('连接正常 · connection-model')
    expect(api.testLlmReviewer).toHaveBeenCalledWith(expect.objectContaining({ reviewers: expect.any(Array) }), 'B')
  })
  it('imports only the searched Provider ID without saving or discarding other drafts', async () => {
    vi.mocked(api.listCCSwitchProviders).mockResolvedValue([
      { id: 'provider-selected', name: 'Chosen Gateway', agentKind: 'codex', isCurrent: false, hasApiKey: true, model: 'chosen-model' },
      { id: 'provider-other', name: 'Other Gateway', agentKind: 'codex', isCurrent: true, hasApiKey: true },
    ])
    vi.mocked(api.importLlmReviewer).mockResolvedValue({ ...pool, reviewers: [...pool.reviewers!, { id: 'imported', name: 'Chosen Gateway', enabled: false, backend: 'api', protocol: 'openai-responses', baseUrl: 'https://chosen.example', model: 'chosen-model', hasApiKey: true }] })
    await open()
    fireEvent.change(screen.getByLabelText('审核器名称'), { target: { value: 'Keep this edit' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fictional-unsaved-key' } })
    fireEvent.click(screen.getByRole('button', { name: '从 CC Switch 导入' }))
    await screen.findByRole('button', { name: /Chosen Gateway/ })
    fireEvent.change(screen.getByLabelText('搜索 CC Switch 配置'), { target: { value: 'chosen-model' } })
    expect(screen.queryByRole('button', { name: /Other Gateway/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Chosen Gateway/ }))
    fireEvent.click(screen.getByRole('button', { name: '导入所选配置' }))
    await waitFor(() => expect(api.importLlmReviewer).toHaveBeenCalledWith({ agentKind: 'codex', providerId: 'provider-selected' }))
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('API 协议')).toHaveValue('openai-responses'))
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: '启用 Chosen Gateway' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /1\. Keep this edit/ }))
    expect(screen.getByLabelText('API Key')).toHaveValue('fictional-unsaved-key')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({
      reviewers: expect.arrayContaining([expect.objectContaining({ id: 'A', name: 'Keep this edit', apiKey: 'fictional-unsaved-key' })]),
    })))
  })
})
afterEach(cleanup)
async function open(){render(<LlmReviewSettingsDialog onClose={()=>{}} />);await waitFor(()=>expect(screen.getByRole('button',{name:'保存设置'})).toBeEnabled())}
async function fill(){
  fireEvent.change(screen.getByLabelText('服务地址（Base URL）'),{target:{value:'https://fixture.example/v1'}})
  fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'fixture-key'}})
  fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
  await screen.findByRole('option',{name:'review-a'})
  fireEvent.change(screen.getByLabelText('审核模型'),{target:{value:'review-a'}})
}
describe('reviewer settings form',()=>{
  it('fetches and selects a model from the current draft without saving first',async()=>{
    await open();await fill()
    expect(api.listLlmReviewModels).toHaveBeenCalledWith(expect.objectContaining({baseUrl:'https://fixture.example/v1',apiKey:'fixture-key',model:undefined}))
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
    expect(screen.getByLabelText('审核模型')).toHaveValue('review-a')
  })
  it('saves the filled form before auditing instead of using the old empty configuration',async()=>{
    await open();await fill()
    let finish!: (value:LlmReviewSettingsSummary)=>void
    vi.mocked(api.updateLlmReviewSettings).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({apiKey:'fixture-key',model:'review-a'}))
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    await act(async()=>finish({...initial,model:'review-a',hasApiKey:true}))
    expect(api.reviewApprovalRules).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
  })
  it('does not audit or erase the typed key when saving fails',async()=>{
    await open();await fill()
    vi.mocked(api.updateLlmReviewSettings).mockRejectedValue(new Error('保存失败'))
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await screen.findByText('保存失败')
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    expect(screen.getByLabelText('API Key')).toHaveValue('fixture-key')
  })
  it('reuses a saved key without retrieving its value into the form',async()=>{
    vi.mocked(api.getLlmReviewSettings).mockResolvedValue({...initial,baseUrl:'https://fixture.example/v1',model:'review-a',hasApiKey:true})
    await open();fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
    await screen.findByRole('option',{name:'review-b'})
    expect(vi.mocked(api.listLlmReviewModels).mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await waitFor(()=>expect(api.reviewApprovalRules).toHaveBeenCalledOnce())
    expect(vi.mocked(api.updateLlmReviewSettings).mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
  })
  it('keeps manual model input available when the provider has no models endpoint',async()=>{
    vi.mocked(api.listLlmReviewModels).mockRejectedValue(new Error('服务不支持模型列表'))
    await open();fireEvent.click(screen.getByRole('button',{name:'获取模型'}))
    await screen.findByText(/服务不支持模型列表/)
    fireEvent.click(screen.getByRole('button',{name:'手动输入模型'}))
    fireEvent.change(screen.getByLabelText('审核模型'),{target:{value:'custom-reviewer'}})
    expect(screen.getByLabelText('审核模型')).toHaveValue('custom-reviewer')
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
  })
  it('shows which required fields are missing before attempting an audit',async()=>{
    await open();fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await screen.findByText('开始审查前，请填写或选择：服务地址、API Key、审核模型')
    expect(api.reviewApprovalRules).not.toHaveBeenCalled()
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
  })
  it('can save and audit CLI settings without API credentials',async()=>{
    await open();fireEvent.change(screen.getByLabelText('审核方式'),{target:{value:'codex-cli'}})
    fireEvent.click(screen.getByRole('button',{name:'保存并立即审查'}))
    await waitFor(()=>expect(api.reviewApprovalRules).toHaveBeenCalledOnce())
    expect(api.updateLlmReviewSettings).toHaveBeenCalledWith(expect.objectContaining({backend:'codex-cli'}))
  })
})
