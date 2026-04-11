# Omni-Opencode Interactive CLI Correlation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Launch real interactive Codex and Claude CLI panes in Windows `psmux` job windows and deterministically correlate each backend session to the correct parent OpenCode session/job.

**Architecture:** Keep the shared `psmux` dashboard model, but replace delegated job-window behavior with real interactive backend CLIs plus explicit backend-session correlation metadata. Use a unique first-prompt marker per delegated job, discover/store backend session ids (`history.jsonl` for Codex, supported session controls or persisted state for Claude), and use those stored identities for later reopen/resume behavior.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`, Codex CLI, Claude Code CLI.

---

### Task 1: Lock Correlation Metadata In Plugin Tests

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/plugin.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add tests proving delegated runtime start params now carry structured launch metadata for correlation, including:

- command string for human-readable reporting
- command args or equivalent structured launch data
- first-prompt correlation marker or prompt fingerprint metadata

At minimum, the Windows `psmux` delegation tool test should fail until structured command/session-correlation launch data is passed through.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: FAIL because the plugin/runtime boundary does not yet carry the required structured correlation metadata.

**Step 3: Write minimal implementation**

Update `src/runtime/types.ts` and `src/plugin.ts` so runtime start params include the minimum structured fields needed for interactive CLI launch and later session correlation.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/types.ts src/plugin.ts test/delegation-tools.test.ts
git commit -m "test: add interactive cli launch metadata"
```

### Task 2: Add Codex Session Discovery From Local State

**Files:**
- Create: `src/runtime/codex-session-discovery.ts`
- Test: `test/codex-session-discovery.test.ts`

**Step 1: Write the failing test**

Add tests proving Codex session discovery can:

- parse `C:\Users\Administrator\.codex\history.jsonl`-style entries
- find the session created for a specific first-prompt marker
- ignore unrelated simultaneous sessions
- return stable `session_id` and associated prompt text/timestamp

Use synthetic history fixtures with multiple near-simultaneous entries.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/codex-session-discovery.test.ts`
Expected: FAIL because the discovery helper does not exist yet.

**Step 3: Write minimal implementation**

Create `src/runtime/codex-session-discovery.ts` with the smallest parser/matcher that can discover a session id from history entries by exact correlation marker.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/codex-session-discovery.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/codex-session-discovery.ts test/codex-session-discovery.test.ts
git commit -m "feat: discover codex sessions from local history"
```

### Task 3: Add Claude Session Correlation Support

**Files:**
- Create or modify: `src/runtime/claude-session-discovery.ts`
- Test: `test/claude-session-discovery.test.ts`

**Step 1: Write the failing test**

Add tests proving Claude session correlation can:

- represent a known session id when explicitly provided/returned
- preserve a stable mapping from delegated job to backend session id
- support resume/reopen data without relying on “last session” heuristics

Keep the test focused on correlation metadata, not full runtime launch behavior.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/claude-session-discovery.test.ts`
Expected: FAIL because the Claude correlation helper does not exist yet.

**Step 3: Write minimal implementation**

Create the smallest helper needed to store and normalize Claude session identity for the runtime layer.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/claude-session-discovery.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/claude-session-discovery.ts test/claude-session-discovery.test.ts
git commit -m "feat: track claude session correlation metadata"
```

### Task 4: Replace Job Windows With Real Interactive CLI Launches

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- job windows launch real interactive backend CLIs, not `exec` / `print` proxy windows
- Windows `psmux` no longer uses PowerShell wrapper scripts as the durable pane experience for delegated jobs
- window `0` remains dashboard
- windows `1..N` remain real job windows

Keep the tests behavior-focused around launch identity and monitor metadata.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: FAIL because runtime still does not implement the final interactive CLI launch/correlation behavior.

**Step 3: Write minimal implementation**

In `src/runtime/windows-psmux.ts`:

- launch real interactive `codex` / `claude` panes
- seed the first prompt with a unique correlation marker
- preserve dashboard window `0`
- store correlation metadata on the runtime job state

Do not rely on “latest session” behavior.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: launch interactive cli panes in psmux"
```

### Task 5: Persist Backend Session Identity In Stored Job Records

**Files:**
- Modify: `src/plugin.ts`
- Modify: any stored-job types under `src/core/`
- Test: `test/completion-reporting.test.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add tests proving completed/running delegated job snapshots include backend-session correlation data, such as:

- backend session id
- correlation marker or first-prompt fingerprint
- enough data to reopen/resume the backend session later

**Step 2: Run test to verify it fails**

Run: `npm test -- test/completion-reporting.test.ts test/delegation-tools.test.ts`
Expected: FAIL because stored job records do not yet persist backend-session identity.

**Step 3: Write minimal implementation**

Update stored job records and plugin persistence paths so backend-session correlation metadata survives snapshotting and completion reporting.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/completion-reporting.test.ts test/delegation-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts src/core test/completion-reporting.test.ts test/delegation-tools.test.ts
git commit -m "feat: persist backend session correlation metadata"
```

### Task 6: Live Verification For Concurrent Correlation Safety

**Files:**
- Modify: `docs/plans/2026-04-09-omni-opencode-interactive-cli-correlation-design.md`
- Update any relevant 04-07 / 04-08 plan docs if needed

**Step 1: Run focused verification**

Run: `npm test -- test/codex-session-discovery.test.ts test/claude-session-discovery.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/delegation-tools.test.ts test/completion-reporting.test.ts`
Expected: PASS

**Step 2: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 3: Re-run live OpenCode verification**

Using the working web/TDD loop, prove:

- a fresh OpenCode session delegation creates a shared multi-window `psmux` session automatically
- window `0` is the dashboard
- windows `1..N` host real interactive Codex/Claude panes
- the correct backend session id is discovered and stored per job
- multiple or near-simultaneous delegations can still be matched to the correct parent session/job through the marker + discovered session id

**Step 4: Update docs**

Record the final accepted model:

- interactive backend CLIs in job windows
- session-local dashboard in window `0`
- explicit backend-session correlation metadata
- no “latest session” heuristics

**Step 5: Commit**

```bash
git add docs/plans/2026-04-09-omni-opencode-interactive-cli-correlation-design.md docs/plans
git commit -m "docs: record interactive cli session correlation design"
```
