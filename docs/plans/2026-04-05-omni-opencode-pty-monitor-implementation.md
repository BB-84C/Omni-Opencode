# Omni-Opencode PTY Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current child-session-stream architecture with a plugin-only PTY/tmux-backed external-agent system that launches Codex and Claude Code through parent-facing delegation tools, provides true live terminal monitoring, and posts completion reports back into the parent OpenCode session.

**Architecture:** OpenCode remains the control plane while a broker runtime owns external jobs, terminal sessions, transcript capture, and completion reporting. Windows uses `node-pty`/ConPTY; Linux and macOS use `tmux`. The plugin stops trying to mirror external execution as native assistant-role session events and instead uses OpenCode for orchestration, snapshots, and final updates.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, node-pty, tmux, Codex CLI/app-server, Claude Code CLI/SDK.

---

### Task 1: Freeze The Old Session-Streaming Path With Failing Regression Tests

**Files:**
- Modify: `test/e2e/delegation-flow.test.ts`
- Create: `test/e2e/pty-architecture-regression.test.ts`

**Step 1: Write the failing test**

Add regression tests that assert the new design target:

- parent-facing delegation uses plugin tools again
- no wrapper bridge child session is required for core monitoring
- broker jobs are keyed by parent session ID plus job ID
- completion is reported back into the parent session

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/pty-architecture-regression.test.ts`
Expected: FAIL because current code still assumes wrapper bridge subagents.

**Step 3: Write minimal implementation**

No production implementation yet. Only add the failing regression test.

**Step 4: Run test to verify it fails cleanly**

Run: `npm test -- test/e2e/pty-architecture-regression.test.ts`
Expected: FAIL with clear assertion mismatch.

**Step 5: Commit**

```bash
git add test/e2e/delegation-flow.test.ts test/e2e/pty-architecture-regression.test.ts
git commit -m "test: define pty monitor architecture regression cases"
```

### Task 2: Introduce Runtime-Abstraction For PTY And Tmux

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/fake-runtime.ts`
- Create: `test/runtime.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { createFakeRuntime } from "../src/runtime/fake-runtime"

describe("runtime abstraction", () => {
  it("starts a monitored job and exposes attach metadata", async () => {
    const runtime = createFakeRuntime()
    const job = await runtime.start({ backend: "claude-code", command: "claude -p hello" })
    expect(job.attachCommand).toBeTruthy()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/runtime.test.ts`
Expected: FAIL because runtime abstraction does not exist.

**Step 3: Write minimal implementation**

Define a shared runtime contract, for example:

```ts
start()
read()
stop()
snapshot()
openMonitor()
```

Implement a fake runtime for tests.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/fake-runtime.ts test/runtime.test.ts
git commit -m "feat: add terminal runtime abstraction"
```

### Task 3: Replace Child-Session Job Model With Parent-Session Job Model

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/core/store.ts`
- Modify: `test/store.test.ts`

**Step 1: Write the failing test**

Add coverage proving job records now include:

- `jobId`
- `parentSessionId`
- `runtimeType`
- `runtimeHandle`
- `attachCommand`
- `terminalLogPath`

**Step 2: Run test to verify it fails**

Run: `npm test -- test/store.test.ts`
Expected: FAIL because current store schema is child-session oriented.

**Step 3: Write minimal implementation**

Refactor persisted job records to the new PTY/tmux architecture.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/jobs.ts src/core/store.ts test/store.test.ts
git commit -m "feat: persist terminal-backed delegated job metadata"
```

### Task 4: Add Windows PTY Runtime

**Files:**
- Create: `src/runtime/windows-pty.ts`
- Modify: `package.json`
- Create: `test/windows-pty.test.ts`

**Step 1: Write the failing test**

Add a test that verifies the Windows runtime builds launch metadata and captures incremental output through a mocked PTY client.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty.test.ts`
Expected: FAIL because Windows runtime does not exist.

**Step 3: Write minimal implementation**

Add `node-pty` dependency and implement a Windows runtime wrapper that:

- starts a ConPTY-backed shell/session
- launches the external command
- records attach/monitor metadata
- captures output into transcript buffers

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-pty.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json src/runtime/windows-pty.ts test/windows-pty.test.ts
git commit -m "feat: add windows pty runtime"
```

### Task 5: Add Tmux Runtime For Linux And macOS

**Files:**
- Create: `src/runtime/tmux-runtime.ts`
- Create: `test/tmux-runtime.test.ts`

**Step 1: Write the failing test**

Add a test proving tmux session names and attach commands are produced correctly from a mocked tmux backend.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/tmux-runtime.test.ts`
Expected: FAIL because tmux runtime does not exist.

**Step 3: Write minimal implementation**

Implement tmux-backed runtime support with:

- named sessions
- attach commands
- output capture strategy
- cleanup strategy

**Step 4: Run test to verify it passes**

Run: `npm test -- test/tmux-runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/tmux-runtime.ts test/tmux-runtime.test.ts
git commit -m "feat: add tmux runtime"
```

### Task 6: Add Runtime Selection And Auto-Open Monitor Support

**Files:**
- Create: `src/runtime/select-runtime.ts`
- Modify: `src/plugin.ts`
- Create: `test/runtime-selection.test.ts`

**Step 1: Write the failing test**

Add tests for:

- Windows selects PTY runtime
- Linux/macOS select tmux runtime
- auto-open default behavior is enabled
- attach command is always returned

**Step 2: Run test to verify it fails**

Run: `npm test -- test/runtime-selection.test.ts`
Expected: FAIL because runtime selection is not wired.

**Step 3: Write minimal implementation**

Implement runtime selection and auto-open monitor handling.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/runtime-selection.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/select-runtime.ts src/plugin.ts test/runtime-selection.test.ts
git commit -m "feat: select runtime and auto-open monitors"
```

### Task 7: Reintroduce Parent-Facing Delegation Tools As Primary UX

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/plugin-session-manager.test.ts`
- Create: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- `delegate_to_claude` and `delegate_to_codex` exist again
- they key jobs on parent session ID
- they return monitor metadata immediately
- they do not create wrapper child sessions as the primary execution path

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: FAIL because plugin still uses bridge-agent architecture.

**Step 3: Write minimal implementation**

Refactor plugin entrypoint so parent-facing delegation tools become the primary launch path again.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/plugin-session-manager.test.ts test/delegation-tools.test.ts
git commit -m "feat: restore tool-driven delegation ux"
```

### Task 8: Capture Runtime Transcript And Extract Final Reports

**Files:**
- Create: `src/runtime/transcript.ts`
- Create: `src/runtime/extract-report.ts`
- Create: `test/transcript.test.ts`

**Step 1: Write the failing test**

Add tests proving transcript capture stores chunks and summary extraction prefers structured output when available, otherwise falls back to conservative parsing.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/transcript.test.ts`
Expected: FAIL because transcript extraction logic does not exist.

**Step 3: Write minimal implementation**

Implement transcript capture and final report extraction helpers.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/transcript.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/transcript.ts src/runtime/extract-report.ts test/transcript.test.ts
git commit -m "feat: capture runtime transcripts and extract reports"
```

### Task 9: Post Completion Updates Back Into Parent Sessions

**Files:**
- Modify: `src/plugin.ts`
- Create: `test/completion-reporting.test.ts`

**Step 1: Write the failing test**

Add tests proving that when an external runtime completes, the plugin posts a new parent-session update containing:

- backend
- job ID
- completion status
- short summary
- full report availability

**Step 2: Run test to verify it fails**

Run: `npm test -- test/completion-reporting.test.ts`
Expected: FAIL because completion updates are not parent-session oriented yet.

**Step 3: Write minimal implementation**

Implement parent-session completion reporting using the supported plugin session write path.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/completion-reporting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/completion-reporting.test.ts
git commit -m "feat: report delegated completion into parent session"
```

### Task 10: Add Attach, Read, Snapshot, And Cleanup Controls

**Files:**
- Modify: `src/plugin.ts`
- Create: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add tests for tools such as:

- `delegated_jobs_list`
- `delegated_job_snapshot`
- `delegated_job_read`
- `delegated_job_attach`
- `delegated_job_cancel`

and verify cleanup metadata is tracked.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/job-controls.test.ts`
Expected: FAIL because the new control surface does not exist yet.

**Step 3: Write minimal implementation**

Add or refactor control tools around the PTY/tmux-backed job model.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/job-controls.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/job-controls.test.ts
git commit -m "feat: add delegated monitor and transcript controls"
```

### Task 11: Retire Wrapper-Bridge Session-Streaming Architecture

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/e2e/delegation-flow.test.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

Add assertions that:

- wrapper bridge subagents are no longer required for the main path
- plugin no longer depends on `session.idle` or same-session projection to stream external runtime updates

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/delegation-flow.test.ts`
Expected: FAIL because old assumptions are still present.

**Step 3: Write minimal implementation**

Remove obsolete wrapper-agent/session-projection code from the primary path and document the new PTY/tmux model in `README.md`.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/e2e/delegation-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/e2e/delegation-flow.test.ts README.md
git commit -m "refactor: replace wrapper session streaming with terminal monitor model"
```

### Task 12: End-To-End Validation On Both Backends

**Files:**
- Create: `test/e2e/monitor-flow.test.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

Add an end-to-end test proving:

- parent launches Claude and Codex jobs through delegation tools
- each job returns attach metadata immediately
- transcript/log capture advances
- completion updates are posted to parent session
- cleanup metadata is correct

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/monitor-flow.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Implement remaining glue and document real-world usage, monitor behavior, and Windows Warp expectations.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e/monitor-flow.test.ts README.md
git commit -m "test: validate pty monitor delegation workflow"
```

## Manual Verification Checklist

Run these after implementation completes:

1. `npm test -- --runInBand`
2. Launch OpenCode in Windows Warp.
3. Delegate one Claude job and one Codex job.
4. Confirm each delegation tool returns monitor metadata immediately.
5. Confirm the monitor auto-opens by default.
6. Confirm manual attach still works.
7. Watch real live progress in the PTY/tmux monitor.
8. Confirm the parent OpenCode session later receives completion updates for each job.
9. Confirm auto-close happens when enabled.
10. Confirm transcript logs remain available for inspection after job completion.

## Notes For The Implementing Agent

- Do not keep chasing assistant-role child-session streaming; that is no longer the architecture.
- Use PTY/tmux runtime capture as the operational source of truth.
- Keep parent-session updates concise by default.
- Ensure transcript ownership stays in the broker so summary fallback remains possible.
- Treat Warp on Windows as compatible with `node-pty`/ConPTY, but do not assume you can embed into the existing Warp pane.
