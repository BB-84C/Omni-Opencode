# Omni-Opencode psmux Dashboard Process Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the shell-backed left dashboard pane with a dedicated long-lived dashboard process that renders session-local external-agent state with lightweight ANSI styling.

**Architecture:** Keep the current shared `psmux` multi-window model and two-pane window `0`, but change the left pane from a shell-render target into a dedicated dashboard process driven by a session-local snapshot file. The plugin/runtime remains the source of truth for session-local job state, writes a snapshot when that state changes, and launches/repairs the dashboard process independently from the right-pane shell and job windows.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`, ANSI terminal output.

---

### Task 1: Define The Dashboard Snapshot Contract In Tests

**Files:**
- Create: `test/windows-dashboard-process.test.ts`
- Modify: `src/runtime/windows-psmux.ts`

**Step 1: Write the failing test**

Add tests proving a session-local dashboard snapshot contains:

- parent session id
- job list for that session only
- backend per job
- real window index per job
- status per job
- navigation hints / title fields needed by the renderer

Include a case with jobs from another parent session to prove they are excluded.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-dashboard-process.test.ts`
Expected: FAIL because the snapshot contract/helper does not exist yet.

**Step 3: Write minimal implementation**

Add the smallest helper(s) in `src/runtime/windows-psmux.ts` or a new adjacent runtime file to build session-local dashboard snapshot data from current runtime state.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-dashboard-process.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/windows-dashboard-process.test.ts src/runtime/windows-psmux.ts
git commit -m "test: define psmux dashboard snapshot contract"
```

### Task 2: Build The ANSI Dashboard Renderer

**Files:**
- Create: `src/runtime/windows-dashboard-renderer.ts`
- Modify: `test/windows-dashboard-process.test.ts`

**Step 1: Write the failing test**

Add renderer tests proving:

- output includes dashboard title and session id
- running jobs render with an animated/spinner frame token
- completed/failed/stopped jobs render with distinct status markers
- latest active work is visually emphasized
- output uses ANSI colors and section structure
- output never includes a PowerShell prompt

Use deterministic renderer inputs so tests stay stable.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-dashboard-process.test.ts`
Expected: FAIL because the renderer module does not exist yet.

**Step 3: Write minimal implementation**

Create a small renderer that takes snapshot data plus a frame index and returns a formatted ANSI string suitable for `psmux` pane display.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-dashboard-process.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-dashboard-renderer.ts test/windows-dashboard-process.test.ts
git commit -m "feat: add ansi dashboard renderer"
```

### Task 3: Launch A Dedicated Dashboard Process In The Left Pane

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- the left pane is launched with a dedicated dashboard process command, not PowerShell
- the right pane is launched as a normal PowerShell shell
- window `0` still has exactly two panes
- attach target still lands on dashboard window `0`

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because the runtime still boots the left pane as a shell-backed renderer.

**Step 3: Write minimal implementation**

Update `src/runtime/windows-psmux.ts` so:

- the initial dashboard session/left pane runs the dedicated dashboard process command
- the right pane is created as the interactive shell
- the dashboard pane identity is still discovered via `list-panes`

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts
git commit -m "feat: launch dedicated psmux dashboard process"
```

### Task 4: Write And Refresh Session-Local Snapshot State

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`
- Modify: `test/windows-dashboard-process.test.ts`

**Step 1: Write the failing test**

Add tests proving the runtime writes/updates the dashboard snapshot when:

- the shared session is created
- a delegated job starts
- a delegated job stops/completes
- jobs from another parent session do not appear in the local snapshot

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-dashboard-process.test.ts test/windows-psmux.test.ts`
Expected: FAIL because snapshot writing/refresh hooks are incomplete.

**Step 3: Write minimal implementation**

Implement session-local snapshot-file writes on the relevant state transitions.

Keep the write path small and deterministic.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-dashboard-process.test.ts test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-dashboard-process.test.ts test/windows-psmux.test.ts
git commit -m "feat: refresh session-local dashboard snapshots"
```

### Task 5: Add Dashboard Process Recovery And Respawn Tests

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- if an existing shared session lacks the expected dashboard process in the left pane, the runtime repairs only that pane/dashboard surface
- right-pane shell and job windows are preserved where possible
- arbitrary query/parse failures still bubble and do not trigger unsafe rebuild behavior

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: FAIL because dedicated dashboard-process recovery is not implemented yet.

**Step 3: Write minimal implementation**

Implement the narrowest safe repair path for the dashboard process only.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts
git commit -m "fix: recover psmux dashboard process safely"
```

### Task 6: Update Docs And Re-Run Live Verification

**Files:**
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md`
- Modify: `docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md`
- Modify: `docs/plans/2026-04-08-omni-opencode-psmux-dashboard-process-design.md`

**Step 1: Run focused verification**

Run: `npm test -- test/windows-dashboard-process.test.ts test/windows-psmux-dashboard.test.ts test/windows-psmux.test.ts test/windows-psmux-install.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 2: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 3: Re-run live Windows verification**

Prove:

- attach lands in window `0`
- left pane runs the dedicated dashboard process
- left pane shows ANSI-styled session-local job state with no shell prompt
- right pane remains an interactive PowerShell shell
- launching/stopping jobs updates the dashboard automatically
- windows `1` and `2` remain real Codex/Claude windows
- `Ctrl+b` then `n/p` still works across dashboard and job windows

**Step 4: Update docs**

Record the final accepted model:

- dedicated dashboard process in left pane
- session-local snapshot file as dashboard state source
- right-pane shell remains interactive
- ANSI dashboard visuals for running/finished work

**Step 5: Commit**

```bash
git add docs/plans/2026-04-07-omni-opencode-psmux-multi-window-design.md docs/plans/2026-04-07-omni-opencode-psmux-multi-window-implementation.md docs/plans/2026-04-08-omni-opencode-psmux-dashboard-process-design.md
git commit -m "docs: update psmux dashboard process design"
```
