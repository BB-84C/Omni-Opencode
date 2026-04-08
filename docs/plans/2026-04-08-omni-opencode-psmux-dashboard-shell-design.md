# Omni-Opencode psmux Dashboard Shell Design

**Date:** 2026-04-08

## Goal

Simplify the Windows `psmux` dashboard window so it remains useful as an index/control surface without wasting space on separate highlight panes or breaking when the user needs a shell inside window `0`.

## Approved Direction

Use a two-column dashboard window:

- left pane: read-only dashboard content rendered by the runtime
- right pane: normal interactive PowerShell shell for ad hoc commands

This replaces the temporary 3-pane dashboard experiment.

## Why This Direction

The current 3-pane dashboard proved that the runtime can render metadata into dashboard panes, but the split is no longer justified:

- real delegated work already lives in windows `1..N`
- embedded highlight panes do not provide actual job interactivity
- the extra panes consume space without adding meaningful control-plane value
- using a rendered pane as a shell caused confusing breakage when commands were entered into the wrong place

The two-column model keeps the useful part of the dashboard and removes the redundant part.

## Session Model

Use one shared `psmux` session per parent OpenCode session.

Inside that session:

- window `0`: dashboard window with two panes
- window `1..N`: one real window per delegated job

Attach still lands in window `0`.

## Dashboard Window

Window `0` has exactly two panes:

1. Left pane: dashboard renderer
2. Right pane: interactive PowerShell shell

### Left Pane

The left pane is read-only from the product point of view. The runtime owns its content and re-renders it whenever the shared session state changes.

It should include:

- session id
- reminder that window `0` is the dashboard
- native `psmux` navigation hints (`Ctrl+b`, `n`, `p`, numeric window selection)
- current delegated jobs and their real window indexes
- latest two jobs called out inline in the text, not as separate panes
- a warning not to run nested `psmux attach` commands from inside the already attached shared session

The user may technically move the cursor there, but the runtime treats that pane as owned output and may overwrite it on refresh.

### Right Pane

The right pane is a normal interactive shell and must never be overwritten by dashboard refreshes.

This gives the user a safe scratch shell in window `0` for commands such as:

- listing sessions/windows
- inspecting log files
- checking environment state

It also prevents the dashboard renderer from fighting with normal shell input.

## Refresh Model

The dashboard renderer only updates the left pane.

Refresh events include:

- first shared session creation
- delegated job launch
- delegated job completion
- delegated job stop/cancel
- session cleanup when jobs disappear

The right shell pane remains untouched across all of those updates.

## Error Handling

If the left-pane render command fails, the runtime should surface a runtime error rather than silently corrupting the dashboard model.

If a user manually damages the dashboard layout, re-discovery on the next managed update should either:

- still find the expected two-pane layout, or
- fail clearly with a layout error instead of rendering to the wrong pane

## Verification Standard

Do not treat this dashboard simplification as complete until a live session proves:

1. attach still lands in window `0`
2. window `0` has exactly two panes
3. left pane shows dashboard metadata and navigation hints
4. right pane remains a normal interactive shell
5. launching new jobs refreshes the left pane automatically
6. job windows remain separate real `psmux` windows
7. `Ctrl+b` then `n/p` still moves between dashboard, Codex, and Claude windows
8. `pipe-pane` bookkeeping and aggregate follow-up still work

## Files Expected To Change

- `src/runtime/windows-psmux.ts`
- `test/windows-psmux-dashboard.test.ts`
- `test/windows-psmux.test.ts`
- `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md`
- `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md`
