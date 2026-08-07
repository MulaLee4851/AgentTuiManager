# Windows Terminal Drag Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-safe bidirectional drag handoff between native Windows Terminal and the Agent wall: drag in becomes fully managed, drag out becomes fully native, and both directions preserve the Agent's native session through a guarded resume transaction.

**Architecture:** A small .NET Framework C# helper owns Win32 window hooks and guarded input injection, while a detached Node coordinator owns the idempotent handoff transaction. Pure TypeScript contracts, reducer, and journal enforce the one-active-process invariant; Codex and Claude adapters provide native discovery, stop, resume, persistence, and readiness evidence. Electron Main projects transaction state into a React Agent wall without exposing OS control to the Renderer.

**Tech Stack:** Electron, React, TypeScript, Vitest, node-pty, Windows Named Pipes, Win32 `SetWinEventHook`, .NET Framework C# compiler (`csc.exe`), Windows Terminal CLI.

---

## Scope And Prerequisite Gate

This plan implements the approved specification in `docs/superpowers/specs/2026-08-07-windows-terminal-drag-handoff-design.md`.

It depends on the durable Session Host vertical slice in `docs/superpowers/plans/2026-08-07-session-foundation.md`. Finish that plan before Task 1 here. The prerequisite is satisfied only when all of these commands pass in the implementation worktree:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: all Vitest suites pass, TypeScript exits with code 0, and Electron main/preload/renderer builds succeed. Also complete the native-resume fixture from foundation Task 5; a passing build without that ownership test is not sufficient.

Before this plan starts, merge the approved spec and this plan into the implementation branch without rewriting the existing foundation commits:

```powershell
git merge master
```

Expected: the feature branch contains both approved documents and remains clean. Resolve documentation-only conflicts by preserving the newer approved text; do not discard implementation work.

## File Map

### Shared contracts and pure logic

- Create `src/shared/handoff-protocol.ts`: Renderer/Main/coordinator/native-helper message types and runtime validators.
- Create `src/shared/handoff-state.ts`: pure transaction reducer and invariant checks.
- Create `src/shared/native-handoff-adapter.ts`: adapter capability contract shared by Codex and Claude.

### Native Windows bridge

- Create `native/AgentTui.NativeBridge/Program.cs`: process entry, named-pipe loop, `--self-test` mode.
- Create `native/AgentTui.NativeBridge/Protocol.cs`: JSON message DTOs and serialization.
- Create `native/AgentTui.NativeBridge/WinEventMonitor.cs`: move/size WinEvent hook and message loop.
- Create `native/AgentTui.NativeBridge/WindowInspector.cs`: HWND facts, process, class, title, rectangle, DPI and integrity checks.
- Create `native/AgentTui.NativeBridge/TerminalStructureInspector.cs`: UI Automation evidence for tab and Pane counts.
- Create `native/AgentTui.NativeBridge/InputInjector.cs`: guarded foreground verification and one-shot `Ctrl+C`.
- Create `native/AgentTui.NativeBridge/TransitionThumbnail.cs`: bounded DWM thumbnail lifecycle for drag-in transitions.
- Create `scripts/build-native-bridge.ps1`: deterministic `csc.exe` build.

### Electron and coordinator

- Create `electron/native-bridge-manager.ts`: helper lifecycle and named-pipe protocol.
- Create `electron/handoff-journal.ts`: atomic, disposable transaction journal.
- Create `electron/handoff-coordinator.ts`: idempotent transaction executor.
- Create `electron/handoff-coordinator-entry.ts`: detached coordinator process entry.
- Create `electron/handoff-service.ts`: Electron Main facade and state projection.
- Create `electron/windows-terminal.ts`: structured `wt.exe` launch and target-window tracking.
- Create `electron/transition-window.ts`: frameless drag-out preview sourced from the managed terminal buffer.
- Create `electron/adapters/codex-handoff-adapter.ts`: Codex native handoff implementation.
- Create `electron/adapters/claude-handoff-adapter.ts`: Claude Code native handoff implementation.
- Modify `electron/main.ts`: start/reconnect services and expose allowlisted IPC.
- Modify `electron/preload.ts`: expose typed drag/handoff calls only.
- Modify `electron.vite.config.ts`: add coordinator entry and copy native helper artifact.
- Modify `package.json`: native build and focused test scripts.

### Renderer

- Create `src/components/AgentWall.tsx`: stable 2-6 Agent grid and drop hit target.
- Create `src/components/AgentTile.tsx`: managed terminal tile with drag handle.
- Create `src/components/HandoffPlaceholder.tsx`: fixed-size `请稍后…` placeholder.
- Create `src/components/HandoffError.tsx`: retry/return actions for failed transactions.
- Create `src/hooks/useHandoffProjection.ts`: subscribe to transaction projection.
- Modify `src/App.tsx`: render the Agent wall and transaction overlays.
- Create or modify `src/styles.css`: stable grid, drag preview, crossfade and rollback motion.

### Tests and fixtures

- Create `tests/unit/handoff-state.test.ts`.
- Create `tests/unit/handoff-protocol.test.ts`.
- Create `tests/unit/handoff-journal.test.ts`.
- Create `tests/unit/codex-handoff-adapter.test.ts`.
- Create `tests/unit/claude-handoff-adapter.test.ts`.
- Create `tests/unit/agent-wall.test.tsx`.
- Create `tests/integration/native-bridge.test.ts`.
- Create `tests/integration/handoff-coordinator.test.ts`.
- Create `tests/integration/windows-terminal-launch.test.ts`.
- Create `tests/fixtures/handoff/fake-source.cjs`.
- Create `tests/fixtures/handoff/fake-target.cjs`.
- Create `tests/fixtures/handoff/codex-session.jsonl`.
- Create `tests/fixtures/handoff/claude-session.jsonl`.
- Create `tests/e2e/windows-terminal-handoff.test.ts`.
- Create `tests/native/WindowDragDriver.cs`: test-only Win32 mouse drag driver; never packaged.
- Create `scripts/build-native-test-driver.ps1`: compile the test-only drag driver.
- Create `tests/manual/windows-terminal-handoff-checklist.md`.

## Task 1: Define The Handoff Protocol And Safety Reducer

**Files:**
- Create: `src/shared/handoff-protocol.ts`
- Create: `src/shared/handoff-state.ts`
- Test: `tests/unit/handoff-protocol.test.ts`
- Test: `tests/unit/handoff-state.test.ts`

- [ ] **Step 1: Write failing protocol and reducer tests**

Create `tests/unit/handoff-state.test.ts` with the release-blocking invariants:

```ts
import { describe, expect, it } from 'vitest'

import { createHandoff, reduceHandoff } from '../../src/shared/handoff-state'

describe('handoff reducer', () => {
  it('never resumes the target before source persistence is confirmed', () => {
    const state = createHandoff({
      transactionId: 'tx-1',
      direction: 'native-to-managed',
      agentKind: 'codex',
      workspace: 'B:\\work',
      nativeSessionId: 'session-1'
    })

    expect(() => reduceHandoff(state, { type: 'target-resume-requested' })).toThrow(
      'source persistence is not confirmed'
    )
  })

  it('keeps the source until target readiness is confirmed', () => {
    const stopping = reduceHandoff(createHandoff({
      transactionId: 'tx-2',
      direction: 'managed-to-native',
      agentKind: 'claude',
      workspace: 'B:\\work',
      nativeSessionId: 'session-2'
    }), { type: 'source-stop-requested' })
    const persisted = reduceHandoff(stopping, { type: 'source-persisted' })
    const resuming = reduceHandoff(persisted, { type: 'target-resume-requested' })

    expect(() => reduceHandoff(resuming, { type: 'commit-requested' })).toThrow(
      'target is not ready'
    )
  })

  it('rolls back to the source after target failure', () => {
    let state = createHandoff({
      transactionId: 'tx-3',
      direction: 'native-to-managed',
      agentKind: 'codex',
      workspace: 'B:\\work',
      nativeSessionId: 'session-3'
    })
    state = reduceHandoff(state, { type: 'source-stop-requested' })
    state = reduceHandoff(state, { type: 'source-persisted' })
    state = reduceHandoff(state, { type: 'target-resume-requested' })
    state = reduceHandoff(state, { type: 'target-failed', reason: 'resume failed' })

    expect(state.phase).toBe('rolling_back')
    expect(state.sourceRemoved).toBe(false)
  })
})
```

Create `tests/unit/handoff-protocol.test.ts` and assert that runtime validation rejects unknown directions, missing HWND values, invalid rectangles, and native helpers requesting arbitrary key sequences.

- [ ] **Step 2: Run focused tests and verify red**

Run:

```powershell
npm test -- tests/unit/handoff-state.test.ts tests/unit/handoff-protocol.test.ts
```

Expected: FAIL because the two shared modules do not exist.

- [ ] **Step 3: Implement the protocol types and strict validators**

Define this public surface in `src/shared/handoff-protocol.ts`:

```ts
export type HandoffDirection = 'native-to-managed' | 'managed-to-native'

export type HandoffPhase =
  | 'probing'
  | 'awaiting_choice'
  | 'previewing'
  | 'stopping_source'
  | 'waiting_for_persistence'
  | 'resuming_target'
  | 'verifying_target'
  | 'committing'
  | 'completed'
  | 'rolling_back'
  | 'failed'
  | 'cancelled'

export interface NativeWindowFacts {
  hwnd: string
  processId: number
  processName: string
  className: string
  title: string
  rect: { left: number; top: number; right: number; bottom: number }
  integrity: 'same' | 'higher' | 'unknown'
  tabCount?: number
  paneCount?: number
  structureVerified: boolean
}

export type NativeBridgeCommand =
  | { type: 'inspect-window'; requestId: string; hwnd: string }
  | { type: 'send-graceful-interrupt'; requestId: string; hwnd: string; expectedProcessId: number; expectedTitle: string }
  | { type: 'close-source-window'; requestId: string; hwnd: string; expectedProcessId: number; expectedTitle: string }
  | { type: 'start-thumbnail'; requestId: string; sourceHwnd: string; destinationHwnd: string; destinationRect: NativeWindowFacts['rect'] }
  | { type: 'update-thumbnail'; requestId: string; destinationRect: NativeWindowFacts['rect'] }
  | { type: 'stop-thumbnail'; requestId: string }
  | { type: 'ping'; requestId: string }

export type NativeBridgeEvent =
  | { type: 'move-start'; window: NativeWindowFacts }
  | { type: 'move-update'; window: NativeWindowFacts; cursor: { x: number; y: number } }
  | { type: 'move-end'; window: NativeWindowFacts; cursor: { x: number; y: number } }
  | { type: 'command-result'; requestId: string; ok: boolean; reason?: string }
  | { type: 'pong'; requestId: string }

export function parseNativeBridgeEvent(value: unknown): NativeBridgeEvent
export function parseNativeBridgeCommand(value: unknown): NativeBridgeCommand
```

Validators must enumerate allowed keys and reject non-finite coordinates, non-positive PIDs, empty request IDs, unknown command types, thumbnail rectangles outside the destination window, and any keyboard command other than `send-graceful-interrupt`.

- [ ] **Step 4: Implement the pure state reducer**

Define `HandoffState`, `HandoffEvent`, `createHandoff`, and `reduceHandoff` in `src/shared/handoff-state.ts`. Store these facts explicitly:

```ts
export interface HandoffState {
  transactionId: string
  direction: HandoffDirection
  phase: HandoffPhase
  agentKind: 'codex' | 'claude'
  workspace: string
  nativeSessionId: string
  sourcePersisted: boolean
  targetStarted: boolean
  targetReady: boolean
  sourceRemoved: boolean
  lastError?: string
}
```

The reducer must throw on `target-resume-requested` before `sourcePersisted`, throw on `commit-requested` before `targetReady`, ignore duplicate fact events idempotently, allow cancellation only before `sourcePersisted`, and route target failures to `rolling_back`.

- [ ] **Step 5: Verify green and commit**

Run:

```powershell
npm test -- tests/unit/handoff-state.test.ts tests/unit/handoff-protocol.test.ts
npm run typecheck
```

Expected: both suites PASS and TypeScript exits 0.

Commit:

```powershell
git add src/shared/handoff-protocol.ts src/shared/handoff-state.ts tests/unit/handoff-protocol.test.ts tests/unit/handoff-state.test.ts
git commit -m "feat: define safe handoff transaction"
```

## Task 2: Build The Native Win32 Drag Bridge

**Files:**
- Create: `native/AgentTui.NativeBridge/Program.cs`
- Create: `native/AgentTui.NativeBridge/Protocol.cs`
- Create: `native/AgentTui.NativeBridge/WinEventMonitor.cs`
- Create: `native/AgentTui.NativeBridge/WindowInspector.cs`
- Create: `scripts/build-native-bridge.ps1`
- Modify: `package.json`
- Test: `tests/integration/native-bridge.test.ts`

- [ ] **Step 1: Write a failing native bridge integration test**

The test must build the helper, run `--self-test`, and verify one JSON line without starting a global hook:

```ts
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('native bridge', () => {
  it('builds and reports a versioned protocol', async () => {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/build-native-bridge.ps1'
    ])
    const child = spawn('build/native/AgentTui.NativeBridge.exe', ['--self-test'])
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    const exitCode = await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())

    expect(exitCode).toBe(0)
    expect(result).toEqual({ type: 'self-test', protocolVersion: 1, platform: 'windows' })
  })
})
```

- [ ] **Step 2: Run the test and verify red**

Run `npm test -- tests/integration/native-bridge.test.ts`.

Expected: FAIL because the build script and helper sources do not exist.

- [ ] **Step 3: Add a deterministic build script**

Create `scripts/build-native-bridge.ps1` that resolves the 64-bit framework compiler first, falls back to 32-bit, and fails with a clear message if neither exists:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$frameworkRoots = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
)
$framework = $frameworkRoots | Where-Object { Test-Path (Join-Path $_ 'csc.exe') } | Select-Object -First 1
if (-not $framework) { throw 'The Windows .NET Framework C# compiler is required.' }

$source = Join-Path $root 'native\AgentTui.NativeBridge'
$output = Join-Path $root 'build\native'
New-Item -ItemType Directory -Path $output -Force | Out-Null

& (Join-Path $framework 'csc.exe') /nologo /target:exe /optimize+ /platform:anycpu `
  /reference:(Join-Path $framework 'System.Web.Extensions.dll') `
  /reference:(Join-Path $framework 'WPF\UIAutomationClient.dll') `
  /reference:(Join-Path $framework 'WPF\UIAutomationTypes.dll') `
  /out:(Join-Path $output 'AgentTui.NativeBridge.exe') `
  (Join-Path $source '*.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Add `"build:native": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native-bridge.ps1"` to `package.json` and call it before the Electron build.

- [ ] **Step 4: Implement protocol DTOs and self-test mode**

Use `JavaScriptSerializer` with one JSON object per line. `Program.Main` must handle `--self-test`, `--pipe <name>`, and no other modes. Unknown arguments exit 2. `--self-test` prints exactly:

```json
{"type":"self-test","protocolVersion":1,"platform":"windows"}
```

`Protocol.cs` must define concrete DTO classes for move events, command results, ping, inspect, and graceful interrupt. Do not expose an arbitrary key-code field.

- [ ] **Step 5: Add WinEvent monitoring and window inspection**

`WinEventMonitor.cs` must P/Invoke `SetWinEventHook`, `UnhookWinEvent`, `GetMessageW`, `GetCursorPos`, and listen only to `EVENT_SYSTEM_MOVESIZESTART` (`0x000A`) and `EVENT_SYSTEM_MOVESIZEEND` (`0x000B`) with `WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS`. Between start and end, sample the active dragged HWND at 60ms intervals and emit `move-update` with current rectangle and cursor. Stop the sampler on end, invalid HWND, or helper shutdown.

`WindowInspector.cs` must collect `GetWindowRect`, `GetWindowTextW`, `GetClassNameW`, `GetWindowThreadProcessId`, the executable basename, current DPI, and integrity comparison. `TerminalStructureInspector.cs` uses UI Automation to count visible tab items and obtain verified Pane evidence; if either cannot be proven, set `structureVerified: false` and prohibit automatic input. Emit events only for top-level `WindowsTerminal.exe` windows. Keep the callback delegate rooted for the monitor lifetime.

`TransitionThumbnail.cs` wraps `DwmRegisterThumbnail`, `DwmUpdateThumbnailProperties`, and `DwmUnregisterThumbnail`. It accepts only the already-inspected source HWND and the registered Manager HWND, clips destination rectangles to the Manager client area, and always unregisters on stop, disconnect, source destruction, or process exit.

The named-pipe thread sends immutable event DTOs; the WinEvent callback must not block on pipe I/O.

- [ ] **Step 6: Extend the integration test to exercise inspection guards**

Start the helper against a test named pipe, send `inspect-window` for `0x0`, and assert `{ ok: false, reason: 'invalid-window' }`. Send `ping` and assert `pong`. This gives CI coverage without requiring a visible Windows Terminal.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npm run build:native
npm test -- tests/integration/native-bridge.test.ts
npm run typecheck
```

Expected: helper builds, integration suite passes, and typecheck exits 0.

Commit all Task 2 files with `git commit -m "feat: add Windows drag bridge"`.

## Task 3: Connect Drag Facts To The Agent Wall

**Files:**
- Create: `electron/native-bridge-manager.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Create: `src/components/AgentWall.tsx`
- Create: `src/components/HandoffPlaceholder.tsx`
- Create: `src/hooks/useHandoffProjection.ts`
- Modify: `src/App.tsx`
- Create or modify: `src/styles.css`
- Test: `tests/unit/agent-wall.test.tsx`

- [ ] **Step 1: Write failing Agent wall tests**

Mock the preload API and verify that a Windows Terminal move over the Manager bounds inserts exactly one fixed grid placeholder containing only `请稍后…`, and a move-end outside removes it. Also assert a direct multi-window rejection does not create a managed tile.

Use stable test IDs `agent-wall`, `handoff-placeholder`, and `agent-tile`; do not select by CSS animation classes.

- [ ] **Step 2: Verify red**

Run `npm test -- tests/unit/agent-wall.test.tsx`.

Expected: FAIL because the wall and projection hook do not exist.

- [ ] **Step 3: Implement `NativeBridgeManager`**

The manager must:

- create a current-user-only named pipe with an unpredictable suffix;
- spawn the compiled helper with `--pipe <name>`;
- parse every event through `parseNativeBridgeEvent`;
- restart the helper after unexpected exit with bounded backoff of 1, 4, and 12 seconds;
- expose `subscribe`, `inspectWindow`, `sendGracefulInterrupt`, `closeSourceWindow`, and thumbnail start/update/stop methods;
- stop restart attempts when Electron performs an explicit quit.

Do not pass a generic native command across Electron IPC. `closeSourceWindow` must repeat the HWND/PID/title checks and is callable only after the coordinator has journaled `targetReady: true`.

- [ ] **Step 4: Add narrow preload and Main IPC**

Expose only:

```ts
window.agentManager.handoff = {
  getProjection(): Promise<HandoffProjection | null>
  subscribe(listener: (projection: HandoffProjection | null) => void): () => void
  cancel(transactionId: string): Promise<void>
  retry(transactionId: string): Promise<void>
}
```

Renderer code must never receive `sendGracefulInterrupt`, raw HWND commands, filesystem paths outside display-safe workspace labels, or named-pipe names.

Task 3 may initially construct `NativeBridgeManager` in Electron Main for the focused UI test. Task 4 moves final ownership to the detached coordinator; after that change Electron Main only consumes coordinator projections and never owns an in-flight native transaction.

- [ ] **Step 5: Implement the stable grid and placeholder**

`AgentWall` uses `grid-template-columns: repeat(2, minmax(0, 1fr))` for 2-4 tiles and a responsive 3-column maximum for 5-6. Set a stable row size with `grid-auto-rows: minmax(220px, 1fr)` and do not let status text change card dimensions.

`HandoffPlaceholder` renders:

```tsx
export function HandoffPlaceholder(): JSX.Element {
  return (
    <div className="handoff-placeholder" data-testid="handoff-placeholder" aria-live="polite">
      <span>请稍后…</span>
    </div>
  )
}
```

Do not show `PTY`, `Session Host`, `handoff`, `resume`, or `正在交接` in normal UI.

- [ ] **Step 6: Verify and commit**

Run the focused renderer suite, full typecheck, and build. Expected: PASS, zero TypeScript errors, helper copied into the build output.

Commit with `git commit -m "feat: preview terminal drops in agent wall"`.

## Task 4: Add The Durable Handoff Journal And Detached Coordinator

**Files:**
- Create: `electron/handoff-journal.ts`
- Create: `electron/handoff-coordinator.ts`
- Create: `electron/handoff-coordinator-entry.ts`
- Modify: `electron.vite.config.ts`
- Test: `tests/unit/handoff-journal.test.ts`
- Test: `tests/integration/handoff-coordinator.test.ts`
- Create: `tests/fixtures/handoff/fake-source.cjs`
- Create: `tests/fixtures/handoff/fake-target.cjs`

- [ ] **Step 1: Write failing atomic-journal tests**

Test that `write(state)` creates one JSON record through temp-file plus atomic rename, `read(transactionId)` validates with the shared parser, truncated JSON is quarantined instead of trusted, and `remove(transactionId)` never touches paths outside the configured runtime directory.

- [ ] **Step 2: Write failing coordinator invariant tests**

The fake source writes a native session fixture before exiting. The fake target creates a lock file while active. Assert:

```ts
it('starts the target only after the source exits and persists', async () => {
  const result = await harness.dragNativeToManaged()
  expect(result.timeline).toEqual([
    'source-stop-requested',
    'source-exited',
    'source-persisted',
    'target-started',
    'target-ready',
    'committed'
  ])
  expect(result.maxConcurrentAgents).toBe(1)
})

it('restores the source when the target cannot resume', async () => {
  const result = await harness.dragManagedToNative({ failTarget: true })
  expect(result.phase).toBe('completed')
  expect(result.owner).toBe('managed-source')
  expect(result.maxConcurrentAgents).toBe(1)
})
```

- [ ] **Step 3: Verify red**

Run the two focused suites. Expected: FAIL because journal and coordinator do not exist.

- [ ] **Step 4: Implement the journal**

Use a caller-provided runtime directory. Resolve every transaction path, verify it remains a direct child of that directory, write `<id>.tmp`, flush and close, then rename to `<id>.json`. Journal data contains only `HandoffState`, timestamps, source/target runtime facts, and sanitized errors. It must reject terminal output and arbitrary conversation fields at validation time.

- [ ] **Step 5: Implement the coordinator as an idempotent effect runner**

Separate pure transition from effects:

```ts
export interface HandoffEffects {
  stopSource(state: HandoffState): Promise<void>
  confirmSourcePersisted(state: HandoffState): Promise<void>
  startTarget(state: HandoffState): Promise<void>
  confirmTargetReady(state: HandoffState): Promise<void>
  removeSource(state: HandoffState): Promise<void>
  restoreSource(state: HandoffState): Promise<void>
  stopFailedTarget(state: HandoffState): Promise<void>
}
```

Before every effect, re-read process/window facts. After every fact, reduce and atomically journal the new state. On restart, derive the next effect from the journal and observed facts; never repeat `startTarget` if a matching target is already alive.

- [ ] **Step 6: Build a detached entry and reconnect protocol**

Add a separate electron-vite main entry for `handoff-coordinator-entry.ts`. Electron Main starts it detached with ignored stdio and a current-user named pipe. The coordinator owns `NativeBridgeManager` and its helper process, remains alive during Renderer/Main restarts, exits after no active transactions and a bounded idle period, and can be rediscovered from a disposable runtime registry. Electron Main reconnects to the coordinator instead of starting a second native helper.

- [ ] **Step 7: Add crash-point tests**

Terminate and restart the coordinator after every phase. For each case assert `maxConcurrentAgents === 1`, the same `nativeSessionId`, and either the intended target or restored source reaches ready. A corrupt Manager journal must fall back to native session recovery, not delete Agent data.

- [ ] **Step 8: Verify and commit**

Run journal, coordinator, foundation native-resume, full typecheck, and build. Commit with `git commit -m "feat: coordinate crash-safe terminal handoffs"`.

## Task 5: Implement Codex And Claude Native Handoff Adapters

**Files:**
- Create: `src/shared/native-handoff-adapter.ts`
- Create: `electron/adapters/codex-handoff-adapter.ts`
- Create: `electron/adapters/claude-handoff-adapter.ts`
- Create: `tests/fixtures/handoff/codex-session.jsonl`
- Create: `tests/fixtures/handoff/claude-session.jsonl`
- Test: `tests/unit/codex-handoff-adapter.test.ts`
- Test: `tests/unit/claude-handoff-adapter.test.ts`

- [ ] **Step 1: Define adapter contract tests before the interface**

Each adapter suite must verify:

- supported version detection from an injected CLI probe;
- read-only session discovery scoped to a workspace;
- unique candidate auto-selection and ambiguous candidate reporting;
- exact structured resume executable/args/cwd;
- persistence confirmation without modifying native history;
- unknown versions return `nativeHandoff: false`;
- normal completion is never presented as a handoff failure or Continue request.

- [ ] **Step 2: Verify red**

Run both focused suites. Expected: FAIL because adapter modules and fixtures do not exist.

- [ ] **Step 3: Define the capability interface**

Create this boundary in `src/shared/native-handoff-adapter.ts`:

```ts
export interface NativeSessionCandidate {
  agentKind: 'codex' | 'claude'
  nativeSessionId: string
  workspace: string
  updatedAt: number
  displayTitle?: string
}

export interface ResumeCommand {
  executable: string
  args: string[]
  cwd: string
}

export interface NativeHandoffAdapter {
  readonly agentKind: 'codex' | 'claude'
  capabilities(): Promise<{ nativeHandoff: boolean; version: string }>
  discoverCandidates(facts: NativeWindowFacts): Promise<NativeSessionCandidate[]>
  confirmPersisted(candidate: NativeSessionCandidate): Promise<void>
  buildManagedResume(candidate: NativeSessionCandidate): ResumeCommand
  buildNativeResume(candidate: NativeSessionCandidate): ResumeCommand
  confirmReady(candidate: NativeSessionCandidate, targetPid: number): Promise<void>
}
```

- [ ] **Step 4: Implement Codex adapter against fixtures and installed CLI help**

Build the command as executable `codex`, args `['resume', candidate.nativeSessionId]`, cwd `candidate.workspace`. Read native metadata only through an injected discovery provider. The production provider may read stable Codex session metadata but never rewrites it. Gate support on a version/help probe that confirms `resume` accepts a session ID.

- [ ] **Step 5: Implement Claude adapter against fixtures and installed CLI help**

Build the command as executable `claude`, args `['--resume', candidate.nativeSessionId]`, cwd `candidate.workspace`. Use the same read-only and version-gated rules. Do not infer readiness from silence; require the process to be alive plus adapter-validated startup/session evidence.

- [ ] **Step 6: Verify no native data mutation and commit**

Hash fixture/native metadata before and after discovery and persistence checks; hashes must match. Run adapter suites, typecheck, and the foundation native-resume test. Commit with `git commit -m "feat: add native handoff adapters"`.

## Task 6: Guard External Ctrl+C And Launch Native Windows Terminal

**Files:**
- Create: `native/AgentTui.NativeBridge/InputInjector.cs`
- Modify: `native/AgentTui.NativeBridge/Program.cs`
- Modify: `native/AgentTui.NativeBridge/WindowInspector.cs`
- Create: `electron/windows-terminal.ts`
- Test: `tests/integration/native-bridge.test.ts`
- Test: `tests/integration/windows-terminal-launch.test.ts`

- [ ] **Step 1: Write failing input-guard tests**

Send `send-graceful-interrupt` with mismatched HWND, PID, title, non-Windows-Terminal class, higher integrity, and non-foreground target. Every case must return `ok: false` and send no input. Add a helper self-test target that records received virtual keys so the one valid case can assert exactly `VK_CONTROL down`, `C down`, `C up`, `VK_CONTROL up`.

- [ ] **Step 2: Write failing `wt.exe` argument tests**

Inject an executable launcher and assert:

```ts
expect(buildWindowsTerminalLaunch({
  cwd: 'B:\\Ai Demo\\Project',
  resume: { executable: 'codex', args: ['resume', 'session 1'], cwd: 'B:\\Ai Demo\\Project' }
})).toEqual({
  executable: 'wt.exe',
  args: ['-w', 'new', '-d', 'B:\\Ai Demo\\Project', 'codex', 'resume', 'session 1']
})
```

No test may flatten this into a single Shell string.

- [ ] **Step 3: Implement guarded injection**

Immediately before `SendInput`, re-check `IsWindow`, PID, title, class, foreground HWND, single-tab/single-pane evidence, current user and integrity. Refuse if any fact changed. The command expires after five seconds and may execute only once per request ID.

- [ ] **Step 4: Implement structured Windows Terminal launch**

Use `spawn('wt.exe', args, { cwd, windowsHide: false, shell: false, detached: true })`. Track the new terminal window through the Native Drag Bridge and correlate it with a one-time non-controlling launch token. Do not launch `atm attach`, do not retain a PTY proxy, and remove the token after correlation succeeds or times out.

- [ ] **Step 5: Verify and commit**

Run native build, native bridge tests, Windows Terminal launch tests, typecheck, and build. Commit with `git commit -m "feat: guard native terminal ownership transfer"`.

## Task 7: Wire Bidirectional Handoffs Into Session Host And UI

**Files:**
- Create: `electron/handoff-service.ts`
- Create: `electron/transition-window.ts`
- Modify: `electron/session-host-manager.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Create: `src/components/AgentTile.tsx`
- Create: `src/components/HandoffError.tsx`
- Modify: `src/components/AgentWall.tsx`
- Modify: `src/hooks/useHandoffProjection.ts`
- Modify: `src/styles.css`
- Test: `tests/integration/handoff-coordinator.test.ts`
- Test: `tests/unit/agent-wall.test.tsx`

- [ ] **Step 1: Write failing drag-in orchestration test**

Feed a unique external Codex candidate and assert the service sequence is: placeholder, guarded source stop, persistence confirmation, Session Host resume, adapter ready, source window removal, managed tile. Assert approval and recovery capabilities become enabled only after `committing` completes.

- [ ] **Step 2: Write failing drag-out orchestration test**

Start from a managed Claude Session Host and assert: drag preview, source stop, persistence confirmation, structured `wt.exe` resume, native ready, Session Host release, tile removal. After commit, calls to approve, write, resize, or auto-recover that session must be rejected as unmanaged.

- [ ] **Step 3: Implement `HandoffService` effects**

Map coordinator effects to the selected adapter, `NativeBridgeManager`, `SessionHostManager`, and `WindowsTerminalLauncher`. Management ownership changes only in the `committing` effect. Retry reuses the same transaction ID and observed target; it must not create another Agent process.

- [ ] **Step 4: Implement Renderer projection and error actions**

Projection contains only:

```ts
export interface HandoffProjection {
  transactionId: string
  direction: HandoffDirection
  phase: HandoffPhase
  insertIndex?: number
  sourceSessionId?: string
  message?: '请稍后…' | '恢复失败，已返回原终端' | '恢复失败，Agent 仍在总览中'
  canCancel: boolean
  canRetry: boolean
}
```

`Esc` calls cancel only when `canCancel` is true. `HandoffError` uses explicit retry and return commands. Do not nest cards or resize the grid while messages change.

- [ ] **Step 5: Add crossfade and rollback motion**

Use transform/opacity transitions with stable grid tracks. Respect `prefers-reduced-motion` by removing movement while preserving state changes. For drag-in, Main asks the native helper to render a DWM thumbnail into the placeholder bounds until the managed xterm has painted nonblank output, then crossfades and unregisters the thumbnail. For drag-out, `transition-window.ts` creates a frameless, noninteractive preview BrowserWindow using a bounded snapshot of the managed terminal buffer; it follows the cursor, stays visible until the real Windows Terminal target is ready, then crossfades and closes. Rollback follows the inverse transform, destroys all preview resources, and returns focus to the source.

- [ ] **Step 6: Verify both directions and commit**

Run focused unit/integration suites, the full test suite, typecheck, and build. Commit with `git commit -m "feat: ship bidirectional native terminal handoff"`.

## Task 8: Prove Real Windows Terminal Handoff And Package The Helper

**Files:**
- Create: `tests/e2e/windows-terminal-handoff.test.ts`
- Create: `tests/native/WindowDragDriver.cs`
- Create: `scripts/build-native-test-driver.ps1`
- Create: `tests/manual/windows-terminal-handoff-checklist.md`
- Modify: `electron.vite.config.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Add an automated Windows smoke harness**

The E2E harness must skip with an explicit reason when Windows Terminal, Codex, Claude, or an interactive desktop is absent. `scripts/build-native-test-driver.ps1` compiles `tests/native/WindowDragDriver.cs` to `build/test-native/WindowDragDriver.exe`. The driver accepts only `--hwnd`, `--from`, and `--to`, verifies the target is `WindowsTerminal.exe`, and performs a real title-bar mouse drag with `SetCursorPos` and `SendInput`; it is never copied to application resources. When prerequisites exist, create an isolated workspace and native session fixture, launch a single-tab Windows Terminal, use this test-only driver to drag it over the Manager test window, and assert the same native session ID appears in the managed tile.

The reverse test drags the tile out, verifies a real `WindowsTerminal.exe` window becomes interactive, then terminates Manager Main and Session Hosts and confirms the native Agent remains resumable.

- [ ] **Step 2: Add crash matrix and 50-cycle soak mode**

Parameterize coordinator termination at every phase. Record maximum concurrent matching Agent processes and fail above one. Add `ATM_HANDOFF_SOAK=50` mode that repeats both directions and checks for orphan helper processes, stale transaction records, duplicate sessions, residual windows, and residual tiles.

- [ ] **Step 3: Add visual acceptance checks**

Capture screenshots at 100%, 125%, 150%, and 200% DPI for 2, 4, and 6 Agent grids. Assert the placeholder rectangle equals the final tile rectangle, screenshot pixels are nonblank throughout the transition, text stays inside controls, and no card overlaps another.

- [ ] **Step 4: Package the helper and coordinator entries**

`npm run build` must build the native helper first and copy only `AgentTui.NativeBridge.exe` beside packaged Electron resources. Include the coordinator entry in the main build. Do not package C# sources as runtime dependencies, and do not require the user to install .NET SDK; the compiled helper targets the Windows .NET Framework available on supported systems.

Add `"test:e2e:handoff": "vitest run tests/e2e/windows-terminal-handoff.test.ts"` to `package.json`. Keep the test-only drag driver out of the normal `build` script and packaged resources.

- [ ] **Step 5: Write the manual release checklist**

Include exact checks for single window, tab tear-out, whole multi-tab rejection, multiple candidates, elevated terminal rejection, multi-monitor negative coordinates, maximize/minimize, `Esc`, source stop failure, target resume failure, Renderer crash, Main crash, coordinator crash, power-loss simulation, and deletion of Manager data followed by native CLI resume.

- [ ] **Step 6: Run final release verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e:handoff
```

Then run the real manual checklist for both Codex and Claude. Expected: all automated commands exit 0; every checklist item passes; no test observes two active processes for one native session; drag-out remains usable after Manager and Session Hosts stop.

- [ ] **Step 7: Commit release proof**

```powershell
git add tests/e2e tests/manual electron.vite.config.ts package.json package-lock.json .gitignore README.md
git commit -m "test: prove native terminal handoff safety"
```

## Verification Checklist Before Claiming Completion

- [ ] Foundation Session Host and native-resume ownership tests pass.
- [ ] Native helper builds without an additional SDK install.
- [ ] External drag detection uses WinEvent facts, not Renderer HTML drag events.
- [ ] Drag-in enables full management only after commit.
- [ ] Drag-out uses real `wt.exe`, has no Session Host relay, and disables all Manager control after commit.
- [ ] Source persistence precedes target resume in every trace.
- [ ] Target readiness precedes source removal in every trace.
- [ ] Unknown versions, ambiguous sessions, multiple panes, and elevated terminals fail closed.
- [ ] Normal Agent completion never triggers Continue because of handoff code.
- [ ] Renderer/Main/coordinator crash tests recover or roll back idempotently.
- [ ] Manager data deletion does not prevent native `codex resume` or `claude --resume`.
- [ ] Visual transitions show `请稍后…`, never `正在交接`, and never display a blank terminal.
- [ ] Real Codex and Claude pass bidirectional and 50-cycle soak tests.
