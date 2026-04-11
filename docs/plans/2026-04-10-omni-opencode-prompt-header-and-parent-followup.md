# Prompt Header And Parent Follow-Up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the full original prompt at the top of every delegated transcript and inject a concise follow-up back into the parent OpenCode session once a batch has no running jobs left.

**Architecture:** Reuse the existing transcript and parent-session reporting paths. Add a one-time transcript preamble with the verbatim prompt plus a long separator line, then refine the batch-completion message generation so the injected user message stays concise and points to `delegated_job_snapshot`, `delegated_job_read`, and `delegated_job_attach` instead of dumping full reports.

**Tech Stack:** TypeScript, Node.js, Vitest, OpenCode plugin APIs

---

### Task 1: Add RED tests for transcript prompt headers

**Files:**
- Modify: `test/windows-psmux.test.ts`
- Modify: `test/delegation-renderer.test.ts`

**Step 1: Write failing live-transcript tests first**

Add tests requiring every delegated transcript to begin with:

```text
[omni-opencode] prompt
<full prompt text>
------------------------------
```

Requirements for the test:

- full prompt text appears verbatim
- separator line is exactly `------------------------------`
- header appears before any agent output
- header is written once only

**Step 2: Add any shared-renderer expectation needed**

If there is a shared transcript helper path that should reflect the same transcript preamble semantics, add a focused assertion there too.

**Step 3: Run tests to verify RED**

Run: `npm test -- test/windows-psmux.test.ts test/delegation-renderer.test.ts`

Expected: FAIL because prompt headers are not yet written to transcripts.

### Task 2: Implement one-time transcript prompt headers

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `src/runtime/transcript.ts` if needed
- Test: `test/windows-psmux.test.ts`

**Step 1: Add a minimal prompt-header formatter**

Implement a helper that produces:

```text
[omni-opencode] prompt
<prompt>
------------------------------
```

with a trailing newline so agent output starts below the separator.

**Step 2: Write the header exactly once per delegated transcript**

Hook it into delegated job startup so the transcript capture target starts with that header before any provider output is appended.

Do not duplicate the header when later transcript chunks are appended.

**Step 3: Run focused transcript tests**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: PASS

### Task 3: Add RED tests for concise parent follow-up injection

**Files:**
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/completion-reporting.test.ts`

**Step 1: Write failing injection tests first**

Add tests requiring the batch-completion injected message to:

- trigger when all jobs are terminal, regardless of mix of `completed`, `failed`, or `cancelled`
- remain concise
- include references to:
  - `delegated_job_snapshot({"jobId":"..."})`
  - `delegated_job_read({"jobId":"..."})`
  - `delegated_job_attach({"jobId":"..."})`
- avoid including the full extracted report body inline

**Step 2: Run tests to verify RED**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts`

Expected: FAIL because current aggregate follow-up is more verbose and summary-heavy than desired.

### Task 4: Refine the parent-session injected message

**Files:**
- Modify: `src/plugin.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/completion-reporting.test.ts`

**Step 1: Keep the existing injection mechanism**

Do not redesign transport. Continue using:

- `message.create(...)`
- fallback `session.promptAsync(...)`

**Step 2: Replace the aggregate message format with concise inspection guidance**

The new content should include:

- batch finished header
- one line per job with backend and final status
- where to inspect summary and transcript:
  - `delegated_job_snapshot({"jobId":"..."})`
  - `delegated_job_read({"jobId":"..."})`
  - `delegated_job_attach({"jobId":"..."})`

Do not inline the full report body.

**Step 3: Ensure completion trigger is based on “no running jobs left”**

Confirm the batch follow-up still fires when all jobs are terminal, even if not all succeeded.

**Step 4: Run focused plugin/reporting tests**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts`

Expected: PASS

### Task 5: Run full verification and a final delegated smoke check

**Files:**
- Test: `test/windows-psmux.test.ts`
- Test: `test/delegation-renderer.test.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`
- Test: `test/claude-stream-parser.test.ts`
- Test: `test/codex-stream-parser.test.ts`

**Step 1: Run the full relevant suite**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/completion-reporting.test.ts test/delegation-tools.test.ts`

Expected: PASS

**Step 2: Run the build**

Run: `npm run build`

Expected: PASS

**Step 3: Seed one fresh delegated smoke session**

Confirm manually that:

- each job window starts with the full prompt header and separator
- once all jobs are terminal, the parent OpenCode session receives a concise injected user message
- the injected message points to inspection commands instead of dumping the full report
