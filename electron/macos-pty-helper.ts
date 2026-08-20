import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import { posix } from 'node:path'

export interface MacPtyHelperOptions {
  platform?: NodeJS.Platform
  arch?: string
  nodePtyEntry?: string
  candidates?: readonly string[]
  exists?: (path: string) => boolean
  access?: (path: string, mode: number) => void
  chmod?: (path: string, mode: number) => void
}

export function macPtySpawnHelperCandidates(nodePtyEntry: string, arch: string = process.arch): string[] {
  const packageRoot = posix.resolve(posix.dirname(nodePtyEntry), '..').replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked')
  return [
    posix.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    posix.join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    posix.join(packageRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper'),
  ]
}

export function ensureMacPtySpawnHelper(options: MacPtyHelperOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== 'darwin') return undefined

  const candidates = options.candidates ?? macPtySpawnHelperCandidates(
    options.nodePtyEntry ?? require.resolve('node-pty'),
    options.arch,
  )
  const exists = options.exists ?? existsSync
  const access = options.access ?? accessSync
  const chmod = options.chmod ?? chmodSync
  const helper = candidates.find((candidate) => exists(candidate))
  if (!helper) throw new Error('macOS PTY helper 缺失，请在 Mac 上重新安装依赖并重新打包应用')

  try {
    access(helper, constants.X_OK)
    return helper
  } catch {
    // ZIP extraction and unsigned packaging can strip the executable bit.
  }

  try {
    chmod(helper, 0o755)
    access(helper, constants.X_OK)
    return helper
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`macOS PTY helper 无法执行：${helper}。请将应用复制到“应用程序”后移除隔离属性。${reason}`)
  }
}
