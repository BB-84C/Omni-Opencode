# Richer Provider Event Rendering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the delegated Windows monitor to render longer Codex/Claude runs more faithfully by surfacing meaningful intermediate tool activity, improving markdown-like transcript output, preferring `result.success` as Claude’s final phase, and fixing dashboard window-label styling.

**Architecture:** Build on the existing parser-led provider-truthful foundation. Add heavier-run Claude fixtures, extend the Claude parser to surface useful tool-use/tool-result lifecycle events, then update the dashboard and transcript renderers to consume those richer events without flooding the output with protocol noise.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`

---

### Task 1: Add heavier-run fixtures and RED tests for richer Claude event coverage

**Files:**
- Create: `test/fixtures/claude-heavy-stdout.jsonl`
- Modify: `test/claude-stream-parser.test.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`
- Modify: `test/delegation-renderer.test.ts`

**Step 1: Add the heavier Claude fixture**

Copy the richer Claude run from:

- `.omni-monitors/inspect-8cc70cee-runtime-2.stream.jsonl`

into a stable fixture file:

- `test/fixtures/claude-heavy-stdout.jsonl`

Trim only if needed to keep it focused, but preserve these shapes:

- `tool_use`
- `tool_result`
- `message_delta` with `stop_reason: "tool_use"`
- final `result.success`

**Step 2: Write failing parser tests first**

Add tests requiring the Claude parser to surface richer provider-truthful events for:

- tool-use start
- tool-result success/error
- terminal `result.success`

Example expectations:

```ts
expect(events.some((event) => event.kind === "status" && event.eventType === "tool_use.Read")).toBe(true)
expect(events.some((event) => event.kind === "status" && event.eventType === "tool_result.error")).toBe(true)
expect(events.some((event) => event.kind === "completion" && event.eventType === "result.success")).toBe(true)
```

**Step 3: Write failing dashboard/transcript tests first**

Add tests requiring:

- dashboard final Claude phase prefers `--> result.success`
- transcript can show summarized intermediate tool activity for Claude
- transcript markdown formatting expectations for headings/bullets survive the richer output

**Step 4: Run focused tests to verify RED**

Run: `npm test -- test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux-dashboard.test.ts`

Expected: FAIL because the current parser/renderer do not yet expose these richer provider events.

### Task 2: Extend Claude parser to surface useful tool and terminal events

**Files:**
- Modify: `src/runtime/claude-stream-parser.ts`
- Test: `test/claude-stream-parser.test.ts`

**Step 1: Add minimal richer event emission**

Extend Claude parser output with provider-truthful status events for:

- top-level `assistant.content[].type === "tool_use"`
- top-level `user.content[].type === "tool_result"`
- top-level `result.subtype === "success"`

Suggested event-type scheme:

```ts
tool_use.Read
tool_use.Grep
tool_result.ok
tool_result.error
result.success
```

Keep these as `kind: "status"` except final `result.success`, which should be `kind: "completion"` when it provides the final terminal truth.

**Step 2: Preserve existing text correctness**

Do not regress:

- `text_delta` accumulation
- duplicate assistant suppression
- late fallback final-text handling

**Step 3: Run focused parser tests**

Run: `npm test -- test/claude-stream-parser.test.ts`

Expected: PASS

### Task 3: Prefer truthful final Claude phase in dashboard status updates

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Adjust failing dashboard tests if needed**

Ensure tests explicitly require Claude’s final phase to be `--> result.success` when that event appears after `message_delta`.

**Step 2: Implement minimal phase-preference logic**

Update dashboard event application/classification so:

- intermediate Claude phases can still show `message_delta`, `tool_use.*`, `tool_result.*`
- if a later `result.success` arrives, it becomes the terminal displayed phase

Do not regress Codex `turn.completed` handling.

**Step 3: Run focused dashboard tests**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`

Expected: PASS

### Task 4: Render summarized intermediate Claude tool activity in transcripts

**Files:**
- Modify: `src/runtime/delegation-renderer.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/delegation-renderer.test.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write transcript expectations first**

Add tests requiring concise transcript lines for Claude intermediate events, for example:

```ts
expect(transcript).toContain("[claude] tool: Read")
expect(transcript).toContain("[claude] tool result: error")
```

Avoid requiring large raw tool-result payload dumps.

**Step 2: Implement minimal summary rendering**

Render only useful summaries such as:

- `[claude] tool: Read`
- `[claude] tool: Grep`
- `[claude] tool result: ok`
- `[claude] tool result: error`

Do not emit raw `input_json_delta` or full `tool_result.content` blobs by default.

**Step 3: Preserve final text rendering**

Keep the current final-text coalescing and final-result marker semantics intact.

**Step 4: Run focused transcript tests**

Run: `npm test -- test/delegation-renderer.test.ts test/windows-psmux.test.ts`

Expected: PASS

### Task 5: Improve markdown-like transcript rendering for live output

**Files:**
- Modify: `src/runtime/delegation-renderer.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/delegation-renderer.test.ts`

**Step 1: Add failing formatting tests first**

Cover at least:

- headings remain visibly distinct
- bullets remain bullets
- inline code formatting survives
- final text blocks are easier to scan than plain lines

**Step 2: Make the minimal formatting improvement**

Reuse existing markdown-like formatting helpers where possible rather than introducing a new renderer stack.

The live Windows transcript path should render the same markdown-like formatting as the shared renderer helper.

**Step 3: Run focused formatting tests**

Run: `npm test -- test/delegation-renderer.test.ts`

Expected: PASS

### Task 6: Fix dashboard window-label color visibility

**Files:**
- Modify: `src/runtime/windows-dashboard-renderer.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Add a failing renderer/dashboard assertion first**

Require the `window <n>` label to use a visible ANSI color rather than the currently hard-to-see one.

This can be a string-level assertion in the dashboard renderer test if present, or a snapshot-like assertion if easier.

**Step 2: Implement the smallest style change**

Adjust only the ANSI color choice for the window label.

**Step 3: Run focused dashboard tests**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`

Expected: PASS

### Task 7: Run full verification and final heavier smoke run

**Files:**
- Test: `test/claude-stream-parser.test.ts`
- Test: `test/delegation-renderer.test.ts`
- Test: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`
- Test: `test/codex-stream-parser.test.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Run the full relevant suite**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/completion-reporting.test.ts test/delegation-tools.test.ts`

Expected: PASS

**Step 2: Run the build**

Run: `npm run build`

Expected: PASS

**Step 3: Seed a fresh heavier inspection session**

Use the heavier multi-tool prompt again and verify manually that:

- dashboard phase for Claude ends on `result.success`
- Codex transcript still looks correct
- Claude transcript shows intermediate tool summaries
- markdown-like formatting is visibly improved
- `window <n>` label is readable in the terminal theme
