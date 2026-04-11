# Provider-Truthful Dashboard And Transcript Design

## Goal

Make Windows delegated job monitoring more honest by driving dashboard phase/status and transcript rendering from the verified raw output schemas of:

- `codex exec --json`
- `claude -p ... --output-format stream-json --verbose --include-partial-messages`

## Problem

The current runtime path mixes provider-specific interpretation in the embedded renderer and dashboard logic, with some schema assumptions based on limited samples. Recent raw probes established that:

- Codex writes structured JSONL to stdout and progress/noise to stderr.
- Claude writes a much noisier JSONL protocol to stdout, including system records, tool-use deltas, thinking deltas, top-level assistant snapshots, and final result summaries.
- Dashboard status currently collapses provider events too aggressively, so phases are not always honest.
- Claude transcript rendering previously showed blank panes, duplicated text, and partial fragment artifacts because the renderer was handling nested records heuristically instead of from verified schema rules.

## Verified Ground Truth

### Codex

Observed raw stdout events include:

- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `turn.completed`

Useful text sources:

- `item.completed.item.text` for agent-visible messages
- `item.completed.item.aggregated_output` for command output, if needed for display

Observed stderr is plain text and can contain progress/noise such as:

- `Reading additional input from stdin...`

### Claude

Observed raw stdout includes top-level records of several kinds:

- `system`
- `stream_event`
- `assistant`
- `user`
- `rate_limit_event`
- `result`

Useful nested event shapes include:

- `stream_event.event.type === "content_block_delta"`
- `stream_event.event.delta.type === "text_delta"`
- `stream_event.event.delta.text`
- `stream_event.event.type === "message_delta"` with `delta.stop_reason === "end_turn"`

The final answer may also appear in:

- top-level `assistant.content[].text`
- top-level `result.result`

But those can duplicate previously streamed `text_delta` content.

## Chosen Approach

Use a parser-led truthful model.

- Encode provider-specific truth once in `codex-stream-parser.ts` and `claude-stream-parser.ts`.
- Let dashboard status/phase consume those richer normalized events.
- Let transcript rendering use parser output rules that preserve real assistant-visible text while ignoring protocol noise.

This avoids re-implementing provider schema logic separately inside the dashboard path and embedded renderer.

## Alternatives Considered

### 1. Parser-led truthful model

Selected.

Pros:

- single source of truth for provider schemas
- better testability with captured raw fixtures
- dashboard and transcript can share the same semantics

Cons:

- requires touching parser and runtime classification together

### 2. Renderer-led patching

Pros:

- smaller immediate change inside Windows-only runtime code

Cons:

- duplicates schema knowledge
- encourages more heuristic fixes
- harder to test cleanly from fixtures

### 3. Hybrid parser plus dashboard patching

Pros:

- smaller than a broad parser cleanup

Cons:

- still splits provider truth across multiple layers

## Design

### Parser responsibilities

#### Codex parser

- continue treating stdout JSONL as the primary source of truth
- expose provider-accurate event names unchanged
- extract message text from agent-message records
- use `turn.completed` as the reliable completion event
- do not treat stderr as completion or final transcript content

#### Claude parser

- unwrap `stream_event.event` records explicitly
- ignore non-user-facing protocol noise for transcript purposes:
  - `system`
  - `rate_limit_event`
  - `thinking_delta`
  - `signature_delta`
  - `input_json_delta`
  - top-level tool-use snapshots
- accumulate `text_delta` as the primary transcript source
- detect `message_delta.stop_reason === "end_turn"` as the truthful completion signal
- suppress duplicate final assistant text when top-level `assistant.content[].text` repeats already streamed delta text
- use top-level `result.result` only as a fallback final text source if no streamed text was captured

### Dashboard behavior

Dashboard should become provider-truthful, not provider-agnostic.

- keep exact provider event names in the phase line
- stop mapping everything to generic phrases too early
- examples:
  - Codex: `--> thread.started`, `--> item.started`, `--> turn.completed`
  - Claude: `--> content_block_delta`, `--> message_delta`, `--> result.success`

Status should still be summarized, but honestly:

- `completed` only on verified terminal completion signals
- `failed` only on verified failure/error signals
- `waiting-approval` only when provider output actually indicates approval is needed
- otherwise remain `running`

### Transcript behavior

Transcript should reflect what a human would regard as assistant output, not protocol internals.

#### Codex transcript

- keep assistant-facing stdout JSON content
- optionally keep stderr lines, but treat them as backend progress/noise, not main content
- preserve final result marker

#### Claude transcript

- render coalesced `text_delta` output once
- suppress duplicated top-level assistant snapshots when they repeat the same content
- do not print tool-use JSON fragments or thinking blocks
- preserve final result marker

## Testing Strategy

Use the captured raw probe files as fixture truth.

Primary fixture sources:

- `.omni-monitors/schema-probe/codex-stdout.jsonl`
- `.omni-monitors/schema-probe/codex-stderr.txt`
- `.omni-monitors/schema-probe/claude-stdout.jsonl`
- `.omni-monitors/schema-probe/claude-stderr.txt`

Add tests for:

- Codex parser event extraction from real stdout fixture
- Claude parser filtering/coalescing from real stdout fixture
- dashboard phase/status classification using verified provider events
- transcript rendering with no Claude duplication and no protocol-noise output

## Risks

- parser changes may affect both dashboard and transcript behavior simultaneously
- Claude may emit additional record variants in other tasks, so parser logic should prefer explicit filtering over broad assumptions
- Codex stderr formatting may vary across versions and should not be treated as structured data

## Non-Goals

- redesigning the monitor UI layout
- changing permission policy
- changing backend launch shape again
- making provider outputs look identical when they are not
