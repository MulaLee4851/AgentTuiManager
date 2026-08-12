import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { environmentForAgent } from './agent-environment'

const OLD_PROVIDER_ID = 'agent_tui_manager'
const MAX_FILES = 20_000

interface JsonRecord {
  payload?: {
    type?: unknown
    thread_settings?: {
      model_provider_id?: unknown
    }
  }
}

export interface CodexSessionProviderMigration {
  changed: boolean
  path?: string
}

export interface CodexOfficialMigrationOptions {
  executable: string
  sessionId: string
  providerId: string
  cwd?: string
  timeoutMs?: number
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n'
}

/** Ask Codex itself to reconcile its SQLite thread projection with the global Provider. */
export async function migrateCodexProviderOfficial(options: CodexOfficialMigrationOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, ['app-server', '--stdio'], {
      cwd: options.cwd,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.executable),
      env: environmentForAgent('codex'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffer = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error, provider?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdin.end()
      if (child.exitCode === null && !child.killed) child.kill()
      if (error) reject(error)
      else resolve(provider ?? options.providerId)
    }
    timer = setTimeout(() => finish(new Error('Codex Provider 官方迁移超时')), timeoutMs)
    child.once('error', (error) => finish(new Error(`无法启动 Codex 官方迁移：${error.message}`)))
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex 官方迁移提前退出（${code ?? 'unknown'}）：${stderr.trim() || '没有错误输出'}`))
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000) })
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let message: any
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 0) {
          child.stdin.write(jsonLine({ method: 'initialized' }))
          child.stdin.write(jsonLine({ method: 'thread/resume', id: 1, params: { threadId: options.sessionId, modelProvider: options.providerId, excludeTurns: true } }))
        } else if (message.id === 1) {
          if (message.error) finish(new Error(`Codex 官方迁移失败：${message.error.message ?? JSON.stringify(message.error)}`))
          else finish(undefined, message.result?.modelProvider ?? options.providerId)
        }
      }
    })
  })
}

async function findSessionFile(root: string, sessionId: string): Promise<string | undefined> {
  const pending = [root]
  let visited = 0
  while (pending.length > 0 && visited < MAX_FILES) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_FILES) break
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && basename(path).includes(sessionId) && path.endsWith('.jsonl')) return path
    }
  }
  return undefined
}

function readProviderId(record: JsonRecord): string | undefined {
  if (record.payload?.type !== 'thread_settings_applied') return undefined
  const value = record.payload.thread_settings?.model_provider_id
  return typeof value === 'string' ? value : undefined
}

export async function migrateCodexSessionProvider(
  sessionId: string | undefined,
  providerId: string,
  sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
): Promise<CodexSessionProviderMigration> {
  if (!sessionId || !/^[a-zA-Z0-9-]{8,128}$/.test(sessionId) || !providerId || providerId === OLD_PROVIDER_ID) return { changed: false }
  const path = await findSessionFile(sessionsRoot, sessionId)
  if (!path) return { changed: false }
  const source = await readFile(path, 'utf8')
  const lines = source.split(/(?<=\n)/)
  const parsed = lines.map((line) => {
    const newline = line.endsWith('\n') ? '\n' : ''
    const body = newline ? line.slice(0, -1) : line
    try { return { line, newline, value: JSON.parse(body) as JsonRecord } } catch { return { line, newline } }
  })
  const lastProviderIndex = parsed.reduce<number | undefined>((last, item, index) => readProviderId(item.value ?? {}) ? index : last, undefined)
  if (lastProviderIndex === undefined || readProviderId(parsed[lastProviderIndex]!.value ?? {}) !== OLD_PROVIDER_ID) return { changed: false, path }
  const migrated = parsed.map((item, index) => {
    if (index !== lastProviderIndex || !item.value?.payload?.thread_settings) return item.line
    item.value.payload.thread_settings.model_provider_id = providerId
    return JSON.stringify(item.value) + item.newline
  })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const metadata = await stat(path)
  try {
    await writeFile(temporary, migrated.join(''), 'utf8')
    await chmod(temporary, metadata.mode)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw new Error(`无法修复 Codex 会话 Provider：${error instanceof Error ? error.message : String(error)}`)
  }
  return { changed: true, path }
}
