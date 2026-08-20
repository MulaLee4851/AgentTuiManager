import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log(`Skipping the Windows native drag bridge on ${process.platform}`)
  process.exit(0)
}

const directory = dirname(fileURLToPath(import.meta.url))
const script = join(directory, 'build-native-bridge.ps1')
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
