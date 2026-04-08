# Omni-Opencode psmux Multi-Window Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the invalid embedded-slot Windows `psmux` model with a proven multi-window model: one shared session, one dashboard window, and one real `psmux` window per delegated external agent.

**Architecture:** The dashboard is a control/index window at session window `0`. Each delegated job gets a real execution window that runs the interactive Codex or Claude CLI directly. The plugin returns one attach command per parent session, lands the user in the dashboard by default, and uses real window switching rather than pane embedding.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Windows `psmux`, Vitest.

---

## Current Progress

All multi-window implementation tasks are complete. Additionally, the dashboard has been upgraded from a shell-backed rendering model to a dedicated dashboard process model:

- Task 1: lock the multi-window model in tests
- Task 2: remove embedded slot movement from runtime
- Task 3: add real window identity tracking
- Task 4: rewire plugin attach / switch semantics
- Task 5: dashboard metadata for latest two jobs
- Task 6: full regression verification
- **Dashboard process upgrade (2026-04-08):**
  - Defined session-local dashboard snapshot contract
  - Built ANSI dashboard renderer with color/spinners
  - Launched dedicated dashboard process in left pane
  - Wired snapshot file writes on job state transitions
  - Added dashboard process recovery via `respawn-pane`

Verified status at this checkpoint:

- focused psmux suites are green (`5` files, `101` tests, `0` failures)
- `npm run build` is green

The remaining task is:

- Task 7: live Windows verification

The dashboard model is now: left pane runs a dedicated Node.js process that polls a session-local JSON snapshot file and renders ANSI-styled status. No shell prompt appears in the left pane. The right pane remains an interactive PowerShell shell.

### Task 1: Lock The Multi-Window Model In Tests

**Files:**
- Modify: `test/windows-psmux-dashboard.test.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- dashboard window is an index/control window, not a live agent pane host
- delegated jobs live in their own real windows
- no production path depends on `join-pane` / `break-pane` for dashboard composition

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: FAIL because current runtime still assumes live slot movement.

**Step 3: Write minimal implementation**

Do not change production code yet.

**Step 4: Re-run focused tests**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: still FAIL for intended reasons.

**Step 5: Commit**

```bash
git add test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts
git commit -m "test: define psmux multi-window contract"
```

### Task 2: Remove Embedded Slot Movement From Runtime

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add or refine tests proving:
- dashboard creation does not call `join-pane` / `break-pane` to surface jobs
- job windows remain separate execution homes
- dashboard window stays stable while jobs are launched

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because slot-movement behavior is still present.

**Step 3: Write minimal implementation**

Remove embedded-slot movement logic and keep job windows separate.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "refactor: use multi-window psmux dashboard model"
```

### Task 3: Add Real Window Identity Tracking

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `src/runtime/types.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- each delegated job stores a real `psmux` window identity
- dashboard is window `0`
- later plugin operations can switch to the correct real window

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because runtime still lacks explicit window-focused state.

**Step 3: Write minimal implementation**

Persist and expose real window identity per job.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts src/runtime/types.ts test/windows-psmux.test.ts
git commit -m "feat: track real psmux window identity per job"
```

### Task 4: Rewire Plugin Attach / Switch Semantics

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- attach lands in dashboard window `0`
- job navigation uses real window switching semantics
- reattach still uses the shared session attach command

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: FAIL because plugin/runtime still assume the embedded-slot model.

**Step 3: Write minimal implementation**

Align plugin/runtime metadata and attach behavior with the multi-window model.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/delegation-tools.test.ts test/job-controls.test.ts
git commit -m "feat: align plugin attach flow with psmux multi-window model"
```

### Task 5: Dashboard Metadata For Latest Two Jobs

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- latest two jobs are highlighted in dashboard metadata
- older jobs remain accessible as windows
- no embedded pane assumptions remain

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because latest-two is still modeled as slot occupancy.

**Step 3: Write minimal implementation**

Convert latest-two from pane-slot state to dashboard metadata/highlight state.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: track latest two jobs as dashboard metadata"
```

### Task 6: Full Regression Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md`

**Step 1: Run focused psmux verification**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: PASS

**Step 2: Run full suite**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 3: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 4: Update docs**

Update docs to describe the multi-window `psmux` model and remove embedded-slot assumptions.

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md
git commit -m "docs: describe psmux multi-window dashboard model"
```

### Task 7: Live Windows Verification

**Files:**
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md`

**Step 1: First delegated launch**

Prove:
- real detached `psmux` session is created
- attach lands in dashboard window `0`

**Step 2: Multi-job verification**

Prove:
- Codex gets a real job window
- Claude gets a real job window
- both are interactive real CLIs

**Step 3: Dashboard verification**

Prove:
- dashboard remains stable
- latest two jobs are visible as metadata/highlights
- switching from dashboard to each job window works

**Step 4: Batch / bookkeeping verification**

Prove:
- `pipe-pane` still works
- aggregate follow-up still works

**Step 5: Record evidence**

Capture:
- attach command
- `list-windows` output
- screenshots of dashboard, Codex window, Claude window

**Step 6: Commit**

```bash
git add docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md
git commit -m "test: verify psmux multi-window model live"
```
