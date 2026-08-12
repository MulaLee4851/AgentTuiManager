import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parse as parseToml } from 'smol-toml'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export interface CodexGlobalProvider {
  id: string
  configurable: boolean
}

export function parseCodexGlobalProvider(configText: string): CodexGlobalProvider {
  const config = object(parseToml(configText)) ?? {}
  const id = nonEmpty(config.model_provider) ?? 'openai'
  const providers = object(config.model_providers) ?? {}
  return { id, configurable: object(providers[id]) !== undefined }
}

export async function readCodexGlobalProvider(
  configPath = join(homedir(), '.codex', 'config.toml'),
): Promise<CodexGlobalProvider> {
  try {
    return parseCodexGlobalProvider(await readFile(configPath, 'utf8'))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { id: 'openai', configurable: false }
    throw new Error(`无法读取本机 Codex 配置：${error instanceof Error ? error.message : String(error)}`)
  }
}
