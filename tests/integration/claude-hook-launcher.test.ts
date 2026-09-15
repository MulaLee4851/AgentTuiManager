import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { expect, it } from 'vitest'
import { claudeWindowsHookCommand, claudeWindowsHookLauncher } from '../../electron/claude-hook-launcher'

it.skipIf(process.platform !== 'win32')('runs the real launcher without inherited Electron mode in cmd and available Git Bash', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-hook-'))
  try {
    const script = join(root, 'hook probe.cjs')
    const launcher = join(root, 'hook launcher.cmd')
    writeFileSync(script, "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || 'missing')")
    writeFileSync(launcher, claudeWindowsHookLauncher(process.execPath, script))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const cmd = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', launcher], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    expect(cmd.error).toBeUndefined()
    expect(cmd.status).toBe(0)
    expect(cmd.stdout).toBe('1')
    let bash = process.env.CLAUDE_CODE_GIT_BASH_PATH
    if (!bash) {
      try {
        const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim().split(/\r?\n/)[0]!
        bash = join(dirname(dirname(git)), 'bin', 'bash.exe')
      } catch { /* optional Git Bash */ }
    }
    if (bash && existsSync(bash)) {
      const result = spawnSync(bash, ['-c', claudeWindowsHookCommand(launcher)], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('1')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
