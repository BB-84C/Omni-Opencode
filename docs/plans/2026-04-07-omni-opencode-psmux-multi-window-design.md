# Omni-Opencode psmux Multi-Window Design

**Date:** 2026-04-07

## Goal

Revise the Windows `psmux` integration around what is actually proven to work: one shared `psmux` session, one dashboard window, and one real window per delegated external agent. The dashboard becomes a control/index surface, and users switch to real agent windows instead of embedding agent panes inside dashboard slots.

## Core Principle

The Windows UX must be based only on behavior proven against the real managed `psmux` binary.

Proven working primitives:

- detached `psmux` session creation
- attach to a real session
- real 3-pane dashboard layout
- real interactive Codex window in the shared session
- real interactive Claude Code window in the shared session
- switching between windows in the same session

Unproven / rejected primitives:

- `display-pane`
- synthetic pane targets like `.right`, `.right-top`, `.right-bottom`
- embedding external agent panes into dashboard slots via `join-pane` / `break-pane`

## Current Proven Manual Behavior

The following manual probes have already been validated against the managed `psmux` binary in this workspace:

1. A detached shared `psmux` session can be created and later attached successfully.
2. A stable 3-pane dashboard window can be created using real `split-window` commands.
3. Real interactive Codex and Claude sessions can both run inside the same `psmux` session.
4. Real Codex and Claude sessions work reliably as separate windows inside that session.
5. Native `psmux` window switching (`Ctrl+b` then `p` / `n`) works for moving between dashboard, Codex, and Claude windows.

These manual probes also established the following important negative results:

1. `display-pane` is not a valid production primitive for the intended dashboard composition model.
2. Synthetic dashboard pane target names are not valid.
3. `join-pane` / `break-pane` did not provide a reliable way to embed or replace live job panes inside dashboard panes in the required way.
4. The attempted embedded-pane model should be treated as abandoned for production.

## Session Model

Use one shared `psmux` session per parent OpenCode session.

Inside that session:

- window `0`: dashboard
- window `1..N`: one real window per delegated job

The dashboard window is the default attach landing point.

## Dashboard Window

The dashboard is a two-pane window `0`:

- **Left pane:** a dedicated long-lived dashboard process (not a shell)
- **Right pane:** a normal interactive PowerShell shell

The left pane runs a Node.js process that polls a session-local JSON snapshot file and renders ANSI-styled status content. It never shows a shell prompt.

The dashboard process is file-driven:

- the plugin/runtime writes a snapshot file when job state changes
- the dashboard process detects version changes and redraws
- no `send-keys` rendering is used

Its role is:

- control/index surface for the session
- list all delegated jobs with status markers (running/completed/failed/stopped)
- animated spinners for running jobs
- navigation hints for switching to real job windows

It should not attempt to mirror or embed the actual agent terminal into dashboard panes.

If the dashboard process exits unexpectedly, the runtime respawns it via `respawn-pane` without disturbing the right-pane shell or job windows.

## Agent Windows

Each delegated job runs in its own real `psmux` window using the real CLI directly:

- Codex => `codex`
- Claude Code => `claude`

These windows are canonical execution homes.

The user interacts with those windows exactly like normal terminal sessions.

## Window Switching Model

The dashboard remains window `0`.

When the user selects a job from the dashboard, the runtime should switch the active client to the corresponding real job window.

This should use real `psmux` window selection primitives, for example:

```bash
psmux select-window -t <session>:<windowIndex>
```

The dashboard should then remain reachable as:

```bash
psmux select-window -t <session>:0
```

## Latest-Two Policy

The latest two jobs should remain special, but as dashboard metadata rather than embedded panes.

They should be:

- highlighted in the dashboard list
- first-class quick-select targets
- optionally shown with shortcut labels

But they remain normal real windows.

## Plugin Role

The plugin remains the control plane only.

It should:

- create/reuse the shared `psmux` session
- create dashboard window `0`
- create one real window per delegated job
- return a stable attach command
- keep background bookkeeping via `pipe-pane`

It should not try to synthesize a terminal display surface.

## Attach Contract

Attach command remains:

```bash
<managed-psmux-path> attach -t <monitorSessionId>
```

That attach lands in dashboard window `0` by default.

## Background Bookkeeping

Keep the current `pipe-pane` bookkeeping model.

It remains responsible for:

- `delegated_job_read`
- transcript extraction
- summaries
- aggregate follow-up

This is independent of the visible terminal surface.

## Verification Standard

Do not call the revised Windows `psmux` model complete unless a live session proves:

1. first delegated job creates one shared detached `psmux` session
2. attach lands in dashboard window `0`
3. dashboard window exists and is stable
4. each delegated job runs in its own real `psmux` window
5. Codex window is a real interactive Codex CLI
6. Claude window is a real interactive Claude CLI
7. switching from dashboard to a selected job window works
8. returning to dashboard works
9. latest two jobs are highlighted in the dashboard
10. background `pipe-pane` bookkeeping still works
11. aggregate batch follow-up still works

## Current Implementation State

As of 2026-04-08:

- the multi-window model is fully implemented and committed
- the dashboard process model replaces the shell-backed left pane:
  - dedicated dashboard process in left pane (not PowerShell)
  - session-local snapshot file drives the dashboard display
  - ANSI-styled rendering with color, spinners, and status markers
  - `respawn-pane` recovery for the dashboard process
- focused verification is green:
  - `5` focused test files
  - `101` tests
  - `0` failures
- build is green

Remaining work is live Windows UI verification.

## Keep / Archive

### Keep

- managed `psmux` installation flow
- shared-session attach contract
- batch resume logic
- background bookkeeping via `pipe-pane`

### Archive / Abandon

- embedded dashboard slot model for live agent panes
- `display-pane`-based ideas
- synthetic dashboard pane-target naming
- `join-pane` / `break-pane`-driven dashboard composition for production use
