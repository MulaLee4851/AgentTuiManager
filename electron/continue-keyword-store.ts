import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ContinueKeywordSettings } from '../src/shared/manager-api'

interface StoredContinueKeywordSettings {
  version: 1
  enabled: boolean
  quietSeconds: number
  keywords: string[]
}

const DEFAULT_SETTINGS: ContinueKeywordSettings = { enabled: false, quietSeconds: 10, keywords: [] }
function normalizeForMatch(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
}
const MAX_KEYWORDS = 50
const MAX_KEYWORD_LENGTH = 200
const MAX_FILE_BYTES = 128 * 1024

export function normalizeContinueKeyword(value: string): string | undefined {
  if (!value || value.length > MAX_KEYWORD_LENGTH || value.includes('\0') || /[\r\n]/.test(value)) return undefined
  const normalized = value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  return normalized || undefined
}

function normalizedSettings(value: unknown): ContinueKeywordSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS, keywords: [] }
  const input = value as Record<string, unknown>
  const quietSeconds = Number.isInteger(input.quietSeconds) && Number(input.quietSeconds) >= 3 && Number(input.quietSeconds) <= 60
    ? Number(input.quietSeconds)
    : DEFAULT_SETTINGS.quietSeconds
  const keywords = Array.isArray(input.keywords)
    ? [...new Set(input.keywords
      .slice(0, MAX_KEYWORDS)
      .map((keyword) => normalizeContinueKeyword(typeof keyword === 'string' ? keyword : ''))
      .filter((keyword): keyword is string => Boolean(keyword)))]
    : []
  return { enabled: input.enabled === true, quietSeconds, keywords }
}

export class ContinueKeywordStore {
  private settings: ContinueKeywordSettings

  private constructor(private readonly path: string, settings: ContinueKeywordSettings) {
    this.settings = { ...settings, keywords: [...settings.keywords] }
  }

  static async load(path: string): Promise<ContinueKeywordStore> {
    let settings: ContinueKeywordSettings = { ...DEFAULT_SETTINGS, keywords: [] }
    try {
      const content = await readFile(path, 'utf8')
      if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) settings = normalizedSettings(JSON.parse(content))
    } catch {
      // Missing or damaged settings never prevent native Agents from starting.
    }
    return new ContinueKeywordStore(path, settings)
  }

  getSettings(): ContinueKeywordSettings {
    return { ...this.settings, keywords: [...this.settings.keywords] }
  }

  match(value: string): string | undefined {
    if (!this.settings.enabled || this.settings.keywords.length === 0) return undefined
    return this.settings.keywords.find((keyword) => normalizeForMatch(value).includes(keyword))
  }

  // Only return a match whose occurrence intersects the newly received chunk.
  // This prevents a keyword left in the rolling tail from being re-triggered by
  // an unrelated redraw or a later output chunk.
  matchIncremental(previous: string, current: string): string | undefined {
    if (!this.settings.enabled || this.settings.keywords.length === 0) return undefined
    const previousNormalized = normalizeForMatch(previous)
    const currentNormalized = normalizeForMatch(current)
    const combined = previousNormalized + currentNormalized
    return this.settings.keywords.find((keyword) => {
      let start = combined.indexOf(keyword)
      while (start >= 0) {
        const end = start + keyword.length
        if (start >= previousNormalized.length || end > previousNormalized.length) return true
        start = combined.indexOf(keyword, start + 1)
      }
      return false
    })
  }

  maxKeywordLength(): number {
    return Math.max(1, ...this.settings.keywords.map((keyword) => keyword.length))
  }

  async update(value: ContinueKeywordSettings): Promise<ContinueKeywordSettings> {
    const settings = normalizedSettings(value)
    if (value.enabled && settings.keywords.length === 0) throw new Error('开启关键词 Continue 前，请至少添加一个关键词')
    if (Array.isArray(value.keywords) && value.keywords.length > MAX_KEYWORDS) throw new Error(`关键词最多保存 ${MAX_KEYWORDS} 条`)
    this.settings = settings
    await this.persist()
    return this.getSettings()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const payload: StoredContinueKeywordSettings = { version: 1, ...this.settings, keywords: [...this.settings.keywords] }
      await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
