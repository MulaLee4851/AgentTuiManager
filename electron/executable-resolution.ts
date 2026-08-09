import { statSync } from 'node:fs'
import { delimiter, win32 } from 'node:path'

export interface ExecutableResolutionOptions {
  platform?: NodeJS.Platform
  path?: string
  pathExt?: string
  isFile?: (path: string) => boolean
}

function existingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function environmentValue(name: string): string | undefined {
  const entry = Object.entries(process.env).find(([key]) => key.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
  return entry?.[1]
}

export function resolveExecutableForPty(candidate: string, options: ExecutableResolutionOptions = {}): string {
  if ((options.platform ?? process.platform) !== 'win32' || win32.isAbsolute(candidate)) return candidate
  if (candidate.includes('/') || candidate.includes('\\')) return candidate

  const isFile = options.isFile ?? existingFile
  const path = options.path ?? environmentValue('PATH') ?? ''
  const configuredExtensions = (options.pathExt ?? environmentValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
  const hasExtension = win32.extname(candidate).length > 0
  const names = hasExtension ? [candidate] : configuredExtensions.map((extension) => `${candidate}${extension}`)

  for (const rawDirectory of path.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    for (const name of names) {
      const resolved = win32.join(directory, name)
      if (isFile(resolved)) return resolved
    }
  }
  throw new Error(`Executable not found in PATH: ${candidate}`)
}
