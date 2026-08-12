import { describe, expect, it } from 'vitest'

import { parseCodexGlobalProvider } from '../../electron/codex-global-config'

describe('Codex global configuration', () => {
  it('reads the existing provider id without exposing or changing other settings', () => {
    expect(parseCodexGlobalProvider(`
model_provider = 'custom'
model = 'gpt-5.6-sol'

[model_providers.custom]
base_url = 'http://127.0.0.1:1024/v1'
experimental_bearer_token = 'PROXY_MANAGED'
`)).toEqual({ id: 'custom', configurable: true })
  })

  it('uses the built-in openai provider when the user did not select one', () => {
    expect(parseCodexGlobalProvider("model = 'gpt-5.6-sol'")).toEqual({ id: 'openai', configurable: false })
  })
})
