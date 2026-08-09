import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SessionHostManager,
  type HostHandle,
} from '../../electron/session-host-manager'
import type { HostEvent } from '../../src/shared/protocol'

const HOST_ENTRY = resolve('dist-electron/session-host.js')
const NATIVE_AGENT_FIXTURE = resolve('tests/fixtures/native-resume-agent.cjs')
const OUTPUT_TIMEOUT_MS = 10_000
const RESUME_TIMEOUT_MS = 3_000
const execFileAsync = promisify(execFile)

interface NativeConversation {
  sessionId: string
  workspace: string
  turns: string[]
}

interface NativeSessionSummary {
  sessionId: string
  workspace: string
}

interface AgentLaunch {
  executable: string
  args: string[]
}

interface AgentAdapter {
  start(workspace: string): Promise<AgentLaunch>
  resume(sessionId: string, workspace: string): Promise<NativeConversation>
  discover(workspace: string): Promise<NativeSessionSummary[]>
  nativeDataPath(sessionId: string): string
}

function normalizeWorkspace(workspace: string): string {
  return resolve(workspace).toLocaleLowerCase('en-US')
}

function createFixtureAdapter(nativeRoot: string): AgentAdapter {
  const sessionsRoot = join(nativeRoot, 'sessions')

  const nativeDataPath = (sessionId: string): string => {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid native session id')
    return join(sessionsRoot, `${sessionId}.json`)
  }

  const readSession = async (sessionId: string): Promise<NativeConversation> => {
    return JSON.parse(await readFile(nativeDataPath(sessionId), 'utf8')) as NativeConversation
  }

  return {
    async start(workspace) {
      await mkdir(sessionsRoot, { recursive: true })
      return {
        executable: process.execPath,
        args: [NATIVE_AGENT_FIXTURE, '--native-root', nativeRoot, '--workspace', workspace],
      }
    },
    async resume(sessionId, workspace) {
      try {
        const { stdout } = await execFileAsync(process.execPath, [
          NATIVE_AGENT_FIXTURE,
          '--native-root', nativeRoot,
          '--workspace', workspace,
          '--resume', sessionId,
        ], { cwd: workspace, timeout: RESUME_TIMEOUT_MS, windowsHide: true })
        const encoded = stdout.split(/\r?\n/)
          .find((line) => line.startsWith('NATIVE_RESUME_JSON='))
          ?.slice('NATIVE_RESUME_JSON='.length)
        if (!encoded) throw new Error('Native resume CLI returned no conversation')
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as NativeConversation
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr
        const message = typeof stderr === 'string' && stderr.trim()
          ? stderr.trim()
          : error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }
    },
    async discover(workspace) {
      let files: string[]
      try {
        files = await readdir(sessionsRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const sessions = await Promise.all(files
        .filter((file) => /^[a-zA-Z0-9-]+\.json$/.test(file))
        .map(async (file) => readSession(file.slice(0, -'.json'.length))))
      return sessions
        .filter((session) => normalizeWorkspace(session.workspace) === normalizeWorkspace(workspace))
        .map(({ sessionId, workspace: nativeWorkspace }) => ({ sessionId, workspace: nativeWorkspace }))
    },
    nativeDataPath,
  }
}

async function outputUntil(
  handle: HostHandle,
  predicate: (output: string) => boolean,
  timeoutMs = OUTPUT_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let output = ''
  while (Date.now() < deadline) {
    const event: HostEvent = await handle.nextEvent(deadline - Date.now())
    if (event.type === 'error') throw new Error(event.message)
    if (event.type === 'exit') throw new Error(`Fixture exited before expected output (code ${event.exitCode})`)
    if (event.type !== 'output') continue
    output += event.data
    if (predicate(output)) return output
  }
  throw new Error('Timed out waiting for native fixture output')
}

function isOutside(candidate: string, ownerRoot: string): boolean {
  const pathFromOwner = relative(ownerRoot, candidate)
  return pathFromOwner === '..' || pathFromOwner.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromOwner)
}

interface StartedHost {
  manager: SessionHostManager
  hostId: string
  runtimeDir: string
  hostPid: number
  fixturePid?: number
}

type ObservedProcessKind = 'Session Host' | 'native fixture'

interface CleanupOperations {
  stopNormally(): Promise<void>
  isAlive(pid: number): boolean
  identityMatches(pid: number, kind: ObservedProcessKind): Promise<boolean>
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>
}

async function cleanupObservedProcesses(
  processes: Pick<StartedHost, 'hostPid' | 'fixturePid'>,
  operations: CleanupOperations,
): Promise<void> {
  try {
    await operations.stopNormally()
  } catch {
    // A deliberate Manager runtime loss can make the normal connection unavailable.
  }

  const observed: Array<{ kind: ObservedProcessKind; pid: number | undefined }> = [
    { kind: 'Session Host', pid: processes.hostPid },
    { kind: 'native fixture', pid: processes.fixturePid },
  ]
  for (const { kind, pid } of observed) {
    if (pid === undefined || !operations.isAlive(pid)) continue
    if (!await operations.identityMatches(pid, kind)) {
      throw new Error(`Refusing unsafe cleanup: ${kind} PID ${pid} identity mismatch`)
    }
    if (!await operations.waitForExit(pid, 2_000)) {
      throw new Error(`${kind} PID ${pid} remained alive after normal stop; forced termination was not attempted`)
    }
  }
}

function isSafeFixturePid(pid: number | undefined): pid is number {
  return Number.isInteger(pid) && pid! > 0 && pid !== process.pid && pid !== process.ppid
}

function isProcessAlive(pid: number | undefined): pid is number {
  if (!isSafeFixturePid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return !isProcessAlive(pid)
}

describe('native resume safety', () => {
  const handles: HostHandle[] = []
  const startedHosts: StartedHost[] = []
  const tempRoots: string[] = []

  async function startRegisteredHost(
    manager: SessionHostManager,
    runtimeDir: string,
    launch: AgentLaunch,
    workspace: string,
  ): Promise<{ handle: HostHandle; registration: StartedHost }> {
    const handle = await manager.start({
      agentKind: 'generic',
      executable: launch.executable,
      args: launch.args,
      cwd: workspace,
      cols: 80,
      rows: 24,
    })
    handles.push(handle)
    const registration: StartedHost = {
      manager,
      hostId: handle.hostId,
      runtimeDir,
      hostPid: 0,
    }
    startedHosts.push(registration)
    const record = JSON.parse(await readFile(join(runtimeDir, `host-${handle.hostId}.json`), 'utf8')) as { pid?: unknown }
    if (typeof record.pid !== 'number' || !isSafeFixturePid(record.pid)) {
      throw new Error('Session Host registry did not contain a safe child PID')
    }
    registration.hostPid = record.pid
    return { handle, registration }
  }

  async function stopRegisteredHost(entry: StartedHost): Promise<void> {
    await cleanupObservedProcesses(entry, {
      stopNormally: async () => {
        if (!isProcessAlive(entry.hostPid)) return
        let cleanupHandle: HostHandle | undefined
        try {
          cleanupHandle = await entry.manager.reconnect(entry.hostId)
          await cleanupHandle.stop()
        } finally {
          cleanupHandle?.disconnect()
        }
      },
      isAlive: (pid) => isProcessAlive(pid),
      identityMatches: async (pid, kind) => kind === 'Session Host'
        ? pid === entry.hostPid
        : pid === entry.fixturePid,
      waitForExit: waitForProcessExit,
    })
  }

  afterEach(async () => {
    await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
    const cleanupErrors: unknown[] = []
    for (const entry of startedHosts.splice(0)) {
      try {
        await stopRegisteredHost(entry)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Native resume fixture cleanup failed')
    }
  })

  it('reports a native fixture left alive even when its Session Host already exited', async () => {
    const operations = {
      isAlive: vi.fn((pid: number) => pid === 202),
      identityMatches: vi.fn(async () => true),
      waitForExit: vi.fn(async () => false),
      stopNormally: vi.fn(async () => undefined),
    }

    await expect(cleanupObservedProcesses(
      { hostPid: 101, fixturePid: 202 },
      operations,
    )).rejects.toThrow(/native fixture PID 202 remained alive/i)
    expect(operations.stopNormally).toHaveBeenCalledOnce()
    expect(operations.waitForExit).toHaveBeenCalledWith(202, 2_000)
  })

  it('refuses cleanup on a PID identity mismatch without killing any process', async () => {
    const kill = vi.spyOn(process, 'kill')
    const operations = {
      isAlive: vi.fn((pid: number) => pid === 303),
      identityMatches: vi.fn(async () => false),
      waitForExit: vi.fn(async () => false),
      stopNormally: vi.fn(async () => undefined),
    }
    try {
      await expect(cleanupObservedProcesses(
        { hostPid: 303, fixturePid: undefined },
        operations,
      )).rejects.toThrow(/refusing unsafe cleanup.*Session Host PID 303.*identity mismatch/i)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('resumes the same native conversation after Main disconnect and Manager data loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tui-native-resume-'))
    tempRoots.push(root)
    const workspace = join(root, 'workspace')
    const wrongWorkspace = join(root, 'wrong-workspace')
    const nativeRoot = join(root, 'fixture-native')
    const managerRoot = join(root, 'manager-owned')
    const runtimeDir = join(managerRoot, 'runtime')
    const sqlitePath = join(managerRoot, 'manager.sqlite')
    await Promise.all([
      mkdir(workspace),
      mkdir(wrongWorkspace),
      mkdir(nativeRoot),
      mkdir(runtimeDir, { recursive: true }),
    ])
    await writeFile(sqlitePath, 'disposable manager database')

    const adapter = createFixtureAdapter(nativeRoot)
    const launch = await adapter.start(workspace)
    const firstManager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    const { handle: original, registration } = await startRegisteredHost(firstManager, runtimeDir, launch, workspace)

    const startedOutput = await outputUntil(original, (output) => output.includes('NATIVE_FIXTURE_READY'))
    const sessionId = /NATIVE_SESSION_ID=([a-zA-Z0-9-]+)/.exec(startedOutput)?.[1]
    const fixturePid = Number(/NATIVE_FIXTURE_PID=(\d+)/.exec(startedOutput)?.[1])
    expect(sessionId).toBeTruthy()
    expect(isSafeFixturePid(fixturePid)).toBe(true)
    registration.fixturePid = fixturePid

    const nativePath = adapter.nativeDataPath(sessionId!)
    expect(isOutside(nativePath, managerRoot)).toBe(true)
    expect(isOutside(nativeRoot, managerRoot)).toBe(true)

    const firstTurn = 'first turn survives Manager loss'
    const secondTurn = 'second turn proves the same conversation'
    original.write(`${firstTurn}\r`)
    await outputUntil(original, (output) => output.includes('NATIVE_TURN_PERSISTED=1'))
    original.write(`${secondTurn}\r`)
    await outputUntil(original, (output) => output.includes('NATIVE_TURN_PERSISTED=2'))
    const nativeBaseline = await readFile(nativePath)

    // Simulate Electron Main disappearing: only its connection is destroyed.
    original.disconnect()
    const replacementManager = new SessionHostManager({ runtimeDir, hostEntry: HOST_ENTRY })
    const liveHosts = await replacementManager.listLiveHosts()
    expect(liveHosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: original.hostId, cwd: workspace, pid: registration.hostPid }),
    ]))
    const reconnected = await replacementManager.reconnect(original.hostId)
    handles.push(reconnected)
    expect(reconnected.hostId).toBe(original.hostId)
    reconnected.write('@native-session\r')
    const reconnectedOutput = await outputUntil(reconnected, (output) => output.includes(`NATIVE_SESSION_ID=${sessionId}`))
    expect(reconnectedOutput).toContain(`NATIVE_SESSION_ID=${sessionId}`)

    await reconnected.stop()
    reconnected.disconnect()
    expect(await waitForProcessExit(registration.hostPid, 2_000)).toBe(true)
    await rm(managerRoot, { recursive: true, force: true })

    expect(await readFile(nativePath)).toEqual(nativeBaseline)
    await expect(adapter.discover(workspace)).resolves.toEqual([
      { sessionId, workspace },
    ])
    await expect(adapter.discover(wrongWorkspace)).resolves.toEqual([])
    await expect(adapter.resume(sessionId!, wrongWorkspace)).rejects.toThrow(/does not belong to workspace/i)
    await expect(adapter.resume(sessionId!, workspace)).resolves.toEqual({
      sessionId,
      workspace,
      turns: [firstTurn, secondTurn],
    })
    expect(await readFile(nativePath)).toEqual(nativeBaseline)
  })
})
