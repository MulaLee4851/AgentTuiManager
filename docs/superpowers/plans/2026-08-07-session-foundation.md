# Session Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working vertical slice of Agent TUI Manager: a Windows-first Electron shell can launch a real PTY-backed CLI session through an independent local Session Host, reconnect after the desktop process restarts, and preserve native Agent resume behavior when Manager data is absent.

**Architecture:** Electron Renderer owns only the UI. Electron Main owns the allowlisted IPC surface and a registry of independent Session Host child processes. Each Session Host owns one `node-pty` instance and launches the selected CLI with the user’s normal environment and working directory; it never becomes the source of conversation data. Shared TypeScript contracts and a pure session reducer keep state transitions testable before UI integration.

**Tech Stack:** Electron, React, TypeScript, Vite via `electron-vite`, `@xterm/xterm`, `node-pty`, Vitest, Testing Library, and Node child-process fixtures.

---

## Scope Boundary

This plan deliberately implements the durable session foundation only. Codex/Claude semantic adapters, approval policy learning, notifications, native history indexing, and the complete terminal-wall UI are follow-up plans that will consume the contracts created here. The foundation must already run a generic configured command and prove that Manager-owned state is not required for native resume.

## File Map

- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`
- Create: `electron/main.ts`, `electron/preload.ts`, `electron/session-host.ts`, `electron/session-host-manager.ts`
- Create: `src/shared/protocol.ts`, `src/shared/session-state.ts`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/vite-env.d.ts`
- Create: `tests/unit/session-state.test.ts`, `tests/unit/protocol.test.ts`
- Create: `tests/fixtures/fake-agent.cjs`, `tests/integration/session-host-manager.test.ts`
- Create: `tests/e2e/native-resume-fixture.test.ts`
- Create: `README.md`
- Modify: `.gitignore`

### Task 1: Scaffold the Electron/React workspace

**Files:** Create the project files listed above except the test files and Session Host implementation.

- [ ] **Step 1: Add the package manifest and scripts**

Create `package.json` with these scripts and dependencies. Keep the Electron entry in `dist-electron/main.js` so `electron-vite` can package the main process without runtime path guessing.

```json
{
  "name": "agent-tui-manager",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@xterm/xterm": "^5.3.0",
    "electron": "^31.0.0",
    "node-pty": "^1.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "electron-vite": "^2.3.0",
    "jsdom": "^24.1.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Add strict TypeScript and Electron Vite configuration**

`tsconfig.json` must enable `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`, and include `src`, `electron`, and `tests`. `tsconfig.node.json` must include `electron.vite.config.ts`.

Create `electron.vite.config.ts` with React renderer support and separate main/preload entries:

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react()] },
});
```

- [ ] **Step 3: Install dependencies and verify the empty shell builds**

Run:

```text
npm install
npm run typecheck
npm run build
```

Expected: dependency installation completes, TypeScript reports no errors, and `dist-electron/` plus the renderer build are produced. Do not start an Agent yet.

- [ ] **Step 4: Commit the scaffold**

```text
git add package.json package-lock.json electron.vite.config.ts tsconfig.json tsconfig.node.json
git commit -m "build: scaffold electron session manager"
```

### Task 2: Define shared session contracts and reducer first

**Files:** Create `src/shared/protocol.ts`, `src/shared/session-state.ts`, and `tests/unit/session-state.test.ts`, `tests/unit/protocol.test.ts`.

- [ ] **Step 1: Write failing reducer tests**

`tests/unit/session-state.test.ts` must cover the safety rules before implementation:

```ts
it('marks a normal exit completed and never requests recovery', () => {
  const state = reduceSession(runningSession, {
    type: 'process-exited',
    exitCode: 0,
    userInitiated: false,
    adapterCompletion: true,
  });
  expect(state.status).toBe('completed');
  expect(state.recoveryAttempts).toBe(0);
});

it('keeps a user stop stopped even when the process exits non-zero', () => {
  const state = reduceSession(runningSession, {
    type: 'process-exited',
    exitCode: 1,
    userInitiated: true,
    adapterCompletion: false,
  });
  expect(state.status).toBe('stopped');
});

it('recovers only explicit abnormal exits and stops after three attempts', () => {
  const first = reduceSession(runningSession, { type: 'abnormal-exit', reason: 'connection-reset' });
  const second = reduceSession(first, { type: 'recovery-failed', reason: 'resume-failed' });
  const third = reduceSession({ ...second, recoveryAttempts: 2 }, { type: 'recovery-failed', reason: 'resume-failed' });
  expect(first.status).toBe('recovering');
  expect(second.status).toBe('recovering');
  expect(third.status).toBe('failed');
});

it('does not auto-continue on unknown evidence or silence', () => {
  expect(reduceSession(runningSession, { type: 'unknown' }).status).toBe('unknown');
  expect(reduceSession(runningSession, { type: 'no-output-timeout' }).status).toBe('running');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run `npm test -- tests/unit/session-state.test.ts`. Expected: FAIL because `reduceSession` and the event types do not exist.

- [ ] **Step 3: Implement the pure reducer and protocol types**

In `src/shared/session-state.ts`, define:

```ts
export type SessionStatus =
  | 'starting' | 'running' | 'needs_approval' | 'recovering'
  | 'completed' | 'stopped' | 'failed' | 'unknown';

export interface SessionState {
  sessionId: string;
  workspace: string;
  status: SessionStatus;
  recoveryAttempts: number;
  userStopRequested: boolean;
  lastError?: string;
}

export type SessionEvent =
  | { type: 'started' }
  | { type: 'approval-required' }
  | { type: 'process-exited'; exitCode: number; userInitiated: boolean; adapterCompletion: boolean }
  | { type: 'abnormal-exit'; reason: string }
  | { type: 'recovery-failed'; reason: string }
  | { type: 'unknown' }
  | { type: 'no-output-timeout' }
  | { type: 'user-stop-requested' };

export function reduceSession(state: SessionState, event: SessionEvent): SessionState;
```

The reducer must return new objects, preserve `running` on `no-output-timeout`, treat `user-stop-requested` as terminal intent, and cap recovery at three attempts. It must not send commands or perform I/O.

In `src/shared/protocol.ts`, define the host messages:

```ts
export type HostCommand =
  | { type: 'start'; executable: string; args: string[]; cwd: string; cols: number; rows: number }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'stop' }
  | { type: 'ping' };

export type HostEvent =
  | { type: 'ready'; hostId: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' };
```

The protocol must not contain conversation text or Manager database paths as required fields. The native CLI owns its session data.

- [ ] **Step 4: Run unit tests and typecheck**

Run `npm test -- tests/unit/session-state.test.ts tests/unit/protocol.test.ts` and `npm run typecheck`. Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the contracts**

```text
git add src/shared tests/unit
git commit -m "feat: define safe session state and host protocol"
```

### Task 3: Implement the independent Session Host

**Files:** Create `electron/session-host.ts`, `tests/fixtures/fake-agent.cjs`, and `tests/integration/session-host-manager.test.ts`; modify `electron/session-host-manager.ts` after the test harness exists.

- [ ] **Step 1: Create a deterministic fake Agent fixture**

`tests/fixtures/fake-agent.cjs` must accept `--mode running|normal-exit|crash`, print a recognizable ANSI prompt, echo stdin, and exit with code 0 for `normal-exit` or code 1 for `crash`. This fixture must never touch the repository or Manager data directory.

- [ ] **Step 2: Write failing Session Host integration tests**

The tests must spawn the host with the fake fixture and assert:

```ts
it('forwards PTY output and input without writing Manager session data', async () => {
  const host = await manager.start({ executable: process.execPath, args: [fixture, '--mode', 'running'], cwd: tempWorkspace });
  await expect(host.nextEvent()).resolves.toMatchObject({ type: 'output' });
  await host.write('hello\\r');
  await expect(host.nextEvent()).resolves.toMatchObject({ type: 'output', data: expect.stringContaining('hello') });
  expect(await listFiles(tempWorkspace)).toEqual([]);
});

it('reports normal and abnormal exits as facts', async () => {
  const normal = await manager.start({ executable: process.execPath, args: [fixture, '--mode', 'normal-exit'], cwd: tempWorkspace });
  await expect(normal.nextEvent()).resolves.toMatchObject({ type: 'exit', exitCode: 0 });
  const crash = await manager.start({ executable: process.execPath, args: [fixture, '--mode', 'crash'], cwd: tempWorkspace });
  await expect(crash.nextEvent()).resolves.toMatchObject({ type: 'exit', exitCode: 1 });
});
```

- [ ] **Step 3: Run the integration tests and verify they fail**

Run `npm test -- tests/integration/session-host-manager.test.ts`. Expected: FAIL because `SessionHostManager` and `session-host.ts` do not exist.

- [ ] **Step 4: Implement `session-host.ts`**

Use `fork()` with an IPC channel and `node-pty.spawn()` inside the child. Pass the current process environment unchanged except for explicitly documented Manager metadata variables. Use `cwd` from the request, create the requested initial size, forward `onData` as `{ type: 'output' }`, and forward PTY exit as `{ type: 'exit' }`. Implement `write`, `resize`, `stop`, and `ping`. `stop` must call `pty.kill()` and never delete files.

- [ ] **Step 5: Implement `SessionHostManager`**

Expose `start`, `write`, `resize`, `stop`, `listLiveHosts`, and `reconnect(hostId)`. Store only a runtime registry record containing host ID, Agent kind, cwd, native session ID if known, PID, and Named Pipe/IPC endpoint. Put the registry under the per-user Manager runtime directory; make it disposable and explicitly non-authoritative.

On Electron Main restart, `listLiveHosts()` must validate each endpoint with `ping`, remove only stale registry entries, and return live hosts. Never remove Agent CLI directories or history files during cleanup.

- [ ] **Step 6: Run the integration tests and commit**

Run `npm test -- tests/integration/session-host-manager.test.ts` and `npm run typecheck`. Expected: PASS. Commit with:

```text
git add electron/session-host.ts electron/session-host-manager.ts tests/fixtures tests/integration
git commit -m "feat: add durable independent session host"
```

### Task 4: Wire Electron Main, secure preload, and the minimal terminal wall

**Files:** Create/modify `electron/main.ts`, `electron/preload.ts`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, and `src/vite-env.d.ts`.

- [ ] **Step 1: Write the renderer contract test**

Add `tests/unit/app.test.tsx` and assert that the initial view renders a workspace name, a session tile, and a visible state badge from mocked `window.agentManager.listSessions()`.

- [ ] **Step 2: Run the renderer test and verify it fails**

Run `npm test -- tests/unit/app.test.tsx`. Expected: FAIL because the preload bridge and `App` do not exist.

- [ ] **Step 3: Implement a narrow preload bridge**

Expose only these methods through `contextBridge`:

```ts
window.agentManager = {
  listSessions(): Promise<SessionState[]>;
  startSession(request: StartSessionRequest): Promise<string>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  stopSession(sessionId: string): Promise<void>;
  subscribe(listener: (event: HostEvent & { sessionId: string }) => void): () => void;
};
```

No generic `execute`, arbitrary filesystem, shell, or Node API may cross the bridge. Main validates workspace paths and executable configuration before forwarding a `start` command.

- [ ] **Step 4: Implement the minimal A-layout renderer**

Render a 2-by-2 responsive terminal wall with stable tile dimensions. Each tile has Agent name, workspace, status, live `@xterm/xterm` instance, maximize control, and stop control. Use a fake session fixture in the unit test and the real Session Host in development. Do not implement approval learning in this task; show an inert “needs approval” state until the policy plan is executed.

- [ ] **Step 5: Connect Main to SessionHostManager**

Create the BrowserWindow with context isolation and sandboxed renderer settings. Route allowlisted IPC calls to `SessionHostManager`, reduce host facts through `reduceSession`, and broadcast normalized events. On startup, reconnect live hosts before showing an empty state. On window close, hide to tray instead of stopping hosts.

- [ ] **Step 6: Run tests, typecheck, build, and smoke-test the shell**

Run:

```text
npm test -- tests/unit/app.test.tsx
npm run typecheck
npm run build
npm run dev
```

Expected: tests PASS, build succeeds, and the desktop window shows the terminal wall. Start `node tests/fixtures/fake-agent.cjs --mode running` through the configured generic command, type into the tile, resize the window, and verify output remains interactive.

- [ ] **Step 7: Commit the vertical slice**

```text
git add electron src tests/unit/app.test.tsx
git commit -m "feat: ship reconnectable terminal wall slice"
```

### Task 5: Prove native resume safety before adding smart features

**Files:** Create `tests/e2e/native-resume-fixture.test.ts` and `docs/superpowers/plans/2026-08-07-adapters-and-approval.md` only after the safety test passes.

- [ ] **Step 1: Add a native-resume fixture contract**

The test harness must define an `AgentAdapter` fixture with `start`, `resume`, `discover`, and `nativeDataPath` methods. Its conversation file lives outside the Manager runtime and database directories. The test must assert that Manager cleanup never deletes or modifies that file.

- [ ] **Step 2: Write the crash and database-loss test**

The test must:

1. Start the fixture through Session Host.
2. Write two conversation turns so the native fixture persists a session ID.
3. Stop only Electron Main and confirm the host can be reconnected.
4. Stop the host and delete the temporary Manager SQLite/runtime directory.
5. Call the fixture adapter’s native `resume(sessionId)` from the original workspace.
6. Assert the same session ID and conversation content are available.

- [ ] **Step 3: Run the safety test and fix any ownership violation**

Run `npm test -- tests/e2e/native-resume-fixture.test.ts`. Expected: PASS. If the fixture needs any Manager database or terminal log to resume, remove that dependency before proceeding.

- [ ] **Step 4: Commit the safety proof**

```text
git add tests/e2e/native-resume-fixture.test.ts
git commit -m "test: prove native session recovery without manager data"
```

### Follow-up Plans After This Slice

Create and execute these plans only after the foundation plan passes:

1. `docs/superpowers/plans/2026-08-07-adapters-and-approval.md`: Codex/Claude deep adapters, native history discovery, command parsing, built-in rules, user rules, three-approval learning, and high-risk hard boundaries.
2. `docs/superpowers/plans/2026-08-07-workbench-and-notifications.md`: A-layout polish, inline approval, detail drawer, processing center, tray, Windows notifications, 30-day log retention, and end-to-end UI tests.

Each follow-up plan must reuse `src/shared/protocol.ts`, `src/shared/session-state.ts`, and the native-resume safety test rather than introducing a second session model.

## Verification Checklist Before Claiming Foundation Complete

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] A real PTY-backed CLI is interactive in the terminal wall.
- [ ] Normal exit is `completed` and does not trigger recovery.
- [ ] User stop is `stopped` and does not trigger recovery.
- [ ] Explicit abnormal exit attempts at most three recoveries.
- [ ] Electron Main restart reconnects live Session Host processes.
- [ ] Removing Manager SQLite/runtime data does not remove native session data.
- [ ] Native resume works from the original workspace after Manager data removal.

