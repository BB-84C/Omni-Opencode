# Windows PTY Multiplexer Proof Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Windows proof script that runs 3 real Codex sessions and 2 real Claude Code sessions in one node-pty-hosted terminal window.

**Architecture:** One standalone Node process owns five PTY children directly and renders their live output into one combined terminal view. This avoids plugin/runtime integration so we can prove the core PTY ownership model first.

**Tech Stack:** TypeScript, Node.js, node-pty, Codex CLI, Claude Code CLI.

---

### Task 1: Define The Standalone Proof Contract In Tests

**Files:**
- Create: `test/windows-pty-proof.test.ts`

**Step 1: Write the failing test**

Add tests proving the standalone proof launcher:
- defines 5 panes total
- includes 3 Codex panes and 2 Claude panes
- uses direct PTY child launch configuration rather than monitor/log attach semantics

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: FAIL because the proof script/helpers do not exist yet.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run test**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: still FAIL for the intended missing proof-script behavior.

**Step 5: Commit**

```bash
git add test/windows-pty-proof.test.ts
git commit -m "test: define windows pty proof contract"
```

### Task 2: Implement Pane Definitions And Launch Configuration

**Files:**
- Create: `scripts/windows-pty-multiplexer-proof.ts`
- Modify: `test/windows-pty-proof.test.ts`

**Step 1: Write the failing test**

Add precise tests for:
- pane labels
- backend types
- prompt/command definitions
- one PTY child spec per pane

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: FAIL because pane/launch definitions are not implemented.

**Step 3: Write minimal implementation**

Implement exported pane-definition helpers in `scripts/windows-pty-multiplexer-proof.ts`.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/windows-pty-multiplexer-proof.ts test/windows-pty-proof.test.ts
git commit -m "feat: add pty proof pane definitions"
```

### Task 3: Add Minimal Renderer For One-Terminal Multi-Pane Output

**Files:**
- Modify: `scripts/windows-pty-multiplexer-proof.ts`
- Create: `test/windows-pty-proof-renderer.test.ts`

**Step 1: Write the failing test**

Add tests proving the renderer:
- prints 5 labeled pane sections
- shows pane status
- renders buffered output from each pane into one terminal string

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty-proof-renderer.test.ts`
Expected: FAIL because the renderer does not exist yet.

**Step 3: Write minimal implementation**

Implement a simple stacked renderer that returns one terminal frame string.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-pty-proof-renderer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/windows-pty-multiplexer-proof.ts test/windows-pty-proof-renderer.test.ts
git commit -m "feat: add standalone pty proof renderer"
```

### Task 4: Wire Real PTY Child Ownership Into The Proof Script

**Files:**
- Modify: `scripts/windows-pty-multiplexer-proof.ts`
- Modify: `test/windows-pty-proof.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- the proof process spawns one PTY child per pane
- output handlers attach directly to each PTY child
- no log follower or monitor attach helpers are used

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: FAIL because PTY ownership is not fully wired yet.

**Step 3: Write minimal implementation**

Use `node-pty` directly in the standalone proof script to spawn each pane's external CLI.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-pty-proof.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/windows-pty-multiplexer-proof.ts test/windows-pty-proof.test.ts
git commit -m "feat: wire real pty ownership into proof script"
```

### Task 5: Add A Real Dry-Run / Smoke Mode For Process Verification

**Files:**
- Modify: `scripts/windows-pty-multiplexer-proof.ts`
- Create: `test/windows-pty-proof-smoke.test.ts`

**Step 1: Write the failing test**

Add tests for a smoke-oriented mode that:
- starts the configured panes
- captures initial output/state transitions
- can exit cleanly without manual interaction

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty-proof-smoke.test.ts`
Expected: FAIL because smoke mode does not exist yet.

**Step 3: Write minimal implementation**

Add a mode or flags that make the proof script suitable for short verification runs.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-pty-proof-smoke.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/windows-pty-multiplexer-proof.ts test/windows-pty-proof-smoke.test.ts
git commit -m "feat: add pty proof smoke mode"
```

### Task 6: Run The Standalone Live Proof

**Files:**
- Modify: `docs/plans/2026-04-06-windows-pty-multiplexer-proof-implementation.md`

**Step 1: Run focused tests**

Run: `npm test -- test/windows-pty-proof.test.ts test/windows-pty-proof-renderer.test.ts test/windows-pty-proof-smoke.test.ts`
Expected: PASS

**Step 2: Build the project**

Run: `npm run build`
Expected: PASS

**Step 3: Run the standalone proof script live**

Run the built proof script in one terminal and verify:
- 3 Codex panes appear
- 2 Claude panes appear
- output is live in one terminal window
- no extra PowerShell windows pop out

**Step 4: Capture process evidence**

Use process inspection to confirm:
- one parent Node proof process
- five PTY-backed child sessions

**Step 5: Commit**

```bash
git add docs/plans/2026-04-06-windows-pty-multiplexer-proof-implementation.md
git commit -m "test: verify standalone windows pty proof"
```
