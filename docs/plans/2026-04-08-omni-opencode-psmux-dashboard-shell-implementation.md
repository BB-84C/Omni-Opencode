# Omni-Opencode psmux Dashboard Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the temporary 3-pane Windows `psmux` dashboard with a 2-pane model: a read-only rendered dashboard on the left and a normal interactive shell on the right.

**Architecture:** Keep the shared-session multi-window model unchanged. Only simplify window `0`: create a 2-pane dashboard layout, render dashboard metadata into the left pane only, and preserve the right pane as an untouched shell. Continue to run real delegated agents in windows `1..N` and continue using `pipe-pane` for bookkeeping.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`.

---

### Task 1: Lock The 2-Pane Dashboard Contract In Tests

**Files:**
- Modify: `test/windows-psmux-dashboard.test.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- dashboard window `0` uses exactly 2 panes
- left pane is the runtime-owned dashboard pane
- right pane is the interactive shell pane
- latest two jobs are rendered inline in dashboard text, not as separate highlight panes

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts test/windows-psmux.test.ts`
Expected: FAIL because the current runtime still expects and renders a 3-pane dashboard.

**Step 3: Write minimal implementation**

Do not change production code yet.

**Step 4: Re-run focused tests**

Run: `npm test -- test/windows-psmux-dashboard.test.ts test/windows-psmux.test.ts`
Expected: still FAIL for the intended 3-pane assumptions.

**Step 5: Commit**

```bash
git add test/windows-psmux-dashboard.test.ts test/windows-psmux.test.ts
git commit -m "test: define two-pane psmux dashboard contract"
```

### Task 2: Simplify Dashboard Layout Discovery And Creation

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add or refine tests proving:
- new dashboard creation performs only one horizontal split
- discovery accepts exactly 2 panes for dashboard window `0`
- left/right dashboard roles derive from real pane geometry

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because runtime still creates/discovers 3 panes.

**Step 3: Write minimal implementation**

In `src/runtime/windows-psmux.ts`:
- remove the second split used to create a third pane
- replace the 3-pane dashboard discovery logic with 2-pane logic
- preserve the left pane as the dashboard pane and the right pane as the shell pane

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "refactor: simplify psmux dashboard to two panes"
```

### Task 3: Render Dashboard Text Only Into The Left Pane

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- runtime renders session/job metadata only into the left pane
- right pane never receives dashboard `send-keys` updates
- latest two jobs are called out inline in the left-pane dashboard text
- dashboard text warns against nested `psmux attach` use inside the shared session

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because current renderer still writes into multiple panes.

**Step 3: Write minimal implementation**

In `src/runtime/windows-psmux.ts`:
- collapse dashboard rendering to a single left-pane render function
- keep the right pane untouched after initial session setup
- include session id, navigation hints, window mapping, latest-two inline callouts, and the nested-attach warning

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: render psmux dashboard into left pane only"
```

### Task 4: Preserve The Right Dashboard Pane As A Normal Shell

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- detached dashboard session boots into a real shell
- right pane remains an interactive shell after dashboard refreshes
- runtime no longer depends on the right pane for dashboard-owned content

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because current runtime still reflects the prior 3-pane dashboard behavior.

**Step 3: Write minimal implementation**

In `src/runtime/windows-psmux.ts`:
- keep the interactive shell bootstrap for window `0`
- ensure only the left pane is treated as dashboard-owned output
- verify refresh hooks do not target the shell pane

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts
git commit -m "fix: preserve interactive shell in dashboard window"
```

### Task 5: Update Docs And Re-Run Live Verification

**Files:**
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md`
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md`
- Modify: `docs/plans/2026-04-08-omni-opencode-psmux-dashboard-shell-design.md`

**Step 1: Run focused verification**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/windows-psmux-install.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 2: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 3: Re-run live Windows verification**

Prove:
- attach lands in dashboard window `0`
- dashboard window has exactly 2 panes
- left pane updates when jobs are launched/stopped
- right pane remains a usable shell
- Codex and Claude still live in windows `1` and `2`
- `Ctrl+b` then `n/p` still works

**Step 4: Update docs**

Record the final accepted dashboard model:
- 2-pane dashboard window
- left read-only dashboard renderer
- right interactive shell
- latest two jobs highlighted inline, not in dedicated panes

**Step 5: Commit**

```bash
git add docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md docs/plans/2026-04-08-omni-opencode-psmux-dashboard-shell-design.md
git commit -m "docs: update psmux dashboard shell design"
```
