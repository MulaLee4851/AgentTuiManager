import { describe, expect, it } from 'vitest'

import { applyAgentLaunchProfile } from '../../electron/agent-launch-profile'
import type { StoredAgentConfig } from '../../electron/agent-configuration-store'

function profile(overrides: Partial<StoredAgentConfig> = {}): StoredAgentConfig {
  return {
    profileId: 'profile-1',
    source: 'custom',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'secret-key',
    model: 'model-x',
    extraArgs: ['--feature', 'enabled'],
    ...overrides,
  }
}

describe('applyAgentLaunchProfile', () => {
  it('reuses the global Codex provider without exposing the key in arguments', () => {
    const result = applyAgentLaunchProfile('codex', ['--no-alt-screen', 'resume', 'native-1'], profile(), { id: 'custom', configurable: true })
    expect(result.environment).toEqual({
      AGENT_TUI_MANAGER_CODEX_API_KEY: 'secret-key',
    })
    expect(result.args).toEqual([
      '--no-alt-screen',
      '--feature', 'enabled',
      '-c', 'model_provider=custom',
      '-c', 'model_providers.custom.base_url=https://gateway.example/v1',
      '-c', 'model_providers.custom.env_key=AGENT_TUI_MANAGER_CODEX_API_KEY',
      '-c', 'model_providers.custom.wire_api=responses',
      '-c', 'model_providers.custom.requires_openai_auth=false',
      '--model', 'model-x',
      'resume', 'native-1',
    ])
    expect(result.args.join(' ')).not.toContain('secret-key')
    expect(result.args.join(' ')).not.toContain('agent_tui_manager')
  })

  it('keeps user resume flags after the id while profile overrides stay before resume', () => {
    const result = applyAgentLaunchProfile(
      'codex',
      ['--no-alt-screen', 'resume', 'native-1', '--dangerously-bypass-approvals-and-sandbox'],
      profile({ baseUrl: undefined, apiKey: undefined, model: undefined, extraArgs: ['--search'] }),
    )
    expect(result.args).toEqual([
      '--no-alt-screen', '--search', 'resume', 'native-1', '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('uses the built-in OpenAI override without defining an unmergeable provider', () => {
    const result = applyAgentLaunchProfile('codex', [], profile(), { id: 'openai', configurable: false })
    expect(result.environment).toEqual({ OPENAI_API_KEY: 'secret-key' })
    expect(result.args).toContain('openai_base_url=https://gateway.example/v1')
    expect(result.args.join(' ')).not.toContain('model_providers.openai')
  })

  it('rejects unsafe overrides of other built-in Codex providers', () => {
    expect(() => applyAgentLaunchProfile('codex', [], profile(), { id: 'ollama', configurable: false }))
      .toThrow('不能安全覆盖独立 Base URL 或 API Key')
  })

  it('isolates a custom Claude gateway from user settings and conflicting auth', () => {
    const result = applyAgentLaunchProfile('claude', ['--resume', 'native-1'], profile())
    expect(result.environment).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
      ANTHROPIC_AUTH_TOKEN: 'secret-key',
      ANTHROPIC_API_KEY: '',
    })
    expect(result.args).toEqual(['--feature', 'enabled', '--model', 'model-x', '--resume', 'native-1'])
  })

  it('uses x-api-key only for the official Anthropic endpoint', () => {
    const result = applyAgentLaunchProfile('claude', [], profile({ baseUrl: 'https://api.anthropic.com' }))
    expect(result.environment).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: 'secret-key',
    })
  })

  it('uses generic OpenAI-compatible environment variables and appends custom args', () => {
    const result = applyAgentLaunchProfile('generic', ['/d'], profile())
    expect(result.environment).toMatchObject({
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'secret-key',
      OPENAI_MODEL: 'model-x',
    })
    expect(result.args).toEqual(['/d', '--feature', 'enabled'])
  })

  it('uses DeepSeek Harness official environment variables without inventing a model flag', () => {
    const result = applyAgentLaunchProfile('deepseek', ['web', '--port', '0'], profile())
    expect(result.environment).toEqual({
      DEEPSEEK_BASE_URL: 'https://gateway.example/v1',
      DEEPSEEK_API_KEY: 'secret-key',
    })
    expect(result.args).toEqual(['web', '--port', '0', '--feature', 'enabled'])
    expect(result.args).not.toContain('model-x')
  })
})
