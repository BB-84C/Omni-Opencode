# CLI-Like Transcript Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make delegated job transcripts feel closer to real Codex and Claude CLI sessions while preserving provider-truthful dashboard behavior and avoiding raw protocol-noise output.

**Architecture:** Build on the current provider-truthful parser layer. Adjust transcript rendering rules so Codex keeps useful stderr progress plus markdown-like answer formatting, while Claude shows concise tool activity and final answer text in a way that feels more like an actual CLI session than a normalized structured log.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`

---

### Task 1: Add RED tests for CLI-like transcript expectations

**Files:**
- Modify: `test/delegation-renderer.test.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write failing Codex transcript expectations**

Add tests that require Codex transcript behavior to feel closer to the real CLI session:

- keep meaningful progress lines
- keep intermediate assistant narration
- keep final answer markdown-like formatting
- avoid extra synthetic wrappers beyond the final marker

**Step 2: Write failing Claude transcript expectations**

Add tests that require Claude transcript behavior to feel more CLI-like:

- concise tool-use lines should remain
- tool-result lines should remain concise
- final answer should feel like direct assistant output, not a generic normalized log
- avoid protocol-only clutter

**Step 3: Run focused tests to verify RED**

Run: `npm test -- test/delegation-renderer.test.ts test/windows-psmux.test.ts`

Expected: FAIL where current transcript rendering is still too normalized or diverges from the desired CLI-like output.

### Task 2: Refine shared transcript rendering for CLI-like Codex and Claude behavior

**Files:**
- Modify: `src/runtime/delegation-renderer.ts`
- Test: `test/delegation-renderer.test.ts`

**Step 1: Keep Codex human-readable progress while reducing synthetic feel**

Adjust shared rendering rules so Codex transcript output preserves meaningful progress and markdown-like answer text without adding unnecessary abstraction.

**Step 2: Make Claude transcript output feel like direct session output**

Refine Claude transcript rendering so:

- tool activity looks like session output, not parser-debug output
- final answer reads like assistant output
- final result marker remains at the end

**Step 3: Run focused shared-renderer tests**

Run: `npm test -- test/delegation-renderer.test.ts`

Expected: PASS

### Task 3: Align the live Windows renderer with the shared CLI-like transcript rules

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write or tighten failing live-path expectations first**

Ensure the live Windows transcript tests require the same CLI-like behavior as the shared renderer helper.

**Step 2: Update the embedded Windows renderer minimally**

Make the embedded `delegation-renderer.cjs` transcript behavior match the shared helper semantics for:

- Codex progress and answer style
- Claude tool activity style
- Claude final answer style

**Step 3: Run focused live-renderer tests**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: PASS

### Task 4: Preserve dashboard truthfulness while confirming transcript changes don’t regress it

**Files:**
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Run dashboard suite after transcript changes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`

Expected: PASS

**Step 2: If any failure appears, fix only transcript-induced regressions**

Do not redesign dashboard logic here; only correct any accidental regressions caused by transcript-oriented changes.

### Task 5: Run full verification and a final CLI-like heavier smoke run

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

**Step 3: Seed a fresh heavier session**

Run a fresh multi-tool stress prompt again and verify manually that:

- Codex transcript feels like a believable Codex CLI session
- Claude transcript feels like a believable Claude CLI session
- dashboard remains provider-truthful
