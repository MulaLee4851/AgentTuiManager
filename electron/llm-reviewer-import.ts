import type { LlmReviewerImportInput, LlmReviewSettingsSummary } from '../src/shared/manager-api'
import type { CCSwitchProviderReader } from './ccswitch-provider-reader'
import type { LlmReviewSettingsStore } from './llm-review-settings-store'

/** The renderer supplies identity only. Never return the imported credential-bearing object. */
export async function importLlmReviewer(
  input: LlmReviewerImportInput, reader: Pick<CCSwitchProviderReader, 'import'> & Partial<Pick<CCSwitchProviderReader, 'importForReview'>>, store: LlmReviewSettingsStore,
): Promise<LlmReviewSettingsSummary> {
  if (!input || !['codex', 'claude'].includes(input.agentKind) || typeof input.providerId !== 'string'
    || !input.providerId.trim() || input.providerId.length > 200 || /[\x00-\x1f]/.test(input.providerId)) throw new Error('CC Switch Provider 选择无效')
  let config
  try {
    if (reader.importForReview) return await store.importReviewer(await reader.importForReview(input.agentKind, input.providerId))
    config = await reader.import(input.agentKind, input.providerId)
  }
  catch { throw new Error('无法导入所选 CC Switch Provider；请刷新列表并检查服务地址和 API Key 配置') }
  return store.importReviewer({
    name: config.providerName?.trim().slice(0, 100) || 'CC Switch 审核器', enabled: false, backend: 'api',
    protocol: input.agentKind === 'claude' ? 'anthropic-messages' : 'openai-responses',
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
  })
}
