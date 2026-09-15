import { expect, it } from 'vitest'
import { claudeWindowsHookCommand, claudeWindowsHookLauncher } from '../../electron/claude-hook-launcher'

it('keeps Windows environment assignment inside a batch launcher for both cmd and Bash', () => {
  const script = claudeWindowsHookLauncher('C:\\Program Files\\Manager.exe', 'C:\\中文目录\\hook.js')
  expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"')
  expect(script).toContain('"C:\\Program Files\\Manager.exe" "C:\\中文目录\\hook.js"')
  expect(claudeWindowsHookCommand('C:\\中文目录\\agent hook.cmd')).toBe('"C:/中文目录/agent hook.cmd"')
  expect(claudeWindowsHookLauncher('C:\\100%\\app.exe', 'C:\\hook.js')).toContain('100%%')
})
