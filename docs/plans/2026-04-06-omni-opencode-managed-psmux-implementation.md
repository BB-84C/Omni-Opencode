# Omni-Opencode Managed psmux Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Windows `psmux` runtime plugin-managed by downloading, caching, verifying, and using a pinned GitHub release binary instead of requiring `psmux` on PATH.

**Architecture:** The plugin manages a versioned local cache of `psmux` under `.omni-tools/psmux/`. Windows runtime startup resolves the pinned binary from that cache, installs it on demand from GitHub releases if missing, verifies it, and uses the resolved absolute binary path for all runtime and attach commands.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, GitHub release downloads, Windows `psmux`.

---

### Task 1: Define Managed psmux Install Contract In Tests

**Files:**
- Create: `test/windows-psmux-install.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- the runtime resolves a managed binary path from plugin-managed cache
- missing managed binary triggers install attempt
- returned attach command uses the managed binary path, not bare `psmux`

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: FAIL because managed install flow does not exist yet.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run the focused test**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: still FAIL for intended missing behavior.

**Step 5: Commit**

```bash
git add test/windows-psmux-install.test.ts
git commit -m "test: define managed psmux install contract"
```

### Task 2: Add Managed psmux Resolver And Cache Paths

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Create: `src/runtime/windows-psmux-managed.ts`
- Modify: `test/windows-psmux-install.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- pinned version path resolution works
- manifest/cache paths are deterministic
- attach command uses the resolved managed binary path

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: FAIL because resolver does not exist yet.

**Step 3: Write minimal implementation**

Implement managed-cache path resolution helpers and binary-path construction.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts src/runtime/windows-psmux-managed.ts test/windows-psmux-install.test.ts
git commit -m "feat: add managed psmux path resolver"
```

### Task 3: Implement Download / Extract / Verify Hooks

**Files:**
- Modify: `src/runtime/windows-psmux-managed.ts`
- Modify: `test/windows-psmux-install.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- missing managed version triggers download hook
- extraction path is used
- verify hook runs on extracted binary
- successful install writes manifest metadata

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: FAIL because install hooks are not implemented yet.

**Step 3: Write minimal implementation**

Implement install pipeline hooks in a testable way:
- download
- extract
- verify
- manifest write

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-install.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux-managed.ts test/windows-psmux-install.test.ts
git commit -m "feat: add managed psmux install pipeline"
```

### Task 4: Wire Windows Runtime To Managed Binary Path

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `test/windows-psmux.test.ts`
- Modify: `test/windows-psmux-bootstrap.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- runtime startup uses resolved managed binary path
- attach command uses managed binary path
- no PATH dependency is required when managed binary exists

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: FAIL because runtime still assumes bare `psmux` command.

**Step 3: Write minimal implementation**

Switch runtime command building from bare `psmux` to resolved managed binary path.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts test/windows-psmux-bootstrap.test.ts
git commit -m "feat: use managed psmux binary path"
```

### Task 5: Replace Support-Only Bootstrap With Real Managed Install Flow

**Files:**
- Modify: `scripts/windows-psmux-bootstrap.mjs`
- Modify: `package.json`
- Modify: `test/windows-psmux-bootstrap.test.ts`

**Step 1: Write the failing test**

Add tests proving the bootstrap script:
- reports cached version reuse
- triggers managed install when missing
- surfaces actionable failures by stage

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-bootstrap.test.ts`
Expected: FAIL because bootstrap is currently only a check/report path.

**Step 3: Write minimal implementation**

Upgrade bootstrap script to call the real managed install pipeline.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/windows-psmux-bootstrap.mjs package.json test/windows-psmux-bootstrap.test.ts
git commit -m "feat: add managed psmux bootstrap flow"
```

### Task 6: Full Regression Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-06-omni-opencode-managed-psmux-design.md`

**Step 1: Run focused managed-install verification**

Run: `npm test -- test/windows-psmux-install.test.ts test/windows-psmux.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 2: Run full suite**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 3: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 4: Update docs**

Update docs to describe:
- managed binary cache path
- pinned release install flow
- managed attach command semantics

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-06-omni-opencode-managed-psmux-design.md docs/plans/2026-04-06-omni-opencode-managed-psmux-implementation.md
git commit -m "docs: describe managed psmux dependency flow"
```

### Task 7: Live Windows Verification With Managed Binary

**Files:**
- Modify: `docs/plans/2026-04-06-omni-opencode-managed-psmux-implementation.md`

**Step 1: Remove/avoid preinstalled psmux dependency**

Verify the live run does not depend on system `PATH` installation.

**Step 2: Run first delegated Windows launch**

Prove:
- plugin downloads pinned release
- extracts managed binary
- verifies it
- launches shared psmux session

**Step 3: Run second delegated Windows launch**

Prove:
- plugin reuses the cached binary
- no redownload occurs
- shared session behavior still works

**Step 4: Verify attach command**

Prove launch payload returns a managed-binary attach command using the cached absolute path.

**Step 5: Record evidence**

Capture:
- managed cache path created
- manifest written
- attach command returned
- terminal/session behavior still correct

**Step 6: Commit**

```bash
git add docs/plans/2026-04-06-omni-opencode-managed-psmux-implementation.md
git commit -m "test: verify managed psmux installation live"
```
