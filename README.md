# Omni-Opencode

Plugin-driven OpenCode integration for delegated external subagents backed by Codex and Claude Code.

## Delegation Model

The primary path is tool-driven and batch-aware.

- The parent session calls `delegate_to_claude` and `delegate_to_codex` directly.
- Every launch returns immediately with `jobId`, `batchId`, backend, running status, attach command, monitor target, and auto-open status.
- All delegated jobs started from the same parent turn share one `batchId`.
- The main agent should confirm the launches and stop. It should not poll delegated jobs in the same turn.
- The plugin injects one aggregate follow-up user message only after all jobs in the batch reach terminal state.
- Detailed history remains opt-in through `delegated_job_snapshot`, `delegated_job_read`, and `delegated_job_attach`.

## Real-World Usage

Use the parent session tools directly:

- `delegate_to_claude` starts a Claude Code run and returns batch-aware launch metadata immediately.
- `delegate_to_codex` starts a Codex run and returns the same launch contract.
- `delegated_job_snapshot` shows the current delegated job record, including `batchId`, attach command, transcript capture progress, summary, changed files, and cleanup metadata.
- `delegated_job_read` reads newly available runtime output.
- `delegated_job_attach` refreshes attach metadata so a UI or operator can reconnect to the active monitor target.

The parent session stays compact by design. Detailed runtime output is captured by the runtime monitor and surfaced only on demand.

## Monitor Behavior

- Launch results include attach metadata immediately so operators can inspect the live terminal without waiting for completion.
- While the runtime is still active, the background monitor keeps polling output and snapshots, appending transcript chunks and updating stored transcript byte and chunk counts.
- Once the whole batch reaches terminal state, the plugin posts one concise aggregate resume message back to the parent session.
- Final delegated job records include cleanup metadata: `cleanupState=completed` and a `cleanupReason` of `completed`, `failed`, or `cancelled`.

## Attach Behavior

### Windows

- Execution runs through the Windows PTY helper runtime.
- The plugin auto-opens a monitor window by default.
- The primary attach surface is the returned attach command, for example `omni monitor <jobId>`.
- A log-tail fallback may also be present for read-only inspection.

### Linux/macOS

- Execution runs in `tmux`.
- The attach command is the native `tmux attach -t <session>` surface.

## Manual Verification

Manual smoke-check sequence:

1. Launch delegated work with `delegate_to_claude` and/or `delegate_to_codex`.
2. Confirm each launch returns `jobId`, `batchId`, and an attach command immediately.
3. Confirm the monitor window/session auto-opens.
4. Confirm the main agent reports the launches and stops instead of polling.
5. Wait for the plugin to inject one aggregate follow-up user message for the finished batch.
6. Confirm that follow-up includes concise summaries plus `delegated_job_snapshot`, `delegated_job_read`, and attach references.

## Initial Goal

Build an OpenCode plugin that lets the main OpenCode agent launch Codex or Claude Code as child-session-backed subagents with rich streamed progress, interrupt/resume support, and real workspace edit/command access.

## Docs

- Design: `docs/plans/2026-04-04-omni-opencode-external-subagents-design.md`
- Implementation plan: `docs/plans/2026-04-04-omni-opencode-external-subagents.md`
