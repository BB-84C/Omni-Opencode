# Omni-Opencode psmux Real-Primitives Design

**Date:** 2026-04-07

## Goal

Correct the Windows `psmux` integration so it is built only on real `psmux` commands and real pane/window IDs, replacing the earlier invalid tmux-shaped assumptions (`display-pane`, synthetic `.right` pane targets, etc.).

## Core Principle

The Windows `psmux` runtime must use only commands and targets that were verified against the real managed `psmux` binary.

That means:

- create a real detached session with `new-session`
- build the dashboard with real `split-window` commands
- discover actual pane IDs via `list-panes -F ...`
- manage slot swaps with real pane/window movement commands (`join-pane`, `break-pane`, etc.)
- never use synthetic pane targets or nonexistent commands

## Root Cause Of The Previous Failure

The earlier design used invalid assumptions:

- `display-pane` was treated like a real command, but `psmux` does not support it
- synthetic targets such as `session:dashboard.right` and `session:dashboard.right-top` were assumed to exist
- those assumptions caused a runtime that could return attach commands without actually creating a durable usable dashboard session

Manual probes confirmed:

- `new-session -d -s <session> ...` with a keepalive command is the correct detached-session bootstrap
- `list-panes -F "#{pane_id} ..."` works and exposes real pane IDs and geometry
- `display-pane` is not a valid `psmux` command

## Session Bootstrap

First delegated job for a parent OpenCode session should do:

1. `psmux start-server`
2. `psmux has-session -t <monitorSessionId>`
3. if session missing:
   - `psmux new-session -d -s <monitorSessionId> -n dashboard -- <keepalive>`

The keepalive command should be a long-running no-op shell loop so the session persists before the first real job panes are created.

## Dashboard Window Model

The dashboard remains the primary attach surface.

There is one dashboard window per shared `psmux` session.

Desired visible layout:

- left control center
- right-top display slot
- right-bottom display slot

But these are not synthetic target names. They must be resolved from real pane geometry after split operations.

## Pane Discovery

After creating/splitting the dashboard window, the runtime must query:

```bash
psmux list-panes -t <session>:dashboard -F "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"
```

From that real output, the runtime derives:

- control pane ID = leftmost pane
- top slot pane ID = right-side pane with smaller `pane_top`
- bottom slot pane ID = right-side pane with larger `pane_top`

These IDs must be rediscovered after every structural pane move, because pane identities and geometry can change.

## Execution Windows / Panes

Each delegated external subagent starts in its own real execution window.

That execution target is the canonical job home.

The dashboard slots are just visible destinations for at most two currently surfaced jobs.

## Slot Management

The earlier `display-pane` design is invalid and must be replaced.

Use real pane/window movement primitives instead:

- `join-pane`
- `break-pane`
- possibly `swap-pane` where appropriate if validated later

Recommended approach:

1. each job starts in its own real window
2. to show a job in a slot:
   - move its pane into the dashboard using `join-pane`
3. if a slot already contains another job:
   - move that pane back out to a storage window with `break-pane`
4. after each move:
   - rediscover dashboard pane IDs by geometry
   - update runtime state

This makes slot assignment a real structural operation, not a fake display redirect.

## Default Slot Policy

Latest two jobs remain the default visible jobs:

- first job -> top slot
- second job -> bottom slot
- third and later jobs -> latest two occupy the slots by default

Older jobs stay in their real execution windows and remain selectable from the control center.

## Background Bookkeeping

The visible terminal remains native `psmux`.

Background bookkeeping still uses `pipe-pane` for:

- `delegated_job_read`
- summary extraction
- aggregate follow-up

This capture must remain independent from the visible pane rendering model.

## Verification Standard

Do not call this design complete unless a live Windows session proves:

1. first delegated launch creates a real detached `psmux` session
2. returned attach command actually attaches
3. dashboard window has three real panes
4. dashboard pane IDs are discovered from real geometry
5. two jobs can be surfaced into the dashboard using real pane movement primitives
6. latest-two slot policy works without fake target strings
7. focused slot still behaves like a normal terminal pane
8. no `display-pane` or synthetic `.right`/`.right-top` targets remain on the active path

## Archive Boundary

Keep archived code, but do not route production Windows behavior through:

- `node-pty` compositor path
- `display-pane` fake `psmux` dashboard slot logic
- synthetic pane target conventions
