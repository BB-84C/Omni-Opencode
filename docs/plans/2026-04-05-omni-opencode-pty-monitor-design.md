# Omni-Opencode PTY Monitor Design

**Date:** 2026-04-05

**Goal**

Replace the current child-session event-projection architecture with a plugin-only control-plane design where OpenCode launches external Codex and Claude Code jobs as tool-driven background tasks, live progress is monitored through a real terminal runtime, and the plugin reports completion back into the parent OpenCode session.

**Why this design exists**

The previous architecture proved that native Task cards can be created, but it also exposed public API limits that make a perfect external-subagent illusion impractical without OpenCode core changes. In particular:

- plugin-written session updates land as injected user-style log messages
- keeping a native Task card open while streaming back into that same session is not reliable
- child-session lifecycle and external-agent lifecycle cannot be kept perfectly aligned with current public APIs

This design stops fighting those limits. OpenCode becomes the orchestration cockpit. A PTY or tmux session becomes the live execution surface.

## Architecture Overview

The plugin exposes parent-facing delegation tools such as `delegate_to_claude` and `delegate_to_codex`. When called, the plugin broker starts the external backend inside a dedicated terminal runtime:

- Windows: `node-pty` with ConPTY
- Linux/macOS: `tmux`

The plugin returns immediately with monitor metadata and attaches the job to the parent OpenCode session. The broker continues monitoring the runtime asynchronously, captures terminal output and structured checkpoints, and posts a completion update back into the parent session when the external agent finishes.

The plugin does not try to emulate native assistant-role event streaming in OpenCode. Instead, it gives the user two surfaces:

1. OpenCode parent session for launch, status, and completion summaries
2. live PTY/tmux monitor for raw real-time output

## Monitoring UX

The plugin supports both:

- auto-open monitor by default
- manual attach commands always available

### Windows

On Windows, the plugin launches the backend inside a `node-pty` / ConPTY-backed shell. The plugin should not assume it can embed that terminal into the currently running Warp terminal pane. Instead it should:

- manage the PTY itself
- expose a stable attach/view command
- optionally auto-open a separate terminal window or monitor surface

### Linux/macOS

On Linux/macOS, the plugin launches the backend inside a named `tmux` session or pane. It exposes:

- the `tmux` session name
- a raw attach command such as `tmux attach -t omni-claude-17`
- optional auto-open attach behavior

### Launch Return Shape

Each delegation tool returns monitor metadata such as:

- `jobId`
- `backend`
- `status`
- `runtimeType`
- `monitorMode`
- `attachCommand`
- `rawAttachCommand`
- `autoOpenSucceeded`

## Parent Session Reporting

Every external job is tied to the parent OpenCode session ID that launched it. The broker persists per-job state including:

- `jobId`
- `parentSessionId`
- `backend`
- `runtimeType`
- `runtimeHandle`
- `status`
- `attachCommand`
- `startedAt`
- `finishedAt`
- `lastOutputPreview`
- `finalReport`
- `terminalLogPath`
- `transcriptChunks`
- `exitCode`
- `autoOpened`
- `autoClosed`

When the backend exits, the plugin posts a completion update into the parent session containing:

- backend name
- job ID
- completion status
- short summary
- final report or extracted result
- changed files if any
- whether the monitor was auto-closed

This update is now treated as an operational plugin message, not as an attempt to fake native assistant subagent output.

## Broker Data Ownership

The broker owns the durable runtime history of each external job. This is critical because we cannot assume OpenCode, Codex, or Claude Code will always expose a stable transcript retrieval API that matches our needs later.

The broker should capture:

- raw terminal output incrementally
- structured checkpoints derived from output or backend metadata
- final extracted report
- a transcript/log that can be read later through plugin tools

This enables a completion policy of summary-by-default while still preserving access to the full captured history.

## Backend Execution Strategy

The live monitoring source of truth is always the managed terminal runtime.

### Codex

Preferred operational path:

- run `codex` inside PTY/tmux
- capture stdout/stderr and exit code
- optionally use structured Codex interfaces secondarily for richer summary extraction

### Claude Code

Preferred operational path:

- run `claude` inside PTY/tmux
- capture stdout/stderr and exit code
- optionally use Agent SDK or structured output secondarily for summary extraction

This is intentionally different from the current child-session projection path because the PTY/tmux runtime is more reliable for true live monitoring and easier to debug when jobs stall.

## Completion Policy

Default policy is:

- post a concise completion summary into the parent session
- preserve full transcript and full output in broker-owned logs
- expose a later read path through plugin tools

If transcript capture fails or final extraction is incomplete, the plugin may fall back to posting more of the final output into the parent session.

## Cleanup Policy

When the external job finishes, the broker should:

1. finalize transcript/log capture
2. extract summary and final report
3. post completion update to parent session
4. close the PTY or tmux session if auto-cleanup is enabled
5. keep logs available for later inspection regardless of runtime cleanup

If auto-cleanup is disabled, the runtime stays available for manual inspection.

## Why this is better than the current design

- no dependence on `session.idle`
- no attempt to fake native assistant-role subagent streaming
- no mismatch between external backend lifecycle and native Task-card lifecycle
- real live progress through the actual terminal runtime
- better debugging surface for stalled Claude or Codex jobs

## Recommended Migration Path

1. Keep broker/state foundations
2. Reintroduce parent-facing delegation tools as the main UX
3. Remove wrapper-agent child-session streaming as the primary path
4. Add PTY/tmux runtime manager
5. Add monitor auto-open and attach commands
6. Add parent-session completion reporting and transcript-read tools
