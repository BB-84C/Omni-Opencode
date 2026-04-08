# Omni-Opencode psmux Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Windows `node-pty` path with `psmux` as the primary Windows backend for shared external-agent sessions, while keeping `node-pty` archived as fallback/reference only.

**Architecture:** One shared `psmux` session is created per parent OpenCode session. The plugin orchestrates session/window/pane creation and returns a stable `psmux attach -t <monitorSessionId>` command for all jobs in that parent session. Codex and Claude run directly inside `psmux`; `pipe-pane` is used only for background bookkeeping.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, `psmux`, PowerShell.

---

### Task 1: Define psmux Session Contract In Tests

**Files:**
- Create: `test/windows-psmux.test.ts`
- Modify: `test/shared-monitor-session.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- Windows attach command is `psmux attach -t <monitorSessionId>`
- all delegated jobs in one parent session return the same attach command
- Windows runtime kind is no longer `windows-pty` on the primary path

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/shared-monitor-session.test.ts`
Expected: FAIL because `psmux` runtime does not exist yet.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run the focused tests**

Run: `npm test -- test/windows-psmux.test.ts test/shared-monitor-session.test.ts`
Expected: still FAIL for the intended missing behavior.

**Step 5: Commit**

```bash
git add test/windows-psmux.test.ts test/shared-monitor-session.test.ts
git commit -m "test: define psmux session contract"
```

### Task 2: Add Windows psmux Runtime Selection

**Files:**
- Modify: `src/runtime/select-runtime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving Windows runtime selection defaults to `windows-psmux` and only archives `windows-pty`.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because runtime selector still points to `windows-pty`.

**Step 3: Write minimal implementation**

Introduce the new runtime kind and selection wiring without full runtime behavior yet.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/select-runtime.ts src/runtime/types.ts test/windows-psmux.test.ts
git commit -m "feat: select psmux as primary windows runtime"
```

### Task 3: Implement psmux Dependency Detection And Bootstrap Hooks

**Files:**
- Create: `src/runtime/windows-psmux.ts`
- Create: `test/windows-psmux-bootstrap.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

Add tests proving:
- `psmux` detection works
- missing `psmux` produces a clear Windows runtime error
- install/bootstrap hook surface is defined

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-bootstrap.test.ts`
Expected: FAIL because no bootstrap/detection code exists.

**Step 3: Write minimal implementation**

Implement `psmux` detection/bootstrap helpers in `windows-psmux.ts` and update dependency notes in `package.json` only as required for this task.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-bootstrap.test.ts package.json
git commit -m "feat: add psmux bootstrap hooks"
```

### Task 4: Implement Shared psmux Session Creation And Attach Contract

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- first delegated job creates/reuses one `psmux` session per `monitorSessionId`
- attach command is `psmux attach -t <monitorSessionId>`
- second job in same parent session reuses the same session
- no second auto-open window is requested

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because session orchestration is not implemented yet.

**Step 3: Write minimal implementation**

Implement shared `psmux` session creation, stable attach command return, and one-time auto-open behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts
git commit -m "feat: add shared psmux session runtime"
```

### Task 5: Implement Dashboard Window Layout And Slot Policy

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Create: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- dashboard window is created
- left control-center pane exists
- right-top and right-bottom display slots exist
- latest two jobs occupy the right-side slots by default

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because dashboard orchestration does not exist yet.

**Step 3: Write minimal implementation**

Add `psmux` command orchestration for dashboard layout and latest-two slot mapping.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: add psmux dashboard slot layout"
```

### Task 6: Add Background Bookkeeping With `pipe-pane`

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `src/core/jobs.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- each delegated job configures `pipe-pane` bookkeeping in background
- visible attach contract remains native `psmux`
- transcript capture target is tracked per job

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because `pipe-pane` bookkeeping is not implemented yet.

**Step 3: Write minimal implementation**

Implement background `pipe-pane` capture without changing visible terminal behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts src/core/jobs.ts test/windows-psmux.test.ts
git commit -m "feat: add psmux pipe-pane bookkeeping"
```

### Task 7: Refactor Plugin Launch Flow To Use psmux Runtime

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- Windows launch payload now returns `psmux attach -t <monitorSessionId>`
- first launch auto-opens one shared session
- later launches reuse same attach command and same shared session

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: FAIL because plugin launch still assumes the old Windows backend.

**Step 3: Write minimal implementation**

Switch plugin Windows launch flow to the `psmux` runtime while preserving Linux/macOS behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/delegation-tools.test.ts test/job-controls.test.ts
git commit -m "feat: launch windows delegated jobs through psmux"
```

### Task 8: Preserve Batch Resume With psmux Windows Sessions

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/batch-resume.test.ts`
- Modify: `test/completion-reporting.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- batch completion behavior is unchanged
- aggregate follow-up references `psmux` attach command correctly
- background bookkeeping still supports summaries and reads

**Step 2: Run test to verify it fails**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: FAIL because completion paths still assume prior Windows behavior.

**Step 3: Write minimal implementation**

Adjust completion/reporting paths to use `psmux`-derived monitor metadata.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/batch-resume.test.ts test/completion-reporting.test.ts
git commit -m "feat: preserve batch resume with psmux windows sessions"
```

### Task 9: Archive node-pty Windows Path Without Deleting It

**Files:**
- Modify: `src/runtime/windows-pty.ts`
- Modify: `src/runtime/windows-multiplexer.ts`
- Modify: `src/runtime/windows-multiplexer-host.ts`
- Modify: relevant tests under `test/windows-pty.test.ts` and `test/windows-multiplexer.test.ts`

**Step 1: Write the failing test or doc check**

Add a focused check proving:
- `node-pty` Windows code is no longer selected on the primary Windows path
- archived tests are clearly marked as fallback/archive coverage only

**Step 2: Run verification**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts test/windows-psmux.test.ts`
Expected: FAIL or mismatch until archive boundaries are clear.

**Step 3: Write minimal implementation**

Mark the old Windows path as archived/fallback and ensure it is no longer the active path.

**Step 4: Run verification**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-pty.ts src/runtime/windows-multiplexer.ts src/runtime/windows-multiplexer-host.ts test/windows-pty.test.ts test/windows-multiplexer.test.ts test/windows-psmux.test.ts
git commit -m "refactor: archive node-pty windows path behind psmux"
```

### Task 10: Live Verification On Windows

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-06-omni-opencode-psmux-design.md`

**Step 1: Run focused automated verification**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 2: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 3: Run live OpenCode verification**

Prove on Windows that:
- first delegated job opens one shared `psmux` session window
- second delegated job reuses same window
- third and later jobs do not open more windows
- dashboard layout exists with left control center and two right-side slots
- latest two jobs are shown by default
- focused slot behaves like a normal terminal pane
- attach command is `psmux attach -t <monitorSessionId>`
- aggregate follow-up still arrives once the batch finishes

**Step 4: Update docs**

Update docs to reflect `psmux` as the required primary Windows backend and `node-pty` as archive/fallback.

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-06-omni-opencode-psmux-design.md docs/plans/2026-04-06-omni-opencode-psmux-implementation.md
git commit -m "docs: describe psmux as primary windows backend"
```
