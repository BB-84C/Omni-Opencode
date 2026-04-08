# Omni-Opencode Shared Monitor Design

**Date:** 2026-04-06

**Goal**

Evolve Omni-Opencode from per-job monitor windows into a per-parent-session shared terminal workspace where all delegated Codex and Claude Code jobs from one OpenCode session appear in one interactive monitor, while batch completion and aggregate resume behavior continue to work per parent turn.

## Core Design Shift

The current design is still too job-centric on the terminal side:

- each delegated job effectively owns its own monitor surface
- Windows monitor attach still centers around broker-managed PTY/log plumbing rather than a true shared CLI workspace
- Linux/macOS currently expose per-job `tmux` sessions rather than one shared session per parent OpenCode session

The new design keeps the existing tool-driven delegation and batch-resume behavior, but replaces the monitor model:

- completion grouping stays per turn via `batchId`
- monitor grouping moves to per parent OpenCode session via `monitorSessionId`

This creates two separate axes:

1. **Execution / resume grouping**
   - all jobs launched from the same parent turn share a `batchId`
   - batch completion still wakes the main OpenCode agent only after all jobs in that turn finish

2. **Terminal / interaction grouping**
   - all delegated jobs launched from the same parent OpenCode session share one monitor workspace
   - the attach command becomes stable for that parent session

## Architecture Overview

Introduce a new shared monitor abstraction:

- `MonitorSession`
  - one shared interactive terminal workspace
  - keyed by parent OpenCode session ID
  - reused across multiple delegated jobs launched from that same OpenCode session

- `DelegatedJob`
  - still keyed by `jobId`
  - belongs to one `batchId`
  - belongs to one `monitorSessionId`

Launch flow becomes:

1. user asks the main OpenCode agent to delegate to Codex and/or Claude Code
2. the agent calls `delegate_to_codex` and/or `delegate_to_claude`
3. the plugin resolves the parent session's shared `MonitorSession`
4. the delegated job is added into that session's monitor workspace
5. the tool returns immediately with:
   - `jobId`
   - `batchId`
   - `parentSessionId`
   - `monitorSessionId`
   - backend
   - running status
   - stable attach command for the shared monitor session
   - monitor target
   - auto-open attempted/succeeded
6. the main OpenCode agent reports launch metadata and stops
7. the plugin tracks job completion in the background
8. when all jobs in a `batchId` finish, the plugin injects one aggregate follow-up user message
9. the main OpenCode agent resumes from that aggregate follow-up

## Monitoring UX

### Windows

Windows must stop pretending that a broker log or per-job PTY follower is the real terminal surface.

Instead, the plugin should create one visible multiplexer host process per parent OpenCode session:

- source entrypoint: `windows-multiplexer.js`
- one visible terminal UI window
- one host process per parent OpenCode session
- one PTY child per delegated Codex/Claude job
- live pane rendering, focus tracking, and stdin routing inside the host

Behavior:

- first delegated job in a parent OpenCode session:
  - create the monitor host
  - auto-open the shared terminal window
  - create the first PTY pane
- later delegated jobs in that same parent session:
  - reuse the same host/window
  - add new PTY panes

This is required because `node-pty` gives PTY children, not a full multi-pane interactive user experience by itself.

### Linux/macOS

Use one shared `tmux` session per parent OpenCode session.

- first delegated job creates the shared `tmux` session and first pane/window
- later delegated jobs join that same `tmux` session as new panes/windows
- `tmux` remains the native interaction surface and attach layer

### Shared-Monitor Requirement

For one main OpenCode session:

- all delegated external subagents must show in one shared monitor workspace
- the shared workspace must be interactive, not read-only
- the user must be able to focus one delegated agent and send input to its real CLI

## Attach Command Contract

The attach command becomes session-scoped.

### Windows

Every delegated job launched from the same parent OpenCode session should return the same attach command:

```bash
node "D:\Omni-Opencode\dist\runtime\windows-multiplexer.js" attach --session "<parentSessionId>"
```

Optional focused attach may be added later, for example:

```bash
node "D:\Omni-Opencode\dist\runtime\windows-multiplexer.js" attach --session "<parentSessionId>" --focus "<jobId>"
```

### Linux/macOS

Every delegated job launched from the same parent OpenCode session should return the same attach command:

```bash
tmux attach -t omni-<parentSessionId>
```

## Launch Result Contract

Each delegation tool should return:

- `jobId`
- `batchId`
- `parentSessionId`
- `monitorSessionId`
- `backend`
- `status`
- `attachCommand`
- `monitorTarget`
- `autoOpenAttempted`
- `autoOpenSucceeded`

Important changes from the current implementation:

- Windows `attachCommand` is no longer job-specific
- `monitorTarget` is no longer primarily the log path on Windows
- the broker log becomes secondary inspection, not the primary live terminal surface

## Interaction Model

### Windows multiplexer host

The host should manage:

- pane layout
- active/focused pane
- stdin routing to the focused PTY child
- per-pane labels such as backend, job label, and status
- status lines with enough information to resemble a terminal multiplexer rather than a log tailer

Suggested controls:

- `Tab` / `Shift-Tab` to cycle focus
- `Ctrl+1..9` to jump to a pane
- optional prefix-based layout controls for split/resize/toggle operations

### Linux/macOS

Native `tmux` behavior already handles:

- focus changes
- pane/window layout
- scrolling
- keyboard routing to the focused pane

## Failure Handling

### Monitor-session creation failure

- delegation tool returns explicit failure
- `autoOpenSucceeded` must not be reported as true
- attach command is only returned if a shared monitor session was actually created

### Job launch failure inside an existing monitor session

- the monitor session remains alive
- the failed job is marked failed
- other delegated jobs in the same parent session continue running

### Shared monitor crash

- if delegated CLIs survive, attach should recreate or recover the monitor surface if possible
- if recovery fails, aggregate completion still reports job results plus monitor recovery failure

### Batch completion

Batch completion remains unchanged:

- all jobs launched from the same parent turn share one `batchId`
- send exactly one aggregate follow-up user message after all jobs in that `batchId` are terminal

## Verification Standard

Do not call this design complete in implementation unless a live OpenCode session proves:

1. Windows
- first delegated job auto-opens one shared multiplexer window
- second delegated job in the same parent OpenCode session reuses that same window
- returned attach command is:
  - `node "D:\Omni-Opencode\dist\runtime\windows-multiplexer.js" attach --session "<parentSessionId>"`
- all delegated jobs in that parent session return the same attach command
- the shared window is attached to the real Codex/Claude CLIs, not broker log playback
- input reaches the focused delegated CLI

2. Linux/macOS
- first delegated job auto-opens one shared `tmux` session
- second delegated job in the same parent OpenCode session reuses that same `tmux` session
- all delegated jobs in that parent session return the same attach command

3. Main agent lifecycle
- main OpenCode agent launches delegated jobs
- main OpenCode agent returns job IDs, batch ID, and shared attach command, then stops
- plugin injects one aggregate follow-up after the whole batch finishes
- the resumed assistant replies from that follow-up rather than polling

## Recommended Migration Path

1. keep the current batch-resume behavior intact
2. introduce `MonitorSession` as a new shared runtime concept
3. refactor runtime APIs from job-centric monitor open to session-centric monitor ensure/attach
4. implement Windows multiplexer host with one PTY child per delegated job
5. refactor Linux/macOS `tmux` runtime to one shared session per parent OpenCode session
6. update delegation tool payloads to return shared-session attach metadata
7. update tests and live verification to prove shared-window reuse and real interactive attachment
