# CLI-Like Transcript Design

## Goal

Make the delegated job transcript feel closer to real Codex and Claude CLI sessions while keeping the dashboard provider-truthful and avoiding brittle protocol-level imitation.

## Problem

The current provider-truthful transcript is functionally correct, but it still differs from a believable CLI experience in several ways:

- some helpful provider-specific progress feels too normalized
- Claude tool activity is shown, but still in a generic summary form
- intermediate text and final answer presentation are cleaner than before, yet still not as close to actual CLI feel as desired
- dashboard truthfulness and transcript fidelity are now separate concerns and should stay that way

We do not want to regress into raw protocol dumping or brittle pixel-perfect imitation. We want a CLI-like transcript that is grounded in verified provider output and remains maintainable.

## Chosen Approach

Use provider-aware CLI-like rendering.

- Keep provider-truthful parser output as the source of truth.
- Adjust transcript rendering so Codex and Claude each feel closer to their own CLI style.
- Keep dashboard logic provider-truthful and independent from transcript rendering decisions.
- Trim only obvious protocol noise; do not chase a byte-for-byte imitation of either CLI.

## Alternatives Considered

### 1. Provider-aware CLI-like rendering

Selected.

Pros:

- closer to real Codex/Claude feel
- stable enough to maintain
- preserves provider differences honestly

Cons:

- still requires some provider-specific rendering rules

### 2. Near-exact replica

Pros:

- highest surface similarity

Cons:

- very brittle
- likely to drift when provider outputs evolve
- encourages special-casing many terminal quirks

### 3. Generic normalized transcript

Pros:

- simplest to maintain

Cons:

- not what the user wants
- erases provider-specific feel

## Design

### Codex transcript behavior

Codex should feel like a useful CLI session, not a structured log.

- keep stderr-derived progress lines when they are human-meaningful
- suppress purely repetitive boilerplate where helpful
- preserve intermediate assistant narration when it appears in stdout event content
- render final answer in markdown-like form
- avoid extra synthetic labels unless they improve readability

Codex should still feel like:

- progress on top
- answer below
- final result marker at the end

### Claude transcript behavior

Claude should feel like a tool-using CLI assistant session.

- show concise tool activity lines, but make them feel like session output rather than protocol events
- keep them human-readable and compact
- avoid dumping raw `tool_result.content` blobs unless explicitly desired later
- keep final answer in markdown-like form
- suppress protocol-only records like:
  - `thinking_delta`
  - `input_json_delta`
  - low-level lifecycle-only records that are not meaningful in the transcript

Tool activity should read more like an actual session than a raw event stream.

### Dashboard behavior

Dashboard should remain provider-truthful and not be distorted to match transcript style.

- Codex final phase remains `turn.completed`
- Claude final phase should prefer `result.success`
- transcript styling changes must not regress dashboard status correctness

### Output philosophy

The transcript should be “what a human would want to watch in the pane” rather than “everything the provider emitted”.

That means:

- keep semantically useful progress
- keep tool activity summaries
- keep final answer formatting
- drop protocol noise and raw blobs

## Testing Strategy

Use the heavier successful smoke artifacts as guidance and update tests so they assert CLI-like behavior, not generic normalization.

Tests should cover:

- Codex progress + final answer shape
- Claude tool activity summary style
- Claude final answer style
- markdown-like formatting in live Windows transcript path
- dashboard remaining provider-truthful despite transcript changes

## Risks

- too much provider-specific styling could drift toward brittle imitation
- too little provider-specific styling could still feel generic
- Codex stderr suppression must be conservative so useful progress is not lost

## Non-Goals

- byte-for-byte reproduction of the real Codex CLI
- byte-for-byte reproduction of the real Claude CLI
- changing backend launch/runtime architecture again
- making dashboard phases less truthful for the sake of visual polish
