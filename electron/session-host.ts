import net, { type Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import * as pty from 'node-pty'

import type { HostCommand, HostEvent, HostExitFact } from '../src/shared/protocol'
import { environmentForAgent } from './agent-environment'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import { TerminalStateReplay } from './terminal-state-replay'

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
const clients = new Set<Socket>()
const permissionHookToken = randomBytes(24).toString('hex')
const permissionHookSockets = new Map<string, Socket>()
let terminal: pty.IPty | undefined
const terminalReplay = new TerminalReplayBuffer()
let terminalStateReplay: TerminalStateReplay | undefined
let shuttingDown = false
let finalizing = false

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

async function finalizeExit(exitCode: number, signal?: number): Promise<void> {
  if (finalizing) return
  finalizing = true
  const fact: HostExitFact = {
    hostId,
    exitCode,
    ...(signal === undefined ? {} : { signal }),
    exitedAt: new Date().toISOString(),
  }
  try {
    await atomicWriteJson(exitPath, fact)
    broadcast({ type: 'exit', exitCode, ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    broadcast({ type: 'error', message: `Failed to persist final exit: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    await unlink(claudeSettingsPath).catch(() => undefined)
    terminal = undefined
    terminalStateReplay?.dispose()
    terminalStateReplay = undefined
    shutdown(exitCode === 0 ? 0 : 1)
  }
}

function hookCommand(): string {
  const executable = process.execPath.replace(/"/g, '""')
  const script = join(__dirname, 'claude-permission-hook.js').replace(/"/g, '""')
  return process.platform === 'win32'
    ? `set "ELECTRON_RUN_AS_NODE=1" && "${executable}" "${script}"`
    : `ELECTRON_RUN_AS_NODE=1 "${executable}" "${script}"`
}

function claudeArgs(args: string[], cwd: string): string[] {
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
        return args
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
        { matcher: '*', hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] },
      ],
    },
  }
  writeFileSync(claudeSettingsPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 })
  return ['--settings', claudeSettingsPath, ...remaining]
}

function codexArgs(args: string[]): string[] {
  const quote = String.fromCharCode(34)
  return [
    ...(args.includes('--no-alt-screen') ? [] : ['--no-alt-screen']),
    '-c', 'tui.notifications=[' + quote + 'approval-requested' + quote + ']',
    '-c', 'tui.notification_method=' + quote + 'osc9' + quote,
    '-c', 'tui.notification_condition=' + quote + 'always' + quote,
    ...args,
  ]
}

function startTerminal(socket: Socket, command: Extract<HostCommand, { type: 'start' }>): void {
  if (terminal) {
    send(socket, { type: 'error', message: 'Host already owns a PTY' })
    return
  }

  try {
    const pendingOutput: string[] = []
    let ready = false
    const args = command.agentKind === 'claude'
      ? claudeArgs(command.args, command.cwd)
      : command.agentKind === 'codex'
        ? codexArgs(command.args)
        : command.args
    terminal = pty.spawn(command.executable, args, {
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
      ...(command.agentKind === 'codex' ? { conptyInheritCursor: true } : {}),
    })
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
      void finalizeExit(exitCode, signal)
    })

    send(socket, { type: 'ready', hostId })
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
      permissionHookSockets.set(command.requestId, socket)
      broadcast({
        type: 'permission-request',
        requestId: command.requestId,
        toolName: command.toolName,
        ...(command.command ? { command: command.command } : {}),
        ...(command.operation ? { operation: command.operation } : {}),
        ...(command.filePath ? { filePath: command.filePath } : {}),
        ...(command.targetPaths ? { targetPaths: command.targetPaths } : {}),
        ...(command.toolInputSummary ? { toolInputSummary: command.toolInputSummary } : {}),
        ...(command.reason ? { reason: command.reason } : {}),
      })
      break
    case 'permission-response': {
      const hookSocket = permissionHookSockets.get(command.requestId)
      if (hookSocket) {
        send(hookSocket, { type: 'permission-response', requestId: command.requestId, action: command.action })
        permissionHookSockets.delete(command.requestId)
        hookSocket.end()
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
    case 'ping': send(socket, { type: 'pong' }); break
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
    for (const [requestId, candidate] of permissionHookSockets) {
      if (candidate === socket) permissionHookSockets.delete(requestId)
    }
  })
})

server.on('error', (error) => {
  broadcast({ type: 'error', message: error.message })
  process.exit(1)
})
server.listen(endpoint)
