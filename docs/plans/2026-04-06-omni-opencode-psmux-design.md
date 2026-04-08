# Omni-Opencode psmux Design

**Date:** 2026-04-06

## Goal

Replace the current Windows `node-pty`-based monitor path with `psmux` as the required primary Windows backend for Omni-Opencode, while keeping the existing session/batch plugin model and archiving `node-pty` as fallback/reference only.

## Core Principle

On Windows, `psmux` must be the real execution and display surface.

- Codex and Claude Code run directly inside real `psmux` panes/windows
- the plugin is only the control plane
- background bookkeeping uses `pipe-pane`
- visible terminal behavior must never depend on proxy rendering or broker-log replay

`node-pty` code stays in the repository for fallback/archive purposes, but it is removed from the normal Windows happy path.

## Session Model

Use one shared `psmux` session per parent OpenCode session.

- one parent OpenCode session => one `monitorSessionId`
- one `monitorSessionId` => one shared `psmux` session
- all delegated jobs from that parent session run inside that same `psmux` session

Batch completion remains separate:

- all jobs launched from the same parent turn share one `batchId`
- the plugin injects one aggregate follow-up message only after all jobs in that batch finish

This preserves the existing separation between terminal grouping and completion grouping.

## Dashboard Layout

Do **not** show one pane per external subagent all at once.

Instead, the shared `psmux` session should expose one dashboard window:

- left side: control center pane
- right-top: display slot A
- right-bottom: display slot B

Layout ratio:

- left : right = approximately 1 : 2
- right side split 50 / 50 vertically

This makes the multiplexer usable even with many external agents.

## Control Center

The left control-center pane is only for external subagent management.

It should show:

- delegated jobs list
- current selection cursor
- backend per job
- job status
- which job is displayed in the top slot
- which job is displayed in the bottom slot
- navigation/action hints

The OpenCode parent session itself already has its own terminal, so the dashboard must **not** include a `Parent` control.

## Agent Storage vs Display

Each delegated external subagent gets its own real underlying `psmux` window or pane-backed execution home.

The dashboard only shows two of them at once in the right-side display slots.

Default policy:

- first delegated job => top slot
- second delegated job => bottom slot
- third and later jobs => latest two jobs always occupy the display slots by default

Older jobs remain available in the control-center list and can still be manually surfaced into either slot.

## Attach Contract

All delegated jobs in the same parent OpenCode session must return the same attach command:

```bash
psmux attach -t <monitorSessionId>
```

That attach must land in the dashboard window by default.

## Auto-Open Behavior

On Windows:

- first delegated job in a parent session:
  - ensure `psmux` is available
  - create/reuse shared `psmux` session
  - create dashboard window if missing
  - create first agent execution surface
  - place it into the top display slot
  - auto-open attach once
- second delegated job:
  - create second execution surface
  - place it into bottom display slot
  - do not open a second terminal window
- third and later delegated jobs:
  - create additional execution surfaces
  - update the two display slots to the latest two jobs
  - do not open new terminal windows

## Background Bookkeeping

The plugin still needs transcript-like data for:

- `delegated_job_read`
- summaries
- aggregate follow-up

Use `pipe-pane` for each delegated job pane/window as the canonical background transcript source.

This is bookkeeping only.

It must be:

- invisible to the user
- independent of the visible terminal surface
- safe to fail without breaking normal `psmux` terminal behavior

## Keep / Replace / Archive

### Keep

- `monitorSessionId` model
- batch resume / aggregate follow-up logic
- Linux/macOS `tmux` path
- plugin tool surface

### Replace

- Windows runtime selector path
- Windows attach/open contract
- Windows runtime implementation
- Windows transcript capture strategy

### Archive

- `src/runtime/windows-pty.ts`
- `src/runtime/windows-multiplexer.ts`
- `src/runtime/windows-multiplexer-host.ts`
- Windows `node-pty`-specific tests

Archive means retained in repo but removed from the primary Windows path.

## Verification Standard

Do not call the migration complete unless a live OpenCode session proves:

1. First delegated job opens one shared `psmux` session and one terminal window
2. Second delegated job reuses that same window
3. Third and later delegated jobs do not create more windows
4. Dashboard layout appears:
   - left control center
   - right-top slot
   - right-bottom slot
5. Codex and Claude run directly in real `psmux` panes/windows
6. Focused right-side slot behaves like a normal terminal pane
7. Latest two jobs are shown by default
8. `pipe-pane` bookkeeping works in background
9. All delegated jobs in the same parent session return:

```bash
psmux attach -t <monitorSessionId>
```

10. Aggregate follow-up still arrives once per finished batch
