# Native Adapters, Approval Policy, and Notifications Plan Skeleton

## Goal

Add Codex and Claude native adapters, an explicit approval policy with bounded learning, and user notifications without making Manager data authoritative for native sessions.

## Foundation to Reuse

- Keep `src/shared/protocol.ts` as the only Session Host transport contract; do not add conversation payloads or Manager database paths.
- Keep `src/shared/session-state.ts` as the session lifecycle model.
- Reuse `discoverNativeSessions` from `electron/native-session-discovery.ts`; adapters must not implement a second history scanner.
- Keep `tests/e2e/native-resume-fixture.test.ts` as a required regression gate: native resume must still work from the original workspace after Manager runtime/SQLite loss.

## Execution Skeleton

### 1. Define and test the adapter contract

- [ ] Specify `start`, `resume`, `discover`, and `nativeDataPath` behavior for Codex and Claude.
- [ ] Require workspace validation for every resume and discovery result.
- [ ] Add temp-root contract tests that never invoke real CLIs or read real user directories.

### 2. Implement the Codex native adapter

- [ ] Write failing tests for start/resume command construction and workspace mismatch rejection.
- [ ] Delegate discovery to the existing `discoverNativeSessions('codex', ...)`.
- [ ] Implement the minimum adapter and rerun the native-resume safety gate.

### 3. Implement the Claude native adapter

- [ ] Write failing tests for start/resume command construction and workspace mismatch rejection.
- [ ] Delegate discovery to the existing `discoverNativeSessions('claude', ...)`.
- [ ] Implement the minimum adapter and rerun the native-resume safety gate.

### 4. Design and implement approval policy and learning

- [ ] Define pure policy inputs, decisions, precedence, and auditable reasons before wiring UI or process I/O.
- [ ] Test built-in rules, user rules, explicit denials, and high-risk boundaries.
- [ ] Add bounded learning only from repeated explicit approvals; learned rules must remain reviewable and removable.
- [ ] Keep approval state orthogonal to native session ownership and reuse the existing `needs_approval` session state.

### 5. Add notifications

- [ ] Define notification events for approval required, completion, and failure.
- [ ] Test deduplication and suppression without launching OS notifications.
- [ ] Wire Electron notifications behind the narrow Main/preload boundary.

### 6. Verify the phase

- [ ] Run focused adapter, policy, and notification tests.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Rerun `tests/e2e/native-resume-fixture.test.ts` and confirm Manager data loss still leaves native session bytes unchanged.

## Out of Scope for the Foundation Task

This document is a plan only. The current task does not implement Codex/Claude adapters, approval rules or learning, notification delivery, a new protocol, or a second session-state model.
