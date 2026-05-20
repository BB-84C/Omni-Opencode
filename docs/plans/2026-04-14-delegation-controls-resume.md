# Delegation Controls And Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add explicit `model` and `reasoningEffort` controls to delegated launches and strict resume, persist requested/effective values in bookkeeping, and always report those values in tool output and aggregate follow-ups.

**Architecture:** Keep the public plugin contract explicit with top-level `model` and `reasoningEffort` fields on launch and resume tools. Treat resume as a new delegated plugin-side job linked back to the source job, while strictly continuing the original backend thread when stored backend resume identifiers exist. Thread the requested controls through plugin launch metadata and runtime command construction, then persist/report both requested and effective values on the delegated job record.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Windows psmux runtime, Vitest, file-backed broker state.

---

### Task 1: Extend Delegated Job Metadata

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/plugin.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add a launch-shape test in `test/delegation-tools.test.ts` that expects launch results and persisted snapshots to carry the new fields.

```ts
it("returns stored model and reasoning fields in launch metadata", async () => {
  const launch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
    { prompt: "inspect this", model: "gpt-5-codex", reasoningEffort: "high" },
    makeContext("parent-session-1") as never,
  ))

  expect(launch.requestedModel).toBe("gpt-5-codex")
  expect(launch.requestedReasoningEffort).toBe("high")
  expect(launch.effectiveModel).toBe("gpt-5-codex")
  expect(launch.effectiveReasoningEffort).toBe("high")
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: FAIL because tool args/results and snapshots do not yet include the new fields.

**Step 3: Write minimal implementation**

Update delegated job/bookkeeping types to include:

```ts
requestedModel?: string
requestedReasoningEffort?: string
effectiveModel?: string
effectiveReasoningEffort?: string
resumedFromJobId?: string
rootJobId?: string
```

Extend `RuntimeStartLaunchMetadata` in `src/runtime/types.ts` and the stored-job construction path in `src/plugin.ts` so these values can be persisted.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: PASS for the new launch-shape assertions.

**Step 5: Commit**

```bash
git add src/core/jobs.ts src/runtime/types.ts src/plugin.ts test/delegation-tools.test.ts
git commit -m "feat: persist delegated model metadata"
```

### Task 2: Add Explicit Launch Controls To Delegate Tools

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Write the failing tests**

Add launch tests for both defaults and explicit overrides.

```ts
expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
  launchMetadata: expect.objectContaining({
    requestedModel: "claude-opus-4-1",
    requestedReasoningEffort: "medium",
  }),
}))
```

Add psmux coverage that the backend command builder includes the flags when provided.

```ts
expect(script).toContain("--model")
expect(script).toContain("--reasoning-effort")
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- test/delegation-tools.test.ts test/windows-psmux.test.ts`
Expected: FAIL because launch tools currently only accept `prompt` and the Windows runtime does not yet thread model/effort flags.

**Step 3: Write minimal implementation**

Update `delegate_to_claude` and `delegate_to_codex` args in `src/plugin.ts` to accept:

```ts
model?: string
reasoningEffort?: string
```

Thread those values through launch metadata and backend command construction. For Codex and Claude default behavior, use:

- explicit requested value when provided
- `effective* = requested value` when provided
- `effective* = "default"` when omitted unless a later backend observation can refine it

Update `src/runtime/windows-psmux.ts` to include the appropriate backend CLI flags in the generated scripts when explicit values are present.

**Step 4: Run tests to verify they pass**

Run: `npm test -- test/delegation-tools.test.ts test/windows-psmux.test.ts`
Expected: PASS for explicit launch controls and default reporting.

**Step 5: Commit**

```bash
git add src/plugin.ts src/runtime/windows-psmux.ts test/delegation-tools.test.ts test/windows-psmux.test.ts
git commit -m "feat: add model and reasoning launch controls"
```

### Task 3: Expose Strict Delegated Resume

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/core/jobs.ts`
- Modify: `src/runtime/types.ts`
- Test: `test/batch-resume.test.ts`
- Test: `test/completion-reporting.test.ts`

**Step 1: Write the failing tests**

Add strict-resume tests that cover:

- resume fails when no stored backend resume identity exists
- resume with injected prompt creates a new linked job record
- resume reuses stored model/effort when omitted
- resume overrides model/effort when provided

Example assertion shape:

```ts
const resumed = JSON.parse(await plugin.tool!.delegated_job_resume.execute(
  { jobId: sourceJobId, prompt: "continue with more detail", model: "gpt-5-codex", reasoningEffort: "high" },
  makeContext("parent-session-1", "message-2") as never,
))

expect(resumed.resumedFromJobId).toBe(sourceJobId)
expect(resumed.rootJobId).toBe(sourceJobId)
expect(resumed.batchId).toBe("parent-session-1:message-2")
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: FAIL because `delegated_job_resume` is not yet exposed and resume lineage/batching are not implemented.

**Step 3: Write minimal implementation**

Expose `delegated_job_resume` in `src/plugin.ts`.

Implementation rules:

- load source job
- reject if source job is still running
- reject if no `backendResumeSessionId` or equivalent stored resume identity exists
- create a new delegated runtime launch with new batch identity from the resume turn
- persist `resumedFromJobId` and `rootJobId`
- reuse stored model/effort unless overridden
- inject a continuation instruction built from prior job state plus optional prompt

**Step 4: Run tests to verify they pass**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: PASS for strict resume, new-job lineage, and new-batch behavior.

**Step 5: Commit**

```bash
git add src/plugin.ts src/core/jobs.ts src/runtime/types.ts test/batch-resume.test.ts test/completion-reporting.test.ts
git commit -m "feat: add strict delegated resume"
```

### Task 4: Always Report Model And Effort

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/runtime/extract-report.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Write the failing tests**

Add assertions that:

- launch result payloads include model/effort fields
- snapshots include requested/effective model/effort fields
- aggregate parent follow-up lines include `model=` and `reasoningEffort=`

```ts
expect(completionUpdate).toContain("model=gpt-5-codex")
expect(completionUpdate).toContain("reasoningEffort=high")
expect(snapshot).toContain('"effectiveModel": "default"')
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- test/completion-reporting.test.ts test/delegation-tools.test.ts`
Expected: FAIL because follow-ups and snapshots do not yet guarantee model/effort reporting.

**Step 3: Write minimal implementation**

Update parent-facing formatting helpers in `src/plugin.ts` so aggregate follow-ups always include the stored effective model and effective reasoning effort.

Keep reporting truthful:

```ts
const modelLabel = job.effectiveModel ?? "default"
const effortLabel = job.effectiveReasoningEffort ?? "default"
```

Adjust fallback summary parsing only as needed so reporting metadata does not contaminate human-readable summaries.

**Step 4: Run tests to verify they pass**

Run: `npm test -- test/completion-reporting.test.ts test/delegation-tools.test.ts`
Expected: PASS with concise follow-up lines that always include model and effort.

**Step 5: Commit**

```bash
git add src/plugin.ts src/runtime/extract-report.ts test/completion-reporting.test.ts test/delegation-tools.test.ts
git commit -m "feat: report delegated model and reasoning metadata"
```

### Task 5: Regression Sweep And Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-14-delegation-controls-resume-design.md`
- Test: `test/delegation-tools.test.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/batch-resume.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Write the doc updates**

Document:

- new `model` and `reasoningEffort` tool args
- strict `delegated_job_resume`
- requested versus effective semantics
- that aggregate follow-ups always report model and effort

**Step 2: Run the focused regression suite**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts test/batch-resume.test.ts test/windows-psmux.test.ts`
Expected: PASS

**Step 3: Run build verification**

Run: `npm run build`
Expected: build succeeds

**Step 4: Run the broader persistence safety checks**

Run: `npm test -- test/store.test.ts test/store-race.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-14-delegation-controls-resume-design.md src test
git commit -m "feat: add delegated resume controls and reporting"
```
