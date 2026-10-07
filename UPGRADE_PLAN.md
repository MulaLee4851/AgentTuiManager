# Next upgrade: implementation and acceptance

Baseline: 0.4.12-local.3, commit 9d89fd2. User approved unattended implementation of the entire scope below. Work in an isolated checkout; deliver verified source and a Windows installer to the original repository without restarting the active application. Do not inspect real credential files or expose secrets. Tests use fictional credentials and isolated application data.

## Required scope

- [x] Main navigation: compact icon rail by default, hover/focus expansion, pin expanded, optional fully hidden state; persist preferences. Panels expand as overlays without remounting terminals.
- [x] Agent list: independently collapsible, hover/focus expansion and pinning; preserve pending badges, dragging, selection and attention sound semantics.
- [x] Hide workspace scope label when grouping does not apply.
- [x] Navigation groups: Overview and Attention always primary; Audit and Token Usage under collapsible Statistics; remaining entries under collapsible Settings. Persist group expansion.
- [x] Shared searchable CC Switch picker for Agent creation/edit and reviewer import; search nonsecret summaries; preserve selection and refresh behavior.
- [x] Favorite workspaces: persistent named paths, add/rename/edit/remove, one-click launcher fill, missing path handling. Removing a shortcut never removes its directory.
- [x] History recovery: newest 50 top-level Codex sessions across all workspaces, searchable metadata, original cwd automatically populated, direct recovery action, avoid duplicate managed sessions and handle missing directories. Ordering must remain correct for large histories.
- [x] Reviewer pool: named, ordered, enabled entries for API and CLI reviewers; migrate existing settings and encrypted credentials.
- [x] Main-process-only CC Switch reviewer import; encrypted credential snapshots, no secrets in renderer, logs or subprocess arguments.
- [x] Reviewer API adapters for OpenAI Chat Completions, OpenAI Responses and Anthropic Messages; model listing and connection validation with sanitized errors, manual model fallback.
- [x] Ordered failover A -> B -> C only on service/protocol failure; bounded overall deadline and cancellation, discard late results. Valid denial never triggers another reviewer. All services failing results in denial.
- [x] Rules and Agent auto-approval modes have exactly two final outcomes: allow/deny. No manual/uncertain fallback, pending user authorization or approval notification in automatic modes. Denial gives accurate reason and actionable request revision guidance. Manual mode remains separate; unattended mode remains available.
- [x] Preserve current terminal lifecycle, attention sound (background app or inactive Agent), provider import, security and legacy configuration behavior.
- [x] Verify every requirement using targeted tests, full applicable suite/typecheck/build, isolated packaged UI/runtime checks, and Windows installer verification.

## Implementation order

1. Shared picker, navigation and favorite workspaces.
2. Global Codex history recovery.
3. Reviewer pool, migration, protocols, imports, model selection.
4. Failover integration and strict binary automatic results.
5. Requirement-by-requirement audit, build and delivery.

## Evidence / progress

- Baseline repository clean; source-only inspection completed. Fresh isolated checkout created from the committed source. No real credential data inspected.
- Completed all scope above. Requirement-by-requirement evidence, test coverage and known limits are recorded in UPGRADE_VERIFICATION.md.
- Final build/typecheck/diff checks passed; 88 test files passed with 1,250 tests passed and 2 conditional skips. Three packaged-archive smoke runs passed. All 14 current build files match the archive; all 276 extracted installer files match the unpacked app. Four final UI screenshots reviewed.
- The reported rejection was the local 16,384-character completeness gate, not an AI decision. Complete commands now have a separate 131,072-character transport/assessment limit, precise input diagnostics and bounded audit previews; AI prompts and routing are retained.
- Native activity binding follows validated live transcripts without rewriting recovery identity; the restart-before-next-hook limitation is documented.
- Guarded delivery targets the original repository and its release directory, with per-file SHA-256 validation. No commit, push, installation or live application restart.
