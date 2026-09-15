import net, { type Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import * as pty from 'node-pty'

import type { HostCommand, HostEvent, HostExitFact } from '../src/shared/protocol'
import { environmentForAgent } from './agent-environment'
import { ensureMacPtySpawnHelper } from './macos-pty-helper'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import { TerminalStateReplay } from './terminal-state-replay'
import { claudeWindowsHookLauncher, claudeWindowsHookCommand } from './claude-hook-launcher'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument ${name}`)
  return value
}

const hostId = argument('--host-id')
const endpoint = argument('--endpoint')
const exitPath = argument('--exit-path')
const claudeSettingsPath = `${exitPath}.claude-settings.json`
const claudeHookLauncherPath = `${exitPath}.claude-hook.cmd`
const codexHookLauncherPath = `${exitPath}.codex-hook.${process.platform === 'win32' ? 'cmd' : 'sh'}`
const clients = new Set<Socket>()
const permissionHookToken = randomBytes(24).toString('hex')
const permissionHookSockets = new Map<string, { socket: Socket; hookSource: 'claude' | 'codex' }>()
let terminal: pty.IPty | undefined
const terminalReplay = new TerminalReplayBuffer()
let terminalStateReplay: TerminalStateReplay | undefined
let shuttingDown = false
let finalizing = false
let managerSocket: Socket | undefined
let managerId: string | undefined
let managerLeaseMs = 15_000
let managerLastHeartbeat = 0
let preserveOnManagerDisconnect = false
let preserveOnLeaseExpiry = true
let managerLeaseTimer: ReturnType<typeof setInterval> | undefined
let terminalExitReason: HostExitFact['reason'] = 'process-exit'

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2))
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function send(socket: Socket, event: HostEvent): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`)
}

function broadcast(event: HostEvent): void {
  for (const socket of clients) send(socket, event)
}

function shutdown(exitCode: number): void {
  if (shuttingDown) return
  shuttingDown = true
  setTimeout(() => {
    server.close()
    for (const socket of clients) socket.end()
    process.exit(exitCode)
  }, 50).unref()
}

async function finalizeExit(exitCode: number, signal?: number, reason: HostExitFact['reason'] = 'process-exit'): Promise<void> {
  if (finalizing) return
  finalizing = true
  const fact: HostExitFact = {
    hostId,
    exitCode,
    ...(signal === undefined ? {} : { signal }),
    reason,
    exitedAt: new Date().toISOString(),
  }
  try {
    await atomicWriteJson(exitPath, fact)
    broadcast({ type: 'exit', exitCode, ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    broadcast({ type: 'error', message: `Failed to persist final exit: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    await unlink(claudeSettingsPath).catch(() => undefined)
    await unlink(claudeHookLauncherPath).catch(() => undefined)
    await unlink(codexHookLauncherPath).catch(() => undefined)
    terminal = undefined
    terminalStateReplay?.dispose()
    terminalStateReplay = undefined
    shutdown(exitCode === 0 ? 0 : 1)
  }
}

function ensureManagerLeaseTimer(): void {
  if (managerLeaseTimer) return
  managerLeaseTimer = setInterval(() => {
    if (!terminal || shuttingDown || preserveOnManagerDisconnect || !managerId) return
    if (Date.now() - managerLastHeartbeat <= managerLeaseMs) return
    if (preserveOnLeaseExpiry) {
      preserveOnManagerDisconnect = true
      managerId = undefined
      managerSocket = undefined
      return
    }
    const ownedTerminal = terminal
    managerId = undefined
    managerSocket = undefined
    terminalExitReason = 'manager-lease-expired'
    ownedTerminal.kill()
    setTimeout(() => {
      if (terminal === ownedTerminal && !finalizing) void finalizeExit(1, undefined, 'manager-lease-expired')
    }, 2_000).unref()
  }, 1_000)
  managerLeaseTimer.unref()
}

function hookCommand(scriptName = 'claude-permission-hook.js'): string {
  if (process.platform === 'win32') {
    writeFileSync(claudeHookLauncherPath, claudeWindowsHookLauncher(process.execPath, join(__dirname, scriptName)), { encoding: 'utf8', mode: 0o700 })
    return claudeWindowsHookCommand(claudeHookLauncherPath)
  }
  const executable = process.execPath.replace(/"/g, '""')
  const script = join(__dirname, scriptName).replace(/"/g, '""')
  return `ELECTRON_RUN_AS_NODE=1 "${executable}" "${script}"`
}

function codexHookCommand(): string {
  const executable = process.execPath.replace(/"/g, '""')
  const script = join(__dirname, 'codex-permission-hook.js').replace(/"/g, '""')
  if (process.platform === 'win32') {
    writeFileSync(codexHookLauncherPath, [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${executable}" "${script}"`,
      '',
    ].join('\r\n'), { encoding: 'utf8', mode: 0o700 })
    return `cmd.exe /d /c call "${codexHookLauncherPath.replace(/"/g, '""')}"`
  }
  writeFileSync(codexHookLauncherPath, [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 exec "${executable}" "${script}"`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 })
  return `"${codexHookLauncherPath.replace(/"/g, '\\"')}"`
}

function claudeArgs(args: string[], cwd: string): { args: string[]; permissionHook: boolean } {
  const remaining = [...args]
  let existing: Record<string, unknown> = {}
  const settingsIndex = remaining.findIndex((value) => value === '--settings' || value.startsWith('--settings='))
  if (settingsIndex >= 0) {
    const flag = remaining[settingsIndex]!
    const value = flag === '--settings' ? remaining[settingsIndex + 1] : flag.slice('--settings='.length)
    if (value) {
      try {
        const trimmed = value.trim()
        const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
        existing = JSON.parse(trimmed.startsWith('{') ? trimmed : readFileSync(path, 'utf8')) as Record<string, unknown>
        remaining.splice(settingsIndex, flag === '--settings' ? 2 : 1)
      } catch {
        // Keep the user's original flag intact; text detection remains available.
        return { args, permissionHook: false }
      }
    }
  }
  const hooks = typeof existing.hooks === 'object' && existing.hooks !== null
    ? existing.hooks as Record<string, unknown>
    : {}
  const permissionHooks = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : []
  const settings = {
    ...existing,
    hooks: {
      ...hooks,
      PermissionRequest: [
        ...permissionHooks,
        // The hook waits for the user/Manager decision. Keep Claude's command
        // timeout aligned with the hook's 30-minute socket wait; a 10-second
        // timeout killed valid requests while they were still visible in Manager.
        { matcher: '*', hooks: [{ type: 'command', command: hookCommand(), timeout: 1_800 }] },
      ],
    },
  }
  writeFileSync(claudeSettingsPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 })
  return { args: ['--settings', claudeSettingsPath, ...remaining], permissionHook: true }
}

function codexArgs(args: string[]): string[] {
  const quote = String.fromCharCode(34)
  const hookConfig = '[{ matcher = "*", hooks = [{ type = "command", command = '
    + JSON.stringify(codexHookCommand())
    + ', timeout = 1800, statusMessage = "请稍后" }] }]'
  return [
    ...(args.includes('--no-alt-screen') ? [] : ['--no-alt-screen']),
    ...(args.includes('--enable') && args.includes('hooks') ? [] : ['--enable', 'hooks']),
    ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
    '-c', `hooks.PermissionRequest=${hookConfig}`,
    '-c', 'tui.notifications=[' + quote + 'approval-requested' + quote + ']',
    '-c', 'tui.notification_method=' + quote + 'osc9' + quote,
    '-c', 'tui.notification_condition=' + quote + 'always' + quote,
    ...args,
  ]
}

// Codex builds its scrollback by scrolling a DECSTBM region above the inline composer
// (--no-alt-screen). The ConPTY built into Windows drops scroll regions and repaints the
// screen in place, so those lines never reach the consumer as scrollback and the terminal
// has nothing to scroll. node-pty's bundled conpty.dll forwards scroll regions intact and
// also emits far less repaint traffic. It is marked experimental, so fall back to the
// system ConPTY if it cannot be loaded rather than failing the session start.
function spawnAgentTerminal(
  agentKind: Extract<HostCommand, { type: 'start' }>['agentKind'],
  executable: string,
  args: string[],
  options: pty.IPtyForkOptions,
): pty.IPty {
  if (process.platform === 'darwin') ensureMacPtySpawnHelper()
  if (agentKind !== 'codex' || process.platform !== 'win32') return pty.spawn(executable, args, options)
  try {
    return pty.spawn(executable, args, { ...options, useConptyDll: true })
  } catch {
    return pty.spawn(executable, args, options)
  }
}

function startTerminal(socket: Socket, command: Extract<HostCommand, { type: 'start' }>): void {
  if (terminal) {
    send(socket, { type: 'error', message: 'Host already owns a PTY' })
    return
  }

  try {
    const pendingOutput: string[] = []
    let ready = false
    const claudeLaunch = command.agentKind === 'claude' ? claudeArgs(command.args, command.cwd) : undefined
    const args = claudeLaunch?.args ?? (command.agentKind === 'codex' ? codexArgs(command.args) : command.args)
    const permissionHook = command.agentKind === 'codex'
      ? 'codex' as const
      : claudeLaunch?.permissionHook
        ? 'claude' as const
        : undefined
    const spawnOptions: pty.IPtyForkOptions = {
      cwd: command.cwd,
      cols: command.cols,
      rows: command.rows,
      env: {
        ...environmentForAgent(command.agentKind),
        ...command.environment,
        AGENT_TUI_MANAGER_HOOK_ENDPOINT: endpoint,
        AGENT_TUI_MANAGER_HOOK_TOKEN: permissionHookToken,
      },
      name: 'xterm-256color',
      // Codex's Windows inline viewport needs ConPTY to inherit the cursor anchor;
      // without this it falls back to a 30-row repaint with no terminal scrollback.
      ...(process.platform === 'win32' && command.agentKind === 'codex' ? { conptyInheritCursor: true } : {}),
    }
    terminal = spawnAgentTerminal(command.agentKind, command.executable, args, spawnOptions)
    terminalStateReplay = command.agentKind === 'codex'
      ? new TerminalStateReplay(command.cols, command.rows, 10_000, (data) => terminal?.write(data))
      : undefined
    terminal.onData((data) => {
      terminalReplay.append(data)
      terminalStateReplay?.append(data)
      if (ready) broadcast({ type: 'output', data })
      else pendingOutput.push(data)
    })
    terminal.onExit(({ exitCode, signal }) => {
      void finalizeExit(exitCode, signal, terminalExitReason)
    })

    send(socket, { type: 'ready', hostId, ...(permissionHook ? { permissionHook } : {}) })
    ready = true
    for (const data of pendingOutput) broadcast({ type: 'output', data })
  } catch (error) {
    send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    shutdown(1)
  }
}

function handleCommand(socket: Socket, command: HostCommand): void {
  switch (command.type) {
    case 'start': startTerminal(socket, command); break
    case 'write': terminal?.write(command.data); break
    case 'resize':
      terminal?.resize(command.cols, command.rows)
      terminalStateReplay?.resize(command.cols, command.rows)
      break
    case 'permission-hook':
      if (command.token !== permissionHookToken || !/^[a-f0-9-]{16,64}$/i.test(command.requestId)) {
        socket.end()
        break
      }
      clients.delete(socket)
      permissionHookSockets.set(command.requestId, { socket, hookSource: command.hookSource })
      broadcast({
        type: 'permission-request',
        requestId: command.requestId,
        hookSource: command.hookSource,
        toolName: command.toolName,
        ...(command.command ? { command: command.command } : {}),
        ...(command.operation ? { operation: command.operation } : {}),
        ...(command.filePath ? { filePath: command.filePath } : {}),
        ...(command.targetPaths ? { targetPaths: command.targetPaths } : {}),
        ...(command.toolInputSummary ? { toolInputSummary: command.toolInputSummary } : {}),
        ...(command.reason ? { reason: command.reason } : {}),
        ...(command.toolUseId ? { toolUseId: command.toolUseId } : {}),
        ...(command.agentId ? { agentId: command.agentId } : {}),
        ...(command.agentType ? { agentType: command.agentType } : {}),
        ...(command.toolInputFingerprint ? { toolInputFingerprint: command.toolInputFingerprint } : {}),
        ...(command.nativeSessionId ? { nativeSessionId: command.nativeSessionId } : {}),
        ...(command.turnId ? { turnId: command.turnId } : {}),
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.model ? { model: command.model } : {}),
        ...(command.permissionMode ? { permissionMode: command.permissionMode } : {}),
        ...(command.transcriptPath ? { transcriptPath: command.transcriptPath } : {}),
        ...(command.toolInput !== undefined ? { toolInput: command.toolInput } : {}),
        ...(command.rawPayload !== undefined ? { rawPayload: command.rawPayload } : {}),
      })
      break
    case 'permission-response': {
      const hook = permissionHookSockets.get(command.requestId)
      if (hook && !hook.socket.destroyed) {
        permissionHookSockets.delete(command.requestId)
        hook.socket.write(`${JSON.stringify({ type: 'permission-response', requestId: command.requestId, action: command.action })}\n`, (error) => {
          send(socket, { type: 'permission-response-ack', requestId: command.requestId, delivered: !error })
          hook.socket.end()
        })
      } else {
        permissionHookSockets.delete(command.requestId)
        send(socket, { type: 'permission-response-ack', requestId: command.requestId, delivered: false })
      }
      break
    }
    case 'replay':
      void (terminalStateReplay
        ? terminalStateReplay.snapshot().catch(() => terminalReplay.snapshot())
        : Promise.resolve(terminalReplay.snapshot()))
        .then((data) => send(socket, { type: 'replay', data }))
        .catch((error) => send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) }))
      break
    case 'stop':
      terminal?.kill()
      if (!terminal) shutdown(0)
      break
    case 'claim-manager':
      managerSocket = socket
      managerId = command.managerId
      managerLeaseMs = Math.max(5_000, Math.min(60_000, command.leaseMs))
      preserveOnLeaseExpiry = command.preserveOnLeaseExpiry !== false
      managerLastHeartbeat = Date.now()
      preserveOnManagerDisconnect = false
      ensureManagerLeaseTimer()
      break
    case 'manager-heartbeat':
      if (socket === managerSocket && command.managerId === managerId) managerLastHeartbeat = Date.now()
      break
    case 'preserve-on-disconnect':
      if (socket === managerSocket && command.managerId === managerId) {
        preserveOnManagerDisconnect = true
        managerId = undefined
        managerSocket = undefined
        send(socket, { type: 'manager-preserved', managerId: command.managerId })
      }
      break
    case 'ping': send(socket, {
      type: 'pong',
      ownership: preserveOnManagerDisconnect ? 'preserved' : managerId ? 'managed' : 'unclaimed',
    }); break
  }
}

const server = net.createServer((socket) => {
  clients.add(socket)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        handleCommand(socket, JSON.parse(line) as HostCommand)
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  socket.on('error', () => undefined)
  socket.on('close', () => {
    clients.delete(socket)
    if (socket === managerSocket) managerSocket = undefined
    for (const [requestId, candidate] of permissionHookSockets) {
      if (candidate.socket !== socket) continue
      permissionHookSockets.delete(requestId)
      broadcast({ type: 'permission-hook-closed', requestId, hookSource: candidate.hookSource })
    }
  })
})

server.on('error', (error) => {
  broadcast({ type: 'error', message: error.message })
  process.exit(1)
})
server.listen(endpoint)
