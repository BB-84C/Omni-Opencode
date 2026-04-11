# Richer Provider Event Rendering Design

## Goal

Improve the Windows delegated monitor so that longer Codex and Claude runs are rendered more faithfully by:

- rendering transcript output in a more markdown-like way
- surfacing meaningful intermediate tool/subagent activity instead of hiding it completely
- using a more truthful final dashboard phase for Claude than `message_delta`
- fixing the dashboard color styling for `window <n>` labels

## Problem

The provider-truthful parser/transcript pass fixed correctness for basic runs, but a heavier live test exposed remaining UX gaps:

1. Transcript output is still mostly plain text rather than clearly markdown-like in the live Windows renderer.
2. Intermediate Claude tool/subagent activity is missing from the transcript even though the heavier stream shows real `tool_use` and `tool_result` records.
3. The dashboard `window <n>` label color is hard to see against the background in the live terminal theme.
4. Claude dashboard phase stops at `message_delta`, but the heavier run shows a later, more truthful terminal record: top-level `result` with `subtype: "success"`.

## New Ground Truth

The heavier live session `inspect-8cc70cee` adds important Claude record shapes that were not sufficiently exercised by the original `.omni-monitors/schema-probe` files:

- top-level `assistant` records containing `tool_use`
- top-level `user` records containing `tool_result`
- `tool_result` records with `is_error: true`
- repeated `message_start` / `message_stop` cycles across multiple tool-use turns
- `stream_event.message_delta` records with `stop_reason: "tool_use"`
- final top-level `result` with `subtype: "success"` and `terminal_reason: "completed"`

This means the original schema probe was sufficient for parser correctness, but not sufficient for richer event rendering and terminal-phase selection.

## Chosen Approach

Use the heavier Claude run as additional fixture truth and extend rendering in a narrowly scoped way.

- Keep the existing parser-led model.
- Extend the Claude parser to surface tool/subagent lifecycle events that are useful for rendering without flooding the transcript with protocol noise.
- Update dashboard phase selection so Claude prefers a later, more truthful terminal phase when `result.success` is present.
- Improve transcript rendering and dashboard styling without changing the launch/runtime architecture.

## Alternatives Considered

### 1. Minimal rendering pass over existing parser output

Pros:

- smallest possible change

Cons:

- current parser output hides too much of Claude tool activity
- still would not fix truthful final-phase selection cleanly

### 2. Parser plus renderer extension using heavier-run fixtures

Selected.

Pros:

- grounded in verified richer provider output
- keeps provider truth centralized in parser decisions
- enables intermediate tool-use visibility without ad-hoc raw record parsing in the renderer

Cons:

- touches both parser and renderer/dashboard layers

### 3. Full transcript redesign

Pros:

- could produce a cleaner long-term UI

Cons:

- too large for the current goal
- would blur the line between correctness and design experimentation

## Design

### Claude parser extensions

Extend `ClaudeStreamParser` to emit additional non-message, non-completion events that are useful for display:

- tool-use started events from top-level `assistant.content[].type === "tool_use"`
- tool-result events from top-level `user.content[].type === "tool_result"`
- terminal result events from top-level `result.subtype`

These should still avoid raw protocol spam:

- do not emit `thinking_delta`
- do not emit `input_json_delta`
- do not emit repeated assistant text snapshots that duplicate streamed text

The new events should remain provider-truthful, for example:

- `tool_use.Read`
- `tool_use.Grep`
- `tool_result.ok`
- `tool_result.error`
- `result.success`

### Dashboard behavior

Dashboard should keep exact provider phases, but choose the most truthful terminal one available.

For Claude:

- intermediate running phases can still show `content_block_delta`, `message_delta`, or tool-related phases
- terminal completed phase should prefer `--> result.success` if that event arrives
- `message_delta` should no longer be the final displayed phase when a later `result.success` exists

For Codex:

- keep `turn.completed` as the truthful terminal phase

### Transcript behavior

Transcript should become more readable without becoming a full pretty-printer.

For Codex:

- keep current assistant/progress separation
- preserve markdown-like formatting where possible

For Claude:

- continue coalescing final assistant text
- optionally surface intermediate tool/subagent activity as short lines like:
  - `[claude] tool: Read`
  - `[claude] tool: Grep`
  - `[claude] tool result: ok`
  - `[claude] tool result: error`
- do not dump raw `tool_result.content` blobs into transcript unless clearly useful
- keep final result marker only once

### Styling

Adjust dashboard color for `window <n>` so it remains visible in the current terminal theme.

This should be a small ANSI-color choice change in the dashboard renderer/process code, not a structural UI change.

## Testing Strategy

Add heavier-run fixtures based on `inspect-8cc70cee` output, especially for Claude.

New tests should cover:

- parser emission for Claude tool-use and tool-result lifecycle events
- final Claude phase preferring `result.success`
- transcript rendering of intermediate tool/subagent activity without protocol-noise spam
- markdown-like transcript output in the live Windows renderer path
- dashboard color/styling assertions where practical

## Risks

- showing too many intermediate tool events could make transcript noisy again
- Claude tool-result content can be very large, so transcript output must stay summarized
- dashboard final-phase preference must not regress earlier completion handling when `result.success` is absent

## Non-Goals

- redesigning the whole dashboard layout
- changing launch/runtime architecture
- rendering every Claude protocol record verbatim
- adding provider-agnostic abstractions that hide real event differences
