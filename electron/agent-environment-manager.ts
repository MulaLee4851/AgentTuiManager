import { execFile as execFileCallback, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { AgentKind, AgentEnvironmentSummary, NpmRegistryChoice } from '../src/shared/manager-api'
import { resolveExecutableForPty } from './executable-resolution'
import { environmentWithFreshWindowsPath, pathFromEnvironment } from './windows-environment'

const execFile = promisify(execFileCallback)

type ExecOptions = {
  timeout: number
  windowsHide: boolean
  maxBuffer: number
  env?: NodeJS.ProcessEnv
}

async function executeFile(candidate: string, args: string[], options: ExecOptions) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate)) {
    const commandProcessor = process.env.ComSpec || 'cmd.exe'
    // Pass the script and every argument separately. execFile handles Windows
    // quoting for us; embedding quotes in one /c string makes cmd.exe look for
    // a command whose name literally contains quote characters.
    return execFile(commandProcessor, ['/d', '/c', 'call', candidate, ...args], options)
  }
  return execFile(candidate, args, options)
}

const AGENT_PACKAGES: Partial<Record<AgentKind, string>> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  // The original @mariozechner scope is deprecated. legacy-node20 is the
  // maintained package's official compatibility tag for Node 20 and early
  // Node 22 releases; its CLI entry is still `pi`.
  pi: '@earendil-works/pi-coding-agent@legacy-node20',
}

const AGENT_INSTALL_TIMEOUT_MS = 10 * 60_000

const NPM_REGISTRIES: Record<Exclude<NpmRegistryChoice, 'configured'>, string> = {
  official: 'https://registry.npmjs.org/',
  npmmirror: 'https://registry.npmmirror.com/',
  tencent: 'https://mirrors.cloud.tencent.com/npm/',
  huawei: 'https://repo.huaweicloud.com/repository/npm/',
}

export function registryUrl(choice: NpmRegistryChoice): string | undefined {
  return choice === 'configured' ? undefined : NPM_REGISTRIES[choice]
}

export interface AgentInstallProgressUpdate {
  phase: 'starting' | 'running' | 'completed' | 'failed'
  elapsedMs: number
  message?: string
  level?: 'info' | 'warning' | 'error'
}

type ProgressListener = (update: AgentInstallProgressUpdate) => void

function progressLevel(message: string): 'info' | 'warning' | 'error' {
  if (/\b(?:npm\s+)?(?:err!|error)\b/i.test(message)) return 'error'
  if (/\bwarn(?:ing)?\b|deprecated/i.test(message)) return 'warning'
  return 'info'
}

async function runInstaller(candidate: string, args: string[], timeout: number, onProgress?: ProgressListener): Promise<void> {
  const startedAt = Date.now()
  const isCommandScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate)
  const executable = isCommandScript ? process.env.ComSpec || 'cmd.exe' : candidate
  const executableArgs = isCommandScript ? ['/d', '/c', 'call', candidate, ...args] : args
  onProgress?.({ phase: 'starting', elapsedMs: 0, message: '正在准备安装…', level: 'info' })

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, executableArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let trailing = ''
    let lastOutput = ''
    let timedOut = false
    const publish = (chunk: Buffer | string): void => {
      trailing += chunk.toString()
      const lines = trailing.split(/\r?\n/)
      trailing = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim().slice(0, 500)
        if (!line) continue
        lastOutput = line
        onProgress?.({ phase: 'running', elapsedMs: Date.now() - startedAt, message: line, level: progressLevel(line) })
      }
    }
    child.stdout?.on('data', publish)
    child.stderr?.on('data', publish)
    const heartbeat = setInterval(() => {
      onProgress?.({ phase: 'running', elapsedMs: Date.now() - startedAt })
    }, 1_000)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    child.once('error', (error) => {
      clearInterval(heartbeat); clearTimeout(timer)
      onProgress?.({ phase: 'failed', elapsedMs: Date.now() - startedAt, message: error.message, level: 'error' })
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearInterval(heartbeat); clearTimeout(timer)
      const finalLine = trailing.trim().slice(0, 500)
      if (finalLine) {
        lastOutput = finalLine
        onProgress?.({ phase: 'running', elapsedMs: Date.now() - startedAt, message: finalLine, level: progressLevel(finalLine) })
      }
      if (timedOut) {
        const error = Object.assign(new Error('安装超时'), { code: 'INSTALL_TIMEOUT' })
        onProgress?.({ phase: 'failed', elapsedMs: Date.now() - startedAt, message: '安装超过等待上限', level: 'error' })
        reject(error)
      } else if (code === 0) {
        onProgress?.({ phase: 'completed', elapsedMs: Date.now() - startedAt, message: '安装完成', level: 'info' })
        resolve()
      } else {
        const error = Object.assign(new Error(lastOutput || `安装进程退出（代码 ${code ?? signal ?? 'unknown'}）`), { code, signal })
        onProgress?.({ phase: 'failed', elapsedMs: Date.now() - startedAt, message: error.message, level: 'error' })
        reject(error)
      }
    })
  })
}

function commandName(name: string): string {
  if (process.platform !== 'win32' || name.includes('.') || name.includes('\\') || name.includes('/')) return name
  return name === 'node' || name === 'rg' ? name + '.exe' : name + '.cmd'
}

function commandCandidates(name: string): string[] {
  const candidates = [commandName(name)]
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles
    if (programFiles) candidates.push(join(programFiles, 'nodejs', name === 'node' ? 'node.exe' : name + '.cmd'))
    const appData = process.env.APPDATA
    if (appData && name !== 'node') candidates.push(join(appData, 'npm', name + '.cmd'))
  }
  return [...new Set(candidates)].filter((candidate) => !candidate.includes('\\') || existsSync(candidate))
}

async function version(
  command: string,
  args: string[] = ['--version'],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const candidate of commandCandidates(command)) {
    try {
      const result = await executeFile(candidate, args, {
        timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024, env: environment,
      })
      return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.slice(0, 160) || '已安装'
    } catch {
      // Try the next standard installation location.
    }
  }
  return undefined
}

function existingFile(candidate: string): boolean {
  try { return statSync(candidate).isFile() } catch { return false }
}

export function packageForAgent(agentKind: AgentKind): string | undefined {
  return AGENT_PACKAGES[agentKind]
}

export function installCommandForAgent(agentKind: AgentKind): string | undefined {
  const packageName = packageForAgent(agentKind)
  return packageName ? 'npm install -g ' + packageName : undefined
}

export async function detectAgentEnvironment(agentKind: AgentKind, executable: string): Promise<AgentEnvironmentSummary> {
  const environment = agentKind === 'pi' ? environmentWithFreshWindowsPath() : process.env
  const nodeVersion = await version('node', ['--version'], environment)
  const npmVersion = await version('npm', ['--version'], environment)
  const ripgrepVersion = agentKind === 'pi' ? await version('rg', ['--version'], environment) : undefined
  let executableVersion: string | undefined
  try {
    if (existingFile(executable)) executableVersion = await version(executable, ['--version'], environment)
    else executableVersion = await version(
      resolveExecutableForPty(executable, { path: pathFromEnvironment(environment) }), ['--version'], environment,
    )
  } catch {
    executableVersion = undefined
  }
  return {
    agentKind, executable, packageName: packageForAgent(agentKind), nodeAvailable: Boolean(nodeVersion),
    npmAvailable: Boolean(npmVersion), nodeVersion, npmVersion,
    agentInstalled: Boolean(executableVersion), executableVersion,
    ...(agentKind === 'pi' ? { ripgrepAvailable: Boolean(ripgrepVersion), ripgrepVersion, ripgrepInstallCommand: 'winget install --id BurntSushi.ripgrep.MSVC --exact' } : {}),
    installCommand: installCommandForAgent(agentKind),
    nodeInstallCommand: 'winget install --id OpenJS.NodeJS.LTS --exact',
  }
}

export async function installRipgrep(onProgress?: ProgressListener): Promise<void> {
  if (process.platform !== 'win32') throw new Error('请先安装 ripgrep，当前系统不支持自动安装')
  try {
    await runInstaller('winget.exe', ['install', '--id', 'BurntSushi.ripgrep.MSVC', '--exact', '--accept-source-agreements', '--accept-package-agreements'], 10 * 60_000, onProgress)
  } catch (error) {
    throw new Error('ripgrep 安装失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function installNodeAndNpm(onProgress?: ProgressListener): Promise<void> {
  if (process.platform !== 'win32') throw new Error('请先安装 Node.js LTS，当前系统不支持自动安装')
  try {
    await runInstaller('winget.exe', ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--accept-source-agreements', '--accept-package-agreements'], 10 * 60_000, onProgress)
  } catch (error) {
    throw new Error('Node.js/npm 安装失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function installAgent(agentKind: AgentKind, registry: NpmRegistryChoice = 'configured', onProgress?: ProgressListener): Promise<void> {
  const packageName = packageForAgent(agentKind)
  if (!packageName) throw new Error('当前 Agent 类型不支持一键安装')
  const npm = commandCandidates('npm')[0] ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const selectedRegistry = registryUrl(registry)
  try {
    await runInstaller(npm, ['install', '--global', packageName, ...(selectedRegistry ? ['--registry', selectedRegistry] : [])], AGENT_INSTALL_TIMEOUT_MS, onProgress)
  } catch (error) {
    const detail = error as Error & { code?: string | number; signal?: string }
    if (detail.code === 'INSTALL_TIMEOUT') {
      throw new Error(agentKind + ' 安装超时：下载超过 10 分钟。请检查网络或 npm 代理后重试；npm 的 deprecated 警告不是失败原因。')
    }
    throw new Error(agentKind + ' 安装失败：' + (detail.message || String(error)))
  }
}
