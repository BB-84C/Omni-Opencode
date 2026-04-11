# Omni-Opencode Stream-JSON Renderer Design

**Date:** 2026-04-09

## Goal

Replace the fragile interactive-TUI orchestration path for delegated Codex and Claude jobs with a structured event-stream runtime model that is reliable on Windows `psmux`, renders human-readable output in job windows, and drives the dashboard from real backend lifecycle events.

## Approved Direction

Use structured streaming backend commands as the delegated execution surface:

- Codex: `codex exec --json ...`
- Claude Code: `claude -p ... --output-format stream-json --verbose --include-partial-messages`

Each delegated job window in `psmux` runs a renderer process that consumes the structured backend stream and translates it into readable colored terminal output.

The dashboard consumes the same structured lifecycle state and displays real running/completed/error status instead of inferring from terminal behavior.

## Why This Direction

The previous attempts to automate real interactive backend TUIs exposed three persistent problems:

- initial prompt delivery into interactive Codex is fragile under Windows `psmux`
- session handoff between bootstrap windows and resumed panes is awkward and interruption-prone
- dashboard/bookkeeping quality depends too much on terminal behavior rather than explicit machine-readable state

The stream-json path solves the actual plugin problem better:

- deterministic startup
- explicit event boundaries
- reliable completion detection
- safer transcript/state handling
- cleaner rendering inside `psmux`

## Session Model

Per parent OpenCode session:

- one shared `psmux` session
- window `0` = session-local dashboard + shell
- windows `1..N` = delegated job renderer windows

The visible delegated job window is not the raw backend TUI. It is a renderer surface over the backend event stream.

## Backend Commands

### Codex

Run delegated Codex jobs in structured mode:

```text
codex exec --json <prompt>
```

Important notes:

- Codex emits progress to `stderr`
- Codex emits the final message to `stdout`
- a `turn.completed` event provides a reliable terminal completion signal

### Claude Code

Run delegated Claude jobs in structured mode:

```text
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
```

Important notes:

- Claude emits structured partial and final messages
- `stop_reason: end_turn` is the reliable terminal completion signal for a successful turn

## Renderer Model

Each delegated job window runs a renderer process that:

- launches the backend command
- reads the backend’s structured stream in real time
- converts raw events into human-readable terminal output
- supports Markdown rendering in the visible terminal view
- applies status color and formatting for readability
- writes raw event data to plugin bookkeeping if needed

### Rendering Goals

Job windows should be pleasant to read in `psmux`, not raw JSON dumps.

Renderer output should support:

- headings
- bullets and numbered lists
- fenced code blocks
- inline code
- progress/status lines
- warnings and errors
- tool execution sections when available

### Visual Style

Use ANSI styling with more color diversity than plain monochrome:

- cyan/blue for structure
- green for successful completions
- yellow for progress/warnings
- red for failures/errors
- dim styling for metadata or completed housekeeping details

Keep the renderer terminal-stable, not a heavy full-screen TUI.

## Dashboard Model

The dashboard becomes fully event-driven.

It should no longer guess state from pane behavior or transcript quirks.

The dashboard should use real backend lifecycle events to drive:

- spinner animation for active jobs
- `-->` or equivalent running-state markers
- waiting/approval states
- tool-running states if relevant
- completed / failed / cancelled statuses

This means the dashboard spinner and status arrows become truthful reflections of actual backend execution state.

## Permission Model

### Core Rule

OpenCode decides the permission profile by task class. The user can override when elevated permissions are needed.

### Profiles

1. `safe`
- read/review/research style delegations
- no prompt to user

2. `dangerous`
- write access
- shell execution
- MCP/external tool usage with elevated risk
- requires user approval

### User Overrides

When dangerous capabilities are required, user choices are:

- allow once
- allow for this parent OpenCode session

### Persistence

These approval choices must be stored in plugin-owned session state keyed by parent OpenCode session id.

Do not rely on model memory to remember approval choices.

Stored approval state should include:

- parent session id
- approved capability/profile scope
- whether approval was one-time or session-wide
- timestamp/metadata as needed

## Bookkeeping Model

Per delegated job, keep:

- parent session id
- parent message id
- backend
- permission profile used
- effective approval mode
- runtime kind/handle
- transcript/event-stream metadata
- backend session/thread id if available
- completion status and summary

This keeps future resume or audit paths open even if the visible job window is renderer-driven.

## Verification Standard

Do not treat this design as complete until a live run proves:

1. delegation automatically creates a shared multi-window `psmux` session
2. dashboard is window `0`
3. each delegated job window renders human-friendly translated backend output
4. dashboard spinner/status arrows reflect real backend lifecycle events
5. safe delegations do not prompt for approval
6. dangerous delegations prompt for `allow once` or `allow for this session`
7. session-wide approval is remembered by plugin state across later delegations in the same parent OpenCode session

## Files Expected To Change

- `src/plugin.ts`
- `src/core/`
- `src/runtime/types.ts`
- `src/runtime/windows-psmux.ts`
- new renderer/parser support files under `src/runtime/`
- tests for permission policy, stream parsing, renderer output, and dashboard event-driven state

## Notes

This design supersedes the earlier attempt to drive real interactive Codex/Claude TUIs directly inside delegated `psmux` windows. The plugin’s core need is reliable delegated execution plus readable operator UX, and structured streams fit that need better than TUI automation.
