export function claudeWindowsHookLauncher(executable: string, script: string): string {
  const quote = (value: string): string => '"' + value.replace(/%/g, '%%') + '"'
  return ['@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"', quote(executable) + ' ' + quote(script), ''].join('\r\n')
}

// Forward slashes work in both Git Bash and cmd; the batch file owns env setup.
export function claudeWindowsHookCommand(launcher: string): string {
  return '"' + launcher.replace(/\\/g, '/') + '"'
}
