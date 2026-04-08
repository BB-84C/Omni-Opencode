# Omni-Opencode Batch Resume Design

**Date:** 2026-04-06

**Goal**

Refine Omni-Opencode so external Codex and Claude Code delegation works as a tool-driven background-agent system with real terminal monitoring, explicit attach commands, automatic monitor opening, and an `oh-my-opencode`-style aggregate completion message that wakes the main OpenCode agent only after all delegated jobs from the same turn finish.

## Core Design Shift

The current PTY/tmux design is directionally correct but incomplete. It launches external jobs and exposes snapshots, but it does not yet fully match the intended lifecycle:

- the main agent should stop after confirming delegated jobs are running
- the plugin should own batch completion detection
- the plugin should inject one follow-up user message when the whole batch finishes
- the main agent should resume from that follow-up rather than poll or sleep

This design keeps the plugin-only constraint and avoids OpenCode core changes. OpenCode remains the orchestration cockpit. The broker/runtime owns live external job execution and aggregation behavior.

## Delegation Lifecycle

1. User asks the main OpenCode agent to delegate work to Codex and/or Claude Code.
2. The main agent calls `delegate_to_codex` and/or `delegate_to_claude`.
3. The plugin creates or reuses a `batchId` for all delegated jobs launched from that parent turn.
4. Each delegated job is started in a monitored runtime:
   - Windows: `node-pty` through a helper process plus a monitor window
   - Linux/macOS: `tmux`
5. Each delegation tool returns immediately with:
   - `jobId`
   - `batchId`
   - backend
   - running status
   - attach command
   - monitor target
   - auto-open attempted/succeeded
   - parent session ID
6. The main agent reports that delegation is in progress and stops.
7. The plugin watches all jobs in the batch in the background.
8. When all jobs in the batch are terminal, the plugin injects one aggregate user message into the parent session.
9. The main agent resumes from that aggregate user message.

## Monitoring UX

### Windows

The plugin launches external execution through a Node helper that owns `node-pty`. The plugin must also auto-open a separate PowerShell monitor window by default.

Important correction: `Get-Content -Wait` is not a real PTY attach. It is only a log tail.

Therefore Windows needs two monitor surfaces:

- `attachCommand`: the primary user-facing monitor entrypoint, for example `omni monitor <jobId>`
- `logTailCommand`: optional read-only fallback, such as `Get-Content -Path <log> -Wait`

### Linux/macOS

Use `tmux` as both the execution runtime and the primary attach surface:

- `attachCommand`: `tmux attach -t <session>`

### Launch Result Contract

Every delegation tool result must include:

- `jobId`
- `batchId`
- `backend`
- `status`
- `attachCommand`
- `monitorTarget`
- `autoOpenAttempted`
- `autoOpenSucceeded`
- `parentSessionId`

The attach command is required even when auto-open succeeds.

## Batch Completion And Resume

All jobs launched from the same parent turn belong to the same `batchId`.

The broker tracks:

- job IDs in the batch
- backend and runtime handles
- current status
- per-job summaries
- transcript/log paths

Completion rule:

- send exactly one aggregate follow-up user message after all jobs in the batch are terminal

Terminal states:

- `completed`
- `failed`
- `cancelled`

The aggregate follow-up user message should include:

- `batchId`
- each `jobId`
- backend per job
- status per job
- concise summary per job
- attach/read/snapshot commands for deeper inspection
- whether auto-open monitor windows were launched

This follow-up message is what wakes the main OpenCode agent back up.

## Inspection Surfaces

The plugin should expose three levels of inspection:

1. **Summary**
   - concise aggregate message in the parent session

2. **Snapshot**
   - `delegated_job_snapshot(jobId)`
   - returns structured metadata such as:
     - status
     - backend
     - batchId
     - attach command
     - monitor target
     - transcript size/chunk counts
     - cleanup state
     - summary

3. **Transcript Read**
   - `delegated_job_read(jobId)`
   - bounded transcript access or latest unread output
   - should remain opt-in to avoid flooding the main agent context

The main agent should receive only summaries by default and inspect full history only if it explicitly decides to do so.

## Failure Handling

### Launch failure

If a delegated job cannot start:

- tool returns explicit failure
- include backend and error
- include attach command only if a monitor was actually created

If a multi-job batch has mixed launch success:

- only successfully launched jobs are tracked in the batch
- the main agent is told which launches failed versus started

### Runtime failure

If a delegated job crashes:

- mark job `failed`
- preserve transcript/log path
- include concise failure summary in the aggregate follow-up
- still wait for the rest of the batch before waking the main agent

## Verification Standard

Do not call the plugin ready unless a live OpenCode session proves:

- parent-facing `delegate_to_claude` / `delegate_to_codex` are visible and used
- delegation tools return `jobId`, `batchId`, and attach/monitor commands
- Windows auto-opens a monitor window
- Linux/macOS auto-opens `tmux` attach
- the main agent stops after launch confirmation
- the plugin injects one aggregate follow-up user message when the whole batch finishes
- the aggregate follow-up includes concise summaries plus commands/tools for full transcript inspection
- the main agent resumes from that follow-up instead of polling or sleeping
