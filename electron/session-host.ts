import net, { type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

import * as pty from 'node-pty'

import type { HostCommand, HostEvent, HostExitFact } from '../src/shared/protocol'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument ${name}`)
  return value
}

const hostId = argument('--host-id')
const endpoint = argument('--endpoint')
const exitPath = argument('--exit-path')
const clients = new Set<Socket>()
let terminal: pty.IPty | undefined
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
    terminal = undefined
    shutdown(exitCode === 0 ? 0 : 1)
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
    terminal = pty.spawn(command.executable, command.args, {
      cwd: command.cwd,
      cols: command.cols,
      rows: command.rows,
      env: { ...process.env } as Record<string, string>,
      name: 'xterm-256color',
    })
    terminal.onData((data) => {
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
    case 'resize': terminal?.resize(command.cols, command.rows); break
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
  socket.on('close', () => clients.delete(socket))
})

server.on('error', (error) => {
  broadcast({ type: 'error', message: error.message })
  process.exit(1)
})
server.listen(endpoint)
