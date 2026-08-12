import { describe, expect, it } from 'vitest'

import { parseCCSwitchProvider, type CCSwitchProviderRow } from '../../electron/ccswitch-provider-reader'

function row(overrides: Partial<CCSwitchProviderRow> = {}): CCSwitchProviderRow {
  return {
    id: 'provider-1',
    appType: 'codex',
    name: 'Provider One',
    settingsConfig: '{}',
    isCurrent: true,
    ...overrides,
  }
}

describe('CCSwitch provider parsing', () => {
  it('parses Codex auth and the selected TOML provider without assuming its id', () => {
    const provider = parseCCSwitchProvider(row({
      settingsConfig: JSON.stringify({
        auth: { OPENAI_API_KEY: 'codex-secret' },
        config: `model_provider = 'my_gateway'\nmodel = 'gpt-5.6'\n[model_providers.my_gateway]\nbase_url = 'https://codex.example/v1'`,
      }),
    }))
    expect(provider).toMatchObject({
      id: 'provider-1',
      baseUrl: 'https://codex.example/v1',
      model: 'gpt-5.6',
      hasApiKey: true,
      apiKey: 'codex-secret',
    })
    expect(provider.issue).toBeUndefined()
  })

  it('parses Claude custom gateway variables used by CCSwitch', () => {
    const provider = parseCCSwitchProvider(row({
      appType: 'claude',
      settingsConfig: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'claude-secret',
          ANTHROPIC_BASE_URL: 'https://claude.example',
          ANTHROPIC_MODEL: 'claude-opus-4-1',
        },
      }),
    }))
    expect(provider).toMatchObject({
      baseUrl: 'https://claude.example',
      model: 'claude-opus-4-1',
      hasApiKey: true,
      apiKey: 'claude-secret',
    })
  })

  it('returns an unusable summary instead of exposing malformed provider content', () => {
    const provider = parseCCSwitchProvider(row({ settingsConfig: '{broken' }))
    expect(provider.hasApiKey).toBe(false)
    expect(provider.issue).toContain('Provider 配置无法解析')
    expect(JSON.stringify(provider)).not.toContain('{broken')
  })
})
