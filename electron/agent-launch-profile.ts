import type { AgentKind } from '../src/shared/manager-api'
import type { StoredAgentConfig } from './agent-configuration-store'
import type { CodexGlobalProvider } from './codex-global-config'

export interface AgentLaunchOverrides {
  environment: Record<string, string>
  args: string[]
}

const CODEX_API_KEY_ENV = 'AGENT_TUI_MANAGER_CODEX_API_KEY'

function providerPathSegment(providerId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(providerId) ? providerId : JSON.stringify(providerId)
}

function codexProviderArguments(profile: StoredAgentConfig, provider: CodexGlobalProvider): string[] {
  if (!profile.baseUrl && !profile.apiKey) return []
  if (provider.id === 'openai' && !provider.configurable) {
    return [
      '-c', 'model_provider=openai',
      ...(profile.baseUrl ? ['-c', `openai_base_url=${profile.baseUrl}`] : []),
    ]
  }
  if (!provider.configurable) {
    throw new Error(`本机 Codex Provider “${provider.id}”是内置项，不能安全覆盖独立 Base URL 或 API Key。请先在 Codex 配置中选择一个命名的自定义 Provider。`)
  }
  const path = `model_providers.${providerPathSegment(provider.id)}`
  return [
    '-c', `model_provider=${provider.id}`,
    ...(profile.baseUrl ? ['-c', `${path}.base_url=${profile.baseUrl}`] : []),
    ...(profile.apiKey ? ['-c', `${path}.env_key=${CODEX_API_KEY_ENV}`] : []),
    '-c', `${path}.wire_api=responses`,
    '-c', `${path}.requires_openai_auth=false`,
  ]
}

function withoutModelArgument(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value === '--model' || value === '-m') {
      index += 1
      continue
    }
    if (value.startsWith('--model=')) continue
    result.push(value)
  }
  return result
}

function configuredArgs(agentKind: AgentKind, baseArgs: string[], profile: StoredAgentConfig, codexProvider: CodexGlobalProvider): string[] {
  const args = profile.model && (agentKind === 'codex' || agentKind === 'claude')
    ? withoutModelArgument(baseArgs)
    : [...baseArgs]
  const overrides = [
    ...profile.extraArgs,
    ...(agentKind === 'codex' ? codexProviderArguments(profile, codexProvider) : []),
    ...(profile.model && (agentKind === 'codex' || agentKind === 'claude') ? ['--model', profile.model] : []),
  ]
  if (overrides.length === 0) return args
  if (agentKind === 'codex') {
    const resumeIndex = args.indexOf('resume')
    const insertion = resumeIndex >= 0 ? resumeIndex : args.length
    return [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
  }
  if (agentKind === 'claude') {
    const resumeIndex = args.findIndex((value) => value === '--resume' || value.startsWith('--resume='))
    const insertion = resumeIndex >= 0 ? resumeIndex : args.length
    return [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
  }
  return [...args, ...overrides]
}

export function applyAgentLaunchProfile(
  agentKind: AgentKind,
  baseArgs: string[],
  profile: StoredAgentConfig,
  codexProvider: CodexGlobalProvider = { id: 'openai', configurable: false },
): AgentLaunchOverrides {
  const environment: Record<string, string> = {}
  if (agentKind === 'claude') {
    // Claude Code can load provider-routing variables from ~/.claude/settings.json
    // after process startup. Its host-managed mode prevents those settings from
    // replacing this one PTY's explicit provider without modifying the file.
    if (profile.baseUrl || profile.apiKey) {
      environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      environment.CLAUDE_CODE_USE_BEDROCK = ''
      environment.CLAUDE_CODE_USE_VERTEX = ''
      environment.CLAUDE_CODE_USE_FOUNDRY = ''
      environment.CLAUDE_CODE_OAUTH_TOKEN = ''
    }
    if (profile.baseUrl) environment.ANTHROPIC_BASE_URL = profile.baseUrl
    if (profile.apiKey) {
      const officialAnthropic = !profile.baseUrl || (() => {
        try { return new URL(profile.baseUrl).hostname.toLowerCase() === 'api.anthropic.com' } catch { return false }
      })()
      // Custom Claude gateways (including the common CCSwitch layout) use an
      // Authorization token. The official Anthropic endpoint uses x-api-key.
      environment.ANTHROPIC_AUTH_TOKEN = officialAnthropic ? '' : profile.apiKey
      environment.ANTHROPIC_API_KEY = officialAnthropic ? profile.apiKey : ''
    }
  } else if (agentKind === 'codex') {
    // Codex selects its endpoint from model_provider, not OPENAI_BASE_URL when
    // config.toml already names a custom provider. The temporary -c overrides
    // above select a per-process provider; only its env_key carries the secret.
    if (profile.apiKey) {
      environment[codexProvider.id === 'openai' && !codexProvider.configurable ? 'OPENAI_API_KEY' : CODEX_API_KEY_ENV] = profile.apiKey
    }
  } else {
    if (profile.baseUrl) environment.OPENAI_BASE_URL = profile.baseUrl
    if (profile.apiKey) environment.OPENAI_API_KEY = profile.apiKey
    if (profile.model) environment.OPENAI_MODEL = profile.model
  }
  return { environment, args: configuredArgs(agentKind, baseArgs, profile, codexProvider) }
}
