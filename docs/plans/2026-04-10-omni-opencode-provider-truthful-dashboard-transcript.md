# Provider-Truthful Dashboard And Transcript Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Windows delegated dashboard and transcript rendering reflect the verified raw Codex and Claude stream schemas honestly, without protocol-noise leaks or duplicated Claude text.

**Architecture:** Move provider-truth interpretation into the stream parsers first, then let dashboard classification and transcript rendering consume those richer events. Codex remains stdout-JSONL plus stderr-noise, while Claude gets explicit handling for nested `stream_event` payloads, `text_delta` accumulation, completion signals, and duplicate suppression against top-level assistant snapshots.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`

---

### Task 1: Add fixture-based parser tests from the captured raw probe files

**Files:**
- Modify: `test/codex-stream-parser.test.ts`
- Modify: `test/claude-stream-parser.test.ts`
- Create: `test/fixtures/schema-probe-codex-stdout.jsonl`
- Create: `test/fixtures/schema-probe-codex-stderr.txt`
- Create: `test/fixtures/schema-probe-claude-stdout.jsonl`
- Create: `test/fixtures/schema-probe-claude-stderr.txt`

**Step 1: Write failing fixture tests for Codex parser behavior**

Add a test that feeds the real captured Codex stdout fixture through `CodexStreamParser` and asserts that:

- `thread.started` and `turn.started` are status events
- `item.completed.item.text` yields message events
- `turn.completed` yields completion with final text fallback from the last message

Suggested assertions:

```ts
expect(events.map((event) => event.eventType)).toContain("thread.started")
expect(events.some((event) => event.kind === "message" && event.text?.includes("PACKAGE:"))).toBe(true)
expect(events.at(-1)).toMatchObject({ kind: "completion", eventType: "turn.completed" })
```

**Step 2: Write failing fixture tests for Claude parser behavior**

Add a test that feeds the real captured Claude stdout fixture through `ClaudeStreamParser` and asserts that:

- `system`, `thinking_delta`, `input_json_delta`, and tool-use snapshots do not become transcript-style message events
- `stream_event.content_block_delta.text_delta` yields message events
- `message_delta.stop_reason === end_turn` yields completion
- top-level assistant text snapshots do not create duplicate message events if the same text already streamed through `text_delta`

Suggested assertions:

```ts
expect(events.some((event) => event.kind === "message" && event.text === "PACKAGE: omni-opencode\nTITLE: Omni-Opencode")).toBe(true)
expect(events.filter((event) => event.kind === "message" && event.text?.includes("PACKAGE:")).length).toBe(1)
expect(events.at(-1)).toMatchObject({ kind: "completion" })
```

**Step 3: Run tests to verify RED**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts`

Expected: FAIL because current Claude parser is too shallow and current Codex expectations likely do not encode the full verified fixture behavior.

**Step 4: Keep fixture scope minimal**

Only assert behaviors needed for dashboard truthfulness and transcript correctness. Do not overfit every record field.

### Task 2: Update Codex parser to follow verified stdout JSONL shape exactly

**Files:**
- Modify: `src/runtime/codex-stream-parser.ts`
- Test: `test/codex-stream-parser.test.ts`

**Step 1: Implement minimal Codex parser corrections**

Ensure Codex parser logic is explicitly centered on the verified event shapes:

- `record.type`
- `record.item.text`
- `turn.completed`

Keep stderr entirely out of the parser.

**Step 2: Preserve final-text fallback**

Continue using the last seen message text for `turn.completed` if the completion record does not contain text directly.

**Step 3: Run focused Codex parser tests**

Run: `npm test -- test/codex-stream-parser.test.ts`

Expected: PASS

### Task 3: Update Claude parser to use nested `stream_event` truth and suppress duplication

**Files:**
- Modify: `src/runtime/claude-stream-parser.ts`
- Test: `test/claude-stream-parser.test.ts`

**Step 1: Track Claude parser state explicitly**

Add parser state for:

- last streamed text block
- whether final streamed text has already been emitted for the current assistant turn

**Step 2: Parse nested `stream_event.event` records**

Handle at least these cases explicitly:

- `stream_event -> content_block_delta -> text_delta`
- `stream_event -> message_delta -> stop_reason=end_turn`

Ignore:

- `system`
- `rate_limit_event`
- `thinking_delta`
- `signature_delta`
- `input_json_delta`

**Step 3: Prevent duplicate message emission**

When top-level `assistant.content[].text` repeats text already emitted from `text_delta`, suppress the duplicate message event.

**Step 4: Add fallback final-text behavior carefully**

If there was no streamed text, allow top-level `assistant.content[].text` or `result.result` to provide message/final content.

**Step 5: Run focused Claude parser tests**

Run: `npm test -- test/claude-stream-parser.test.ts`

Expected: PASS

### Task 4: Make dashboard status and phase provider-truthful

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write failing dashboard tests first**

Add/adjust dashboard tests so they require exact provider event names to appear in dashboard phase updates instead of overly normalized guesses.

Examples:

```ts
expect(snapshot.jobs[0]?.phase).toBe("--> turn.completed")
expect(snapshot.jobs[1]?.phase).toBe("--> message_delta")
```

Add a case where Claude is still `running` during tool-use/message streaming and is only marked `completed` once a verified completion event arrives.

**Step 2: Run dashboard tests to verify RED**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`

Expected: FAIL until classification logic matches the verified schema.

**Step 3: Update lifecycle filtering/classification minimally**

Revise:

- `isWindowsPsmuxLifecycleEvent(...)`
- `classifyWindowsPsmuxDashboardStatus(...)`

so they accept provider-truthful signals while still filtering out obvious transcript-noise-only events where appropriate.

Use verified rules such as:

- Codex complete on `turn.completed`
- Claude complete on `message_delta` with `stop_reason === end_turn` or `result.success`

**Step 4: Run focused dashboard tests**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`

Expected: PASS

### Task 5: Fix transcript rendering against verified parser output

**Files:**
- Modify: `src/runtime/delegation-renderer.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/delegation-renderer.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Write failing transcript tests first**

Add tests that cover:

- Codex stderr is treated as backend progress/noise and does not replace stdout-derived final content
- Claude transcript output coalesces `text_delta` content into a single message
- Claude top-level assistant text snapshot does not duplicate already streamed content

**Step 2: Run focused transcript tests to verify RED**

Run: `npm test -- test/delegation-renderer.test.ts test/windows-psmux.test.ts`

Expected: FAIL until transcript logic is aligned with the verified provider schemas.

**Step 3: Keep transcript logic small and evidence-based**

Update the embedded Windows renderer and shared renderer helpers so they:

- use parser-accurate message/completion semantics
- suppress Claude duplicates
- avoid printing protocol-only JSON fragments
- preserve backend-labeled stderr where useful

Do not redesign the renderer architecture.

**Step 4: Run transcript-focused tests**

Run: `npm test -- test/delegation-renderer.test.ts test/windows-psmux.test.ts`

Expected: PASS

### Task 6: Run full relevant verification and build

**Files:**
- Test: `test/codex-stream-parser.test.ts`
- Test: `test/claude-stream-parser.test.ts`
- Test: `test/delegation-renderer.test.ts`
- Test: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Run the full relevant suite**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/completion-reporting.test.ts test/delegation-tools.test.ts`

Expected: PASS

**Step 2: Run the build**

Run: `npm run build`

Expected: PASS

**Step 3: Review scope**

Run: `git diff -- src/runtime/codex-stream-parser.ts src/runtime/claude-stream-parser.ts src/runtime/delegation-renderer.ts src/runtime/windows-psmux.ts test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts docs/plans/2026-04-10-omni-opencode-provider-truthful-dashboard-transcript-design.md docs/plans/2026-04-10-omni-opencode-provider-truthful-dashboard-transcript.md`

Expected: changes limited to parser/dashboard/transcript truthfulness.

### Task 7: Manual provider-truthful smoke run

**Files:**
- Use existing inspection seeding script
- Use `.omni-monitors/schema-probe/*` as reference truth

**Step 1: Rebuild**

Run: `npm run build`

Expected: PASS

**Step 2: Seed a fresh Windows inspection session**

Run: `node scripts/seed-windows-psmux-inspection.mjs`

Expected: fresh inspection session returned with attach command.

**Step 3: Inspect generated artifacts**

Confirm that:

- Codex transcript reflects stdout-derived assistant text and a truthful terminal event
- Claude transcript reflects coalesced text without duplicate fragments
- dashboard phases show exact provider event names instead of misleading normalized guesses

**Step 4: Compare live monitor behavior against raw schema expectations**

Minimum expected outcome:

- Codex window shows useful stdout-derived content, not fallback interactive behavior
- Claude window shows a single coalesced final message
- dashboard reflects provider-truthful last phase and truthful completion state
