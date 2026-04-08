# Omni-Opencode psmux Dashboard Process Design

**Date:** 2026-04-08

## Goal

Replace the left dashboard pane in the Windows `psmux` monitor session with a dedicated long-lived dashboard process so the pane behaves like a true session-local control surface rather than a shell with rendered text.

## Approved Direction

Use a snapshot-file driven dashboard process.

- window `0` remains the shared dashboard window
- left pane runs a dedicated dashboard process
- right pane remains a normal interactive PowerShell shell
- windows `1..N` remain the real delegated job windows

The dashboard process must show only jobs belonging to its own parent OpenCode session.

## Why This Direction

The previous shell-backed dashboard improved the layout, but it still leaked shell semantics into the dashboard surface:

- a visible shell prompt made the left pane look interactive
- entering commands in the wrong place produced confusing behavior
- the left pane still felt like a repurposed shell instead of an actual dashboard

A dedicated process fixes that model mismatch and better matches the product intent: each parent OpenCode session gets its own independent external-agent dashboard.

## Session Model

Use one shared `psmux` session per parent OpenCode session.

Inside that session:

- window `0`: dashboard window
- window `1..N`: one real window per delegated job

Attach still lands in window `0`.

## Dashboard Window Layout

Window `0` has exactly two panes:

1. Left pane: dedicated dashboard process
2. Right pane: interactive PowerShell shell

### Left Pane

The left pane is not a shell.

It runs a long-lived dashboard-specific command/process that:

- reads a session-local dashboard snapshot file
- redraws only when the snapshot changes
- renders ANSI-styled status content
- never leaves a PowerShell prompt behind

This pane is owned by the runtime and treated as read-only from the user point of view.

### Right Pane

The right pane remains a normal interactive PowerShell shell for ad hoc commands and manual inspection.

Dashboard refreshes must never overwrite the right pane.

## State Source

The plugin writes a session-local dashboard snapshot file that is the source of truth for the dashboard process.

Recommended contents:

- parent session id
- dashboard title/subtitle
- current delegated jobs for that parent session only
- job id
- backend (`codex`, `claude-code`)
- real `psmux` window index
- status (`running`, `completed`, `failed`, `cancelled`, `stopped`)
- timestamps if known
- optional short summary/label if available
- navigation hints
- aggregate batch state if relevant

The snapshot file must be updated whenever session-local delegated job state changes.

## Dashboard Process Behavior

The dashboard process should:

- poll the snapshot file at a lightweight interval
- detect content/version changes before redrawing
- render cleanly inside `psmux`
- continue running across attach/detach cycles
- tolerate the snapshot file being temporarily absent or mid-write

If the snapshot file is missing, the dashboard should render a waiting state instead of crashing.

## Visual Design

Use lightweight ANSI styling only.

Do not build a heavy interactive full-screen TUI.

Recommended design language:

- section boxes or separators
- a colorful but restrained palette
- clear status badges/markers
- a small spinner or animation for running jobs
- green for completed work
- red for failed work
- dim/yellow for cancelled/stopped work
- cyan or blue accents for structure and active session identity

The dashboard should feel more alive than plain monochrome terminal text, but remain stable and readable inside `psmux`.

## Session Scope

The dashboard process must show only jobs from its own parent OpenCode session.

It must not aggregate or merge jobs from other parent sessions, even if multiple OpenCode sessions are active in the same repository.

## Recovery Model

If the left-pane dashboard process exits unexpectedly, the runtime should be able to respawn it without disturbing:

- the shared `psmux` session
- the right-pane shell
- the real delegated job windows

If the shared session is reused and the left pane is not running the expected dashboard process, the runtime should repair that pane specifically rather than falling back to shell-backed dashboard rendering.

## Testing Strategy

Add tests for:

- snapshot-file generation per parent session
- dashboard renderer output formatting
- runtime launch of dashboard process in the left pane
- preservation of the right-pane shell
- session-local filtering of jobs
- respawn/recovery behavior for the dashboard process

Live verification must prove:

1. attach lands in window `0`
2. left pane is a real dashboard process, not a shell prompt
3. right pane remains a normal PowerShell shell
4. creating/stopping jobs updates the left-pane dashboard automatically
5. windows `1..N` remain the real job windows
6. `Ctrl+b` then `n/p` still switches correctly among dashboard and job windows

## Files Expected To Change

- `src/runtime/windows-psmux.ts`
- new dashboard-process/runtime support files under `src/runtime/`
- new tests for snapshot generation/rendering
- `test/windows-psmux-dashboard.test.ts`
- `test/windows-psmux.test.ts`
- `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md`
- `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md`

## Notes

No git commit has been created for this design document yet.
