# Authoritative Delegation Permission Source Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewire delegated permission resolution so Codex and Claude launches derive permissions from the active OpenCode invocation's authoritative effective permission envelope, failing closed when that authority is unavailable.

**Architecture:** Keep the existing delegated capability model, grant persistence, grouped `ask` prompts, and backend policy mapping. Replace only the current launch-context authority source: add an explicit authoritative permission resolver, thread its result into the existing capability pipeline, demote `context.permissions` to diagnostic-only input, and block launches when authoritative permission resolution cannot be proven.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest

---

### Task 1: Add RED tests for authoritative permission precedence

**Files:**
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/helpers/delegation-plugin-fixture.ts`
- Modify: `src/core/delegation-launch-context.ts`

**Step 1: Write failing tests for authoritative permission resolution winning over `context.permissions`**

Add tests that drive a new authoritative permission seam exposed through the plugin fixture. Required cases:

- authoritative read-only permissions with permissive `context.permissions` still produce read-only delegation
- authoritative write/shell permissions with restrictive `context.permissions` still produce write/shell delegation

Keep the tests focused on launch behavior and approval outcomes, not provider internals.

**Step 2: Write a failing test for missing authoritative permission source**

Add a test requiring delegation to refuse launch when authoritative permission resolution is unavailable.

Expected behavior:

- tool execution rejects or returns a clear failure
- runtime start is not called

**Step 3: Run focused tests to confirm RED**

Run: `npm test -- test/delegation-tools.test.ts`

Expected: FAIL because the plugin still trusts `context.permissions` as authority.

### Task 2: Implement authoritative permission resolution plumbing

**Files:**
- Modify: `src/core/delegation-launch-context.ts`
- Modify: `src/plugin.ts`
- Modify: `test/helpers/delegation-plugin-fixture.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Introduce an explicit authoritative permission resolver seam**

Add a focused resolver path that returns the effective permission input used for delegated capability derivation.

Keep the interface minimal. It should provide:

- authoritative permission input
- active agent key if needed for grant identity
- runtime cwd / workspace root as already supported

**Step 2: Demote `context.permissions` from authority to fallback diagnostics only**

Keep it available for mismatch comparison if useful, but do not use it to decide delegated permissions.

**Step 3: Fail closed when authoritative resolution is unavailable**

Return a clear user-facing failure and do not call runtime start.

**Step 4: Run focused tests to confirm GREEN**

Run: `npm test -- test/delegation-tools.test.ts`

Expected: PASS

### Task 3: Add RED tests for mismatch diagnostics and preserved grant behavior

**Files:**
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/delegation-permissions.test.ts`

**Step 1: Add a failing test for mismatch handling**

Drive one case where authoritative permissions disagree with `context.permissions`, and assert that authoritative permissions win.

If mismatch metadata is stored or surfaced, assert the chosen mechanism. If not, assert only the effective delegated behavior.

**Step 2: Add a failing regression test that `allow-session` persistence still works under the new authority source**

Required case:

- authoritative source yields `workspaceWrite=ask`
- user chooses `allow-session`
- second launch with same authority and same identity skips the prompt

This should confirm the patch does not duplicate or break the existing persisted grant logic.

**Step 3: Run focused tests to confirm RED**

Run: `npm test -- test/delegation-tools.test.ts test/delegation-permissions.test.ts`

Expected: FAIL until the new authority path is fully wired.

### Task 4: Implement preserved downstream behavior on top of the new authority source

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/core/delegation-launch-context.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/delegation-permissions.test.ts`

**Step 1: Keep the existing downstream pipeline intact**

After authoritative permission resolution succeeds, continue to use the existing path for:

- delegated capability derivation
- permission fingerprinting
- persisted session grant reuse
- grouped `ask` prompting
- backend policy mapping

**Step 2: Ensure the effective post-approval capability envelope is still what downstream launch mapping uses**

Do not regress the existing Claude/Codex policy wiring.

**Step 3: Run focused tests to confirm GREEN**

Run: `npm test -- test/delegation-tools.test.ts test/delegation-permissions.test.ts`

Expected: PASS

### Task 5: Add integration coverage for read-only vs write-enabled authority envelopes

**Files:**
- Modify: `test/claude-adapter.test.ts`
- Modify: `test/codex-adapter.test.ts`
- Modify: `test/completion-reporting.test.ts` only if authority-driven approval mode expectations need explicit fixture updates

**Step 1: Add or update tests proving authority-driven envelopes flow through provider mapping**

Required cases:

- authoritative read-only envelope -> Claude read-only tools, Codex read-only sandbox
- authoritative write/shell envelope -> Claude write/shell tools, Codex workspace-write where appropriate

Prefer reusing existing fixture seams rather than inventing new mapping layers.

**Step 2: Run focused provider tests**

Run: `npm test -- test/claude-adapter.test.ts test/codex-adapter.test.ts test/completion-reporting.test.ts`

Expected: PASS

### Task 6: Run full verification and build

**Files:**
- Test: `test/delegation-tools.test.ts`
- Test: `test/delegation-permissions.test.ts`
- Test: `test/claude-adapter.test.ts`
- Test: `test/codex-adapter.test.ts`
- Test: any additional permission/delegation tests touched during implementation

**Step 1: Run the focused verification set**

Run: `npm test -- test/delegation-tools.test.ts test/delegation-permissions.test.ts test/claude-adapter.test.ts test/codex-adapter.test.ts test/completion-reporting.test.ts`

Expected: PASS

**Step 2: Run the full suite**

Run: `npm test -- --runInBand`

Expected: PASS

**Step 3: Run the build**

Run: `npm run build`

Expected: PASS

**Step 4: Commit**

```bash
git add src/core/delegation-launch-context.ts src/plugin.ts test/helpers/delegation-plugin-fixture.ts test/delegation-tools.test.ts test/delegation-permissions.test.ts test/claude-adapter.test.ts test/codex-adapter.test.ts test/completion-reporting.test.ts docs/plans/2026-04-11-omni-opencode-authoritative-delegation-permissions-design.md docs/plans/2026-04-11-omni-opencode-authoritative-delegation-permissions.md
git commit -m "fix: require authoritative opencode permissions for delegation"
```
