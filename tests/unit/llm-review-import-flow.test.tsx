// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LlmReviewSettingsDialog from '../../src/LlmReviewSettingsDialog'
import { LlmReviewSettingsStore } from '../../electron/llm-review-settings-store'
import { importLlmReviewer } from '../../electron/llm-reviewer-import'
import { parseCCSwitchProvider } from '../../electron/ccswitch-provider-reader'
import { listLlmReviewModels } from '../../electron/llm-model-catalog'
import { LlmSecurityReviewer } from '../../electron/llm-security-reviewer'
import type { AgentManagerApi, LlmReviewSettingsInput } from '../../src/shared/manager-api'

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }))
// Synthetic encryption and credentials only; no user configuration or network access.
const codec = { isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text).map(byte => byte ^ 0x4f),
  decryptString: (bytes: Buffer) => Buffer.from(bytes).map(byte => byte ^ 0x4f).toString() }
let store: LlmReviewSettingsStore
let path: string
let api: AgentManagerApi
const importedKey = 'fictional-import-flow-credential'

beforeEach(async () => {
  vi.resetAllMocks()
  path = join(await mkdtemp(join(tmpdir(), 'review-import-flow-')), 'settings.json')
  store = await LlmReviewSettingsStore.load(path, codec)
  const provider = parseCCSwitchProvider({ id: 'fixture-provider', appType: 'codex', name: 'Imported Gateway', isCurrent: true,
    settingsConfig: JSON.stringify({ auth: { OPENAI_API_KEY: importedKey }, config: "model_provider='fixture'\n[model_providers.fixture]\nbase_url='https://fixture.example/v1'\nwire_api='chat'" }) })
  const reader = { import: vi.fn(), importForReview: vi.fn(async () => ({ name: provider.name, enabled: false, backend: 'api' as const,
    protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model })) }
  vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'fixture-review-model' }] } })
  vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] } })
  api = {
    getLlmReviewSettings: vi.fn(async () => store.getSummary()),
    updateLlmReviewSettings: vi.fn((input: LlmReviewSettingsInput) => store.update(input)),
    reviewApprovalRules: vi.fn(async () => ({ status: 'idle' })),
    listCCSwitchProviders: vi.fn(async () => [{ id: provider.id, name: provider.name, agentKind: 'codex', isCurrent: true, hasApiKey: true, baseUrl: provider.baseUrl }]),
    importLlmReviewer: vi.fn(input => importLlmReviewer(input, reader, store)),
    listLlmReviewModels: vi.fn((input, id) => listLlmReviewModels(store.preview(input!, id))),
    testLlmReviewer: vi.fn((input, id) => new LlmSecurityReviewer().testConnection(store.preview(input, id))),
  } as unknown as AgentManagerApi
  window.agentManager = api
})
afterEach(cleanup)
async function open() {
  render(<LlmReviewSettingsDialog onClose={() => {}} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled())
}
async function importConnection() {
  fireEvent.click(screen.getByRole('button', { name: '从 CC Switch 导入' }))
  fireEvent.click(await screen.findByRole('button', { name: /Imported Gateway/ }))
  fireEvent.click(screen.getByRole('button', { name: '导入所选配置' }))
  await screen.findByRole('checkbox', { name: '启用 Imported Gateway' })
}
async function chooseModel() {
  fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
  await screen.findByRole('option', { name: 'fixture-review-model' })
  fireEvent.change(screen.getByLabelText('审核模型'), { target: { value: 'fixture-review-model' } })
}

describe('CC Switch import through the real encrypted settings store', () => {
  it('imports into an enabled empty draft, fetches models, saves and reloads without re-entering the key', async () => {
    await open()
    fireEvent.click(screen.getByRole('switch', { name: /启用审核器/ }))
    await importConnection()
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: /启用审核器/ })).toBeChecked()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    await screen.findByText('API Key 已安全保存，无需重新填写。')
    await chooseModel()
    expect(axios.get).toHaveBeenCalledWith('https://fixture.example/v1/models', expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${importedKey}` }) }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText('连接正常 · fixture-review-model')
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 Imported Gateway' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(store.getSummary().enabled).toBe(true))
    expect(store.getSummary().reviewers).toEqual([expect.objectContaining({ hasApiKey: true, enabled: true, model: 'fixture-review-model' })])
    expect(JSON.stringify(store.getSummary())).not.toContain(importedKey)
    expect(await readFile(path, 'utf8')).not.toContain(importedKey)
    cleanup()
    store = await LlmReviewSettingsStore.load(path, codec)
    await open()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    await screen.findByText('API Key 已安全保存，无需重新填写。')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText('连接正常 · fixture-review-model')
  })

  it('does not let a newly added blank reviewer block the final save of an imported reviewer', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '添加审核器' }))
    expect(screen.getByRole('checkbox', { name: '启用 审核器 1' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: /启用审核器/ }))
    await importConnection()
    await chooseModel()
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 Imported Gateway' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(store.getSummary().enabled).toBe(true))
    expect(store.getSummary().reviewers).toHaveLength(2)
    expect(store.getSummary().reviewers?.[0]).toMatchObject({ enabled: false, hasApiKey: false })
    expect(store.getSummary().reviewers?.[1]).toMatchObject({ enabled: true, hasApiKey: true })
  })

  it('identifies the actual incomplete enabled entry and does not report the imported saved key missing', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '添加审核器' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 审核器 1' }))
    fireEvent.click(screen.getByRole('switch', { name: /启用审核器/ }))
    await importConnection()
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 Imported Gateway' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await screen.findByText(/第 1 个审核器缺少 Base URL、API Key、Model；第 2 个审核器缺少 Model。/)
    expect(store.getSummary().enabled).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 审核器 1' }))
    await chooseModel()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(store.getSummary().enabled).toBe(true))
  })

  it('retains draft edits and selection when importing fails', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '添加审核器' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fictional-unsaved-draft' } })
    vi.mocked(api.importLlmReviewer).mockRejectedValue(new Error('导入失败'))
    fireEvent.click(screen.getByRole('button', { name: '从 CC Switch 导入' }))
    fireEvent.click(await screen.findByRole('button', { name: /Imported Gateway/ }))
    fireEvent.click(screen.getByRole('button', { name: '导入所选配置' }))
    await screen.findByText('导入失败')
    expect(screen.getByLabelText('API Key')).toHaveValue('fictional-unsaved-draft')
    expect(api.updateLlmReviewSettings).not.toHaveBeenCalled()
    expect(store.getSummary().reviewers).toEqual([])
  })
})
