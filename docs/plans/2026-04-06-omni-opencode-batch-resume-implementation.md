# Omni-Opencode Batch Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve Omni-Opencode from simple PTY/tmux background delegation into an `oh-my-opencode`-style batch controller that auto-opens monitors, returns explicit attach commands, stops the main agent after launch confirmation, and injects one aggregate follow-up message when all delegated jobs from a turn finish.

**Architecture:** Parent-facing delegation tools remain the entrypoint. The broker adds `batchId` grouping, aggregate completion detection, and parent-session wake-up injection. Windows keeps a node-pty-backed helper runtime but must expose a proper monitor command in addition to a log tail fallback. Linux/macOS continue to use tmux as the native attach surface.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, node-pty, tmux.

---

### Task 1: Add Failing Batch Aggregation Tests

**Files:**
- Create: `test/batch-resume.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- two delegated jobs launched from one parent turn share one `batchId`
- no aggregate follow-up is sent while any job in the batch is still running
- one aggregate follow-up is sent when all jobs are terminal

**Step 2: Run test to verify it fails**

Run: `npm test -- test/batch-resume.test.ts`
Expected: FAIL because batch aggregation does not exist yet.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run focused test**

Run: `npm test -- test/batch-resume.test.ts`
Expected: still FAIL, but for the intended missing behavior.

**Step 5: Commit**

```bash
git add test/batch-resume.test.ts
git commit -m "test: define batch resume behavior"
```

### Task 2: Extend Job Model With Batch Identity

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/core/store.ts`
- Modify: `test/store.test.ts`

**Step 1: Write the failing test**

Add coverage for:
- `batchId`
- batch membership persistence
- querying all jobs in a batch

**Step 2: Run test to verify it fails**

Run: `npm test -- test/store.test.ts test/batch-resume.test.ts`
Expected: FAIL because store has no batch semantics.

**Step 3: Write minimal implementation**

Add `batchId` to the persisted job model and helper methods for retrieving jobs by batch.

**Step 4: Run focused tests**

Run: `npm test -- test/store.test.ts test/batch-resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/jobs.ts src/core/store.ts test/store.test.ts test/batch-resume.test.ts
git commit -m "feat: add batch identity to delegated jobs"
```

### Task 3: Return Explicit Attach Commands In Delegation Launch Payloads

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/runtime/types.ts`
- Modify: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add assertions that tool output includes:
- `jobId`
- `batchId`
- `attachCommand`
- `monitorTarget`
- `autoOpenAttempted`
- `autoOpenSucceeded`

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: FAIL because attach command/batch output is incomplete.

**Step 3: Write minimal implementation**

Update launch payload formatting to include the required fields.

**Step 4: Run focused test**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts src/runtime/types.ts test/delegation-tools.test.ts
git commit -m "feat: return batch and attach metadata on launch"
```

### Task 4: Add Windows Primary Attach Command Surface

**Files:**
- Modify: `src/runtime/windows-pty.ts`
- Modify: `test/windows-pty.test.ts`

**Step 1: Write the failing test**

Add coverage that Windows monitor metadata returns:
- `attachCommand` suitable for user-facing monitor entry
- optional `logTailCommand` as fallback

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty.test.ts`
Expected: FAIL because current Windows attach is only the log file target.

**Step 3: Write minimal implementation**

Expose a real user-facing Windows monitor command contract, such as `omni monitor <jobId>`, while keeping `Get-Content -Wait` as fallback.

**Step 4: Run focused test**

Run: `npm test -- test/windows-pty.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-pty.ts test/windows-pty.test.ts
git commit -m "feat: add windows attach command contract"
```

### Task 5: Stop Main-Agent Polling By Emitting One Aggregate Follow-Up

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/completion-reporting.test.ts`
- Modify: `test/batch-resume.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- no per-job wake-up message is emitted during partial batch completion
- one aggregate user message is emitted when the whole batch is done

**Step 2: Run test to verify it fails**

Run: `npm test -- test/completion-reporting.test.ts test/batch-resume.test.ts`
Expected: FAIL because current reporting is job-oriented.

**Step 3: Write minimal implementation**

Refactor completion reporting so the parent session gets one aggregate user message per batch.

**Step 4: Run focused tests**

Run: `npm test -- test/completion-reporting.test.ts test/batch-resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/completion-reporting.test.ts test/batch-resume.test.ts
git commit -m "feat: aggregate batch completion reporting"
```

### Task 6: Include Inspection Commands In Aggregate Follow-Up

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/completion-reporting.test.ts`

**Step 1: Write the failing test**

Assert that the aggregate follow-up includes:
- `jobId`
- `delegated_job_snapshot(jobId)` reference
- `delegated_job_read(jobId)` reference
- attach command reference

**Step 2: Run test to verify it fails**

Run: `npm test -- test/completion-reporting.test.ts`
Expected: FAIL because current summaries do not include all drill-down commands.

**Step 3: Write minimal implementation**

Augment the aggregate completion message with the commands for drill-down inspection.

**Step 4: Run focused test**

Run: `npm test -- test/completion-reporting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/completion-reporting.test.ts
git commit -m "feat: add transcript inspection references to batch summary"
```

### Task 7: Add Batch-Aware Snapshot And List Semantics

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add coverage that:
- `delegated_jobs_list` exposes `batchId`
- batch jobs can be grouped coherently
- final aggregate state remains inspectable after wake-up

**Step 2: Run test to verify it fails**

Run: `npm test -- test/job-controls.test.ts`
Expected: FAIL because batch grouping is not surfaced enough yet.

**Step 3: Write minimal implementation**

Expose batch-aware fields through list/snapshot outputs.

**Step 4: Run focused test**

Run: `npm test -- test/job-controls.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/job-controls.test.ts
git commit -m "feat: expose batch-aware job inspection"
```

### Task 8: Update End-To-End Tests To Enforce Main-Agent Stop/Resume Pattern

**Files:**
- Modify: `test/e2e/monitor-flow.test.ts`
- Modify: `test/e2e/real-pipeline.test.ts`

**Step 1: Write the failing test**

Add e2e assertions that:
- delegation tools return immediately with batch/attach metadata
- the resumed message is injected only after all jobs in the batch finish
- the main path no longer relies on ad hoc sleeps/polling in the intended steady-state design

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/monitor-flow.test.ts test/e2e/real-pipeline.test.ts`
Expected: FAIL because the current behavior is still too job/poll oriented.

**Step 3: Write minimal implementation**

Update e2e behavior and supporting glue to satisfy the new steady-state lifecycle.

**Step 4: Run focused tests**

Run: `npm test -- test/e2e/monitor-flow.test.ts test/e2e/real-pipeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e/monitor-flow.test.ts test/e2e/real-pipeline.test.ts
git commit -m "test: enforce batch stop-and-resume lifecycle"
```

### Task 9: Update README For Final Operational Model

**Files:**
- Modify: `README.md`

**Step 1: Write the failing test**

No automated failing test needed. Use this task to document the final operator-facing behavior.

**Step 2: Verify documentation gap**

Run: `grep -n "batch\|attach\|resume\|delegate_to" README.md`
Expected: current README does not fully describe the final batch-resume behavior.

**Step 3: Write minimal implementation**

Document:
- tool-driven delegation
- batch behavior
- attach commands
- auto-open semantics
- aggregate follow-up resume behavior
- Windows vs Linux/macOS monitor differences

**Step 4: Verify docs updated**

Run: `grep -n "batch\|attach\|resume\|delegate_to" README.md`
Expected: relevant sections present.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe batch resume delegation model"
```

### Task 10: Final Verification

**Files:**
- Modify as needed based on verification only

**Step 1: Run automated verification**

Run: `npm test -- --runInBand`
Expected: all tests pass.

**Step 2: Rebuild plugin**

Run: `npm run build`
Expected: `dist` refreshed successfully.

**Step 3: Live verification**

Run a fresh OpenCode session in `D:\Omni-Opencode` and verify:
- delegation tools are visible and used
- each tool returns `jobId`, `batchId`, and attach command
- monitor windows auto-open on Windows
- main agent stops after launch confirmation
- plugin later injects one aggregate user message after all delegated jobs finish
- aggregate message includes summary plus snapshot/read/attach references

**Step 4: Only then report success**

Do not report the plugin ready until the live behavior is actually observed.

## Notes For The Implementing Agent

- The plugin is already close; do not redesign from scratch.
- The biggest remaining gap is lifecycle behavior, not basic delegation launch.
- Keep summaries concise and history opt-in.
- Preserve plugin-only constraints; do not depend on OpenCode core changes.
