# Omni-Opencode External Subagents Design

**Date:** 2026-04-04

**Goal**

Build an OpenCode plugin that allows the main OpenCode agent to delegate work to Codex and Claude Code as child-session-backed external subagents. The user experience should feel like OpenCode-native subagent delegation: the parent session stays compact, each delegated task gets a real child session, and the child session streams detailed engineering activity in real time.

**Non-goals**

- Perfect one-to-one replay of Codex or Claude Code internal event contracts
- ACP-first integration architecture
- Read-only advisory mode only

## Architecture

The system uses an OpenCode plugin as the control plane, a broker runtime as the delegation engine, and backend adapters for Codex and Claude Code. OpenCode remains the owner of session structure. Every delegated task gets a real OpenCode child session, while the plugin and broker manage the external backend lifecycle, event normalization, interrupt/resume state, and final reconciliation.

The plugin creates and manages child sessions, subscribes to OpenCode events, and projects normalized delegated activity into the child session timeline. The broker owns runtime state such as backend thread IDs, current phase, command/tool activity, changed files, and resumability metadata. Backend-specific transport details stay inside adapters.

## Streaming Model

The plugin must define a canonical delegated-event schema rather than forwarding raw backend events. This keeps the OpenCode UX stable even if Codex or Claude Code change their runtime protocols.

Recommended canonical event types:

- `assistant.delta`
- `assistant.message`
- `reasoning.note`
- `tool.start`
- `tool.output.delta`
- `tool.end`
- `command.start`
- `command.stdout.delta`
- `command.stderr.delta`
- `file.change`
- `patch.ready`
- `status.update`
- `approval.requested`
- `warning`
- `error`
- `result.final`

The child session should stream meaningful progress such as planning steps, command output, file edits, patch checkpoints, and final summaries. It should not degrade to generic lifecycle markers like `agent started`, `tool called`, or `agent finished`.

## Session Ownership And Data Flow

OpenCode owns session structure. The plugin stores a mapping from `opencodeChildSessionID` to `brokerJobID` to backend thread ID. The broker owns runtime state. The child session is the user-visible log, while the broker is the execution authority.

Proposed flow:

1. Parent agent requests delegation.
2. Plugin creates an OpenCode child session with metadata such as backend type, mode, cwd, and broker job ID.
3. Plugin submits the job to the broker.
4. Broker starts or resumes the backend runtime.
5. Backend emits raw events.
6. Adapter maps raw events to canonical delegated events.
7. Plugin projects those events into the child session timeline.
8. On completion, plugin records final summary, changed files, exit state, and optional patch/diff summary.
9. Parent session receives a compact completion note that links to the child session.

The parent session must stay compact. The child session carries the detailed trace.

## Execution, Permissions, And Safety

Delegated child jobs are allowed to edit files and run commands in the workspace, but only through plugin-managed policy.

The design has three policy layers:

1. OpenCode policy
2. Broker policy
3. Backend policy translation

OpenCode policy decides which parent agents can delegate, which backends are allowed, which directories are in scope, whether shell execution and editing are allowed, and whether network access is allowed.

Broker policy enforces cwd/worktree boundaries, timeouts, concurrency, cancellation, and change tracking. It refuses backend launches that violate OpenCode policy.

Backend policy translation maps the plugin permission envelope into Codex- and Claude-specific runtime settings. Backend-native approvals may still exist, but OpenCode remains the primary control plane.

High-risk actions such as broad shell execution, networked commands, writes outside the project root, destructive VCS operations, and git push should surface as meaningful child-session entries.

## Backend Adapters

The broker exposes a single internal interface such as:

- `startJob()`
- `resumeJob()`
- `cancelJob()`
- `subscribeEvents()`
- `getSnapshot()`

Each adapter implements that interface.

### Codex Adapter

Preferred transport is `codex app-server`. This is more stable and expressive than scraping CLI output and naturally supports threads, turns, job lifecycle, and structured notifications.

### Claude Code Adapter

Preferred transport is the Anthropic Agent SDK. This is cleaner and more capable than parsing CLI output and is already proven in external streaming integrations. `claude -p --output-format stream-json --bare` should exist only as a fallback compatibility path.

The adapters may differ internally, but they must emit the same canonical event model upward. OpenCode should not need to care which backend is powering a child session after normalization.

## Rendering, Recovery, And Verification

The plugin maintains a projection layer between canonical delegated events and OpenCode session messages.

Responsibilities of the projection layer:

- coalesce tiny text deltas into readable updates
- stream stdout and stderr in bounded chunks
- turn tool and command activity into timeline-friendly entries
- record file-change and patch checkpoints
- preserve structured event logs for recovery and debugging

Recovery behavior:

- on OpenCode restart or plugin reload, rehydrate persisted broker jobs
- reconnect backend streams where possible
- resume projection into existing child sessions
- if live reattachment is impossible, record a recovery note and recover final state if available

Verification requirements:

- child-session creation works for both Codex and Claude Code
- detailed live event flow appears in child sessions
- delegated jobs can edit files and run shell commands in the workspace
- cancellation works
- restart recovery works
- final summaries and changed-file reporting are correct

The child session is not a raw backend trace. It is a curated, durable operational log of delegated engineering work.

## Interrupt, Inspect, And Resume

Interrupt/resume must be first-class. The plugin cannot rely only on OpenCode's SQLite storage and cannot rely only on the external backend. It needs both OpenCode session history and a plugin-owned broker store.

Persist in the OpenCode child session:

- streamed projected progress
- command/output checkpoints
- file-change checkpoints
- interrupt summary messages
- final or partial result summaries

Persist in the broker store:

- `childSessionID`
- `backend`
- `brokerJobID`
- `backendThreadID` or resume token
- `status`
- last canonical event sequence
- active command/tool at interruption
- changed files snapshot
- resumable flag
- last checkpoint timestamp

If the user interrupts a child session, the plugin should interrupt the backend and write a final checkpoint into the child session with last phase, last meaningful output, active command or tool, changed files so far, and resumability state.

The main OpenCode agent should be able to inspect and resume external child jobs through plugin surfaces such as:

- `delegated_jobs_list`
- `delegated_job_snapshot(childSessionID)`
- `delegated_job_resume(childSessionID, instruction?)`
- `delegated_job_cancel(childSessionID)`

Preferred resume behavior is to continue the original backend thread using stored resume identifiers. If exact backend continuation is unavailable, the plugin should start a new backend run seeded with the child session transcript, interrupt checkpoint, changed file snapshot, and an explicit continue instruction.

## Recommended Initial Delivery Order

1. Plugin skeleton and broker abstraction
2. Canonical event schema and projection layer
3. Fake adapter for end-to-end child-session streaming tests
4. Codex adapter via app-server
5. Claude Code adapter via Agent SDK
6. Interrupt, inspect, cancel, and resume surfaces
7. Restart recovery and hardening

## References

- OpenCode plugin, server, SDK, agents, commands, and custom tools docs
- `openai/codex-plugin-cc` for host-plugin plus broker/app-server architecture patterns
- `zebbern/claude-code-discord` for Agent SDK streaming normalization patterns
- `xx025/openab` as an example of what happens when the bridge collapses everything into final-string-only output
