import {
  LlmModelCatalogError,
  llmApiHeaders,
  protectedLlmApiValues,
  requestLlmModels,
  resolveLlmApiEndpoint,
  safeLlmApiError,
} from './llm-model-catalog'

export function modelsEndpoint(baseUrl: string): string {
  return resolveLlmApiEndpoint(baseUrl, 'models')
}

export async function fetchProviderModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const endpoint = modelsEndpoint(baseUrl)
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new LlmModelCatalogError('configuration')
    const headers = apiKey?.trim() ? llmApiHeaders({ apiKey }) : { Accept: 'application/json' }
    const models = await requestLlmModels(endpoint, {
      headers, timeout: 15_000, secrets: protectedLlmApiValues({ apiKey }),
    })
    if (!models.length) throw new LlmModelCatalogError('invalid-response')
    return models.sort()
  } catch (error) {
    throw safeLlmApiError(error)
  }
}
