# Omni-Opencode psmux Real-Primitives Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Windows `psmux` dashboard/session layer around real `psmux` commands and real pane IDs so attach works, the dashboard is real, and slot management no longer depends on invalid tmux-shaped assumptions.

**Architecture:** Create real detached `psmux` sessions with `new-session`, build the dashboard with `split-window`, discover actual pane IDs via `list-panes -F ...`, and manage dashboard slot swaps with real pane movement primitives such as `join-pane` and `break-pane`. Background bookkeeping remains `pipe-pane`-based and separate from visible terminal behavior.

**Tech Stack:** TypeScript, Node.js, Windows `psmux`, OpenCode plugin APIs, Vitest.

---

### Task 1: Lock Invalid Commands Out In Tests

**Files:**
- Modify: `test/windows-psmux.test.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving the active Windows path must not use:
- `display-pane`
- synthetic pane targets like `.right`, `.right-top`, `.right-bottom`

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: FAIL because those assumptions are still embedded in the current runtime/tests.

**Step 3: Write minimal implementation**

Do not change production code yet.

**Step 4: Re-run focused tests**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: still FAIL for the intended reasons.

**Step 5: Commit**

```bash
git add test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts
git commit -m "test: forbid invalid psmux slot commands"
```

### Task 2: Implement Real Detached Session Bootstrap

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- first shared launch uses `start-server` and `new-session -d -s <session> ...`
- `has-session` is checked appropriately for reattach/reuse
- attach command corresponds to a real durable session

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because runtime still uses the old invalid session bootstrap path.

**Step 3: Write minimal implementation**

Implement correct detached session bootstrap using real `psmux` primitives.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts
git commit -m "feat: bootstrap real detached psmux sessions"
```

### Task 3: Build Dashboard With Real Splits And Geometry Discovery

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- dashboard is created with real `split-window` commands
- pane IDs are discovered via `list-panes -F ...`
- control/top/bottom roles are derived from real geometry

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because current dashboard state still assumes synthetic pane names.

**Step 3: Write minimal implementation**

Implement pane discovery and role assignment from real pane geometry.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: discover real psmux dashboard pane ids"
```

### Task 4: Start Each Job In A Real Execution Window

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- each delegated job starts in its own real execution window
- each job stores a real `windowId` / `paneId`-style target
- dashboard slots are no longer treated as the canonical execution homes

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because the current runtime still conflates display and execution identities.

**Step 3: Write minimal implementation**

Separate canonical job execution targets from dashboard slot targets.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: separate execution targets from dashboard slots"
```

### Task 5: Implement Real Slot Movement With join-pane / break-pane

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- latest two jobs are surfaced into top/bottom slots with real pane movement commands
- old slot occupants are moved back out safely
- no fake `display-pane` behavior remains

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because real slot movement has not been implemented yet.

**Step 3: Write minimal implementation**

Implement slot swaps with real pane movement primitives and rediscover pane IDs after structural changes.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: use real psmux pane movement for dashboard slots"
```

### Task 6: Rewire Plugin / Attach Paths To Real Session Model

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- returned attach command maps to a real session that exists
- detached reattach does not recreate a session incorrectly
- auto-open uses the real session attach path

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: FAIL because plugin/runtime behavior still assumes the older pseudo-dashboard semantics.

**Step 3: Write minimal implementation**

Adjust plugin/runtime interaction to the revised real-primitives session model.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/delegation-tools.test.ts test/job-controls.test.ts
git commit -m "feat: align plugin attach flow with real psmux sessions"
```

### Task 7: Full Regression Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-real-primitives-design.md`

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

Update docs to remove references to invalid synthetic pane target behavior and describe the real `psmux` primitive model.

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-07-omni-opencode-psmux-real-primitives-design.md docs/plans/2026-04-07-omni-opencode-psmux-real-primitives-implementation.md
git commit -m "docs: describe real psmux primitive dashboard model"
```

### Task 8: Live Windows Verification

**Files:**
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-real-primitives-implementation.md`

**Step 1: First delegated launch**

Prove:
- a real detached `psmux` session is created
- returned attach command actually attaches
- no `no server running` failure occurs

**Step 2: Dashboard verification**

Prove:
- dashboard window exists
- control pane exists
- top and bottom slots exist as real panes

**Step 3: Multi-job verification**

Prove:
- latest two jobs are shown by default
- slot swaps use real pane movement and still leave the session usable

**Step 4: Batch / bookkeeping verification**

Prove:
- `pipe-pane` bookkeeping still works
- aggregate follow-up still works

**Step 5: Record evidence**

Capture:
- attach command
- session existence proof
- dashboard pane list / geometry
- visible terminal result

**Step 6: Commit**

```bash
git add docs/plans/2026-04-07-omni-opencode-psmux-real-primitives-implementation.md
git commit -m "test: verify real-primitive psmux dashboard live"
```
