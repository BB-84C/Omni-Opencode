# Omni-Opencode Shared Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-job monitor surfaces with one shared interactive monitor workspace per parent OpenCode session while preserving tool-driven delegation and batch-based aggregate resume behavior.

**Architecture:** Introduce a `MonitorSession` layer keyed by parent session ID. Windows uses a plugin-owned multiplexer host process that manages multiple `node-pty` children in one visible terminal UI; Linux/macOS use one shared `tmux` session per parent session. Delegated jobs still complete per `batchId`, but monitor attach becomes stable per parent session.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, node-pty, tmux, PowerShell.

---

### Task 1: Define Shared Monitor Session Behavior In Tests

**Files:**
- Create: `test/shared-monitor-session.test.ts`
- Modify: `test/delegation-tools.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- two delegated jobs launched from the same parent OpenCode session share one `monitorSessionId`
- Windows attach command is session-scoped, not job-scoped
- later delegated jobs in the same parent session reuse the same attach command

**Step 2: Run test to verify it fails**

Run: `npm test -- test/shared-monitor-session.test.ts test/delegation-tools.test.ts`
Expected: FAIL because monitor state is currently per job.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run focused tests**

Run: `npm test -- test/shared-monitor-session.test.ts test/delegation-tools.test.ts`
Expected: still FAIL, but for the intended missing monitor-session behavior.

**Step 5: Commit**

```bash
git add test/shared-monitor-session.test.ts test/delegation-tools.test.ts
git commit -m "test: define shared monitor session behavior"
```

### Task 2: Extend Runtime And Job Models With Monitor Session Identity

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/core/jobs.ts`
- Modify: `src/core/store.ts`
- Modify: `test/store.test.ts`

**Step 1: Write the failing test**

Add coverage for persisted monitor-session fields such as:
- `monitorSessionId`
- session-scoped attach command persistence
- stable monitor target per parent session

**Step 2: Run test to verify it fails**

Run: `npm test -- test/store.test.ts test/shared-monitor-session.test.ts`
Expected: FAIL because the persisted model has no shared monitor-session semantics.

**Step 3: Write minimal implementation**

Add persisted fields needed for shared monitor sessions to the runtime/job model and store.

**Step 4: Run focused tests**

Run: `npm test -- test/store.test.ts test/shared-monitor-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/types.ts src/core/jobs.ts src/core/store.ts test/store.test.ts test/shared-monitor-session.test.ts
git commit -m "feat: persist shared monitor session identity"
```

### Task 3: Refactor Linux/macOS Runtime To One Shared `tmux` Session Per Parent Session

**Files:**
- Modify: `src/runtime/tmux-runtime.ts`
- Modify: `test/tmux-runtime.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- one parent session produces one shared `tmux` session
- later jobs in that parent session add panes/windows to the same session
- all jobs in that parent session return the same `tmux attach` command

**Step 2: Run test to verify it fails**

Run: `npm test -- test/tmux-runtime.test.ts`
Expected: FAIL because `tmux` runtime currently creates one session per job.

**Step 3: Write minimal implementation**

Refactor the `tmux` runtime so session names are derived from parent OpenCode session ID and reused across jobs.

**Step 4: Run focused test**

Run: `npm test -- test/tmux-runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/tmux-runtime.ts test/tmux-runtime.test.ts
git commit -m "feat: share tmux monitor sessions per parent session"
```

### Task 4: Add Windows Shared Multiplexer Attach Contract Tests

**Files:**
- Modify: `test/windows-pty.test.ts`
- Create: `test/windows-multiplexer.test.ts`

**Step 1: Write the failing test**

Add tests proving:
- Windows attach command is exactly:
  - `node "D:\\Omni-Opencode\\dist\\runtime\\windows-multiplexer.js" attach --session "<parentSessionId>"`
- the first delegated job auto-opens the shared monitor host
- later delegated jobs in the same parent session reuse that host and do not spawn a separate monitor window

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts`
Expected: FAIL because Windows still uses a per-job monitor model.

**Step 3: Write minimal implementation**

Do not add production code yet.

**Step 4: Re-run focused tests**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts`
Expected: still FAIL, but for the intended missing multiplexer behavior.

**Step 5: Commit**

```bash
git add test/windows-pty.test.ts test/windows-multiplexer.test.ts
git commit -m "test: define windows shared multiplexer contract"
```

### Task 5: Implement Windows Multiplexer Host And Shared Session Runtime

**Files:**
- Create: `src/runtime/windows-multiplexer.ts`
- Create: `src/runtime/windows-multiplexer-host.ts`
- Modify: `src/runtime/windows-pty.ts`
- Modify: `src/runtime/select-runtime.ts`
- Modify: `test/windows-pty.test.ts`
- Modify: `test/windows-multiplexer.test.ts`

**Step 1: Write the failing test**

Add coverage for:
- creating one monitor host per parent session
- adding multiple delegated jobs into that host
- reusing the stable attach command per parent session
- reporting auto-open failure when the host/window could not be created

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts`
Expected: FAIL because there is no shared Windows multiplexer host.

**Step 3: Write minimal implementation**

Implement a shared Windows monitor host layer that:
- creates one host per parent session
- launches one PTY child per delegated job
- returns the stable session-scoped attach command
- reuses the same host for later jobs in the same parent session

**Step 4: Run focused tests**

Run: `npm test -- test/windows-pty.test.ts test/windows-multiplexer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-multiplexer.ts src/runtime/windows-multiplexer-host.ts src/runtime/windows-pty.ts src/runtime/select-runtime.ts test/windows-pty.test.ts test/windows-multiplexer.test.ts
git commit -m "feat: add shared windows multiplexer monitor"
```

### Task 6: Refactor Plugin Launch Flow To Reuse Shared Monitor Sessions

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/job-controls.test.ts`

**Step 1: Write the failing test**

Add assertions that:
- tool launch payload includes `monitorSessionId`
- all jobs in the same parent OpenCode session return the same attach command
- the first launch auto-opens the shared monitor session
- later launches in the same session do not claim a second separate monitor window was created

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts test/shared-monitor-session.test.ts`
Expected: FAIL because plugin launch is still job-scoped.

**Step 3: Write minimal implementation**

Refactor launch bookkeeping so the plugin resolves `MonitorSession` by parent session ID and returns session-scoped monitor metadata.

**Step 4: Run focused tests**

Run: `npm test -- test/delegation-tools.test.ts test/job-controls.test.ts test/shared-monitor-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/delegation-tools.test.ts test/job-controls.test.ts test/shared-monitor-session.test.ts
git commit -m "feat: reuse shared monitor sessions in launch flow"
```

### Task 7: Preserve Batch Resume While Switching To Shared Monitor Sessions

**Files:**
- Modify: `src/plugin.ts`
- Modify: `test/batch-resume.test.ts`
- Modify: `test/completion-reporting.test.ts`

**Step 1: Write the failing test**

Add assertions that:
- batch completion still groups by parent turn, not monitor session
- aggregate follow-up includes per-job summaries plus the shared attach command
- the resumed assistant still wakes only after the full batch is terminal

**Step 2: Run test to verify it fails**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: FAIL because completion reporting still assumes per-job monitor metadata in key places.

**Step 3: Write minimal implementation**

Adjust batch reporting to keep batch semantics unchanged while pointing users at the shared monitor session attach command.

**Step 4: Run focused tests**

Run: `npm test -- test/batch-resume.test.ts test/completion-reporting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin.ts test/batch-resume.test.ts test/completion-reporting.test.ts
git commit -m "feat: keep batch resume with shared monitor sessions"
```

### Task 8: Add Same-Session Multi-Agent End-To-End Coverage

**Files:**
- Modify: `test/e2e/monitor-flow.test.ts`
- Modify: `test/e2e/delegation-flow.test.ts`
- Create: `test/e2e/shared-monitor-flow.test.ts`

**Step 1: Write the failing test**

Add end-to-end coverage proving:
- Codex and Claude launched from the same parent OpenCode session reuse one shared monitor session
- both tool calls return the same attach command
- Windows multiplexer or shared `tmux` session is reused rather than reopened per job
- aggregate follow-up still arrives once after the batch finishes

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/monitor-flow.test.ts test/e2e/delegation-flow.test.ts test/e2e/shared-monitor-flow.test.ts`
Expected: FAIL because the current e2e model is still per-job monitor oriented.

**Step 3: Write minimal implementation**

Update runtime fakes/mocks and end-to-end glue to reflect shared monitor sessions.

**Step 4: Run focused tests**

Run: `npm test -- test/e2e/monitor-flow.test.ts test/e2e/delegation-flow.test.ts test/e2e/shared-monitor-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e/monitor-flow.test.ts test/e2e/delegation-flow.test.ts test/e2e/shared-monitor-flow.test.ts
git commit -m "test: cover shared monitor session flow"
```

### Task 9: Update Documentation And Live Verification Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-06-omni-opencode-shared-monitor-design.md`

**Step 1: Write the failing doc check**

List the required documentation updates:
- one shared monitor per parent OpenCode session
- Windows attach command contract
- Linux/macOS shared `tmux` contract
- first-launch auto-open plus later-launch reuse
- live verification expectations

**Step 2: Run doc grep to verify current mismatch**

Run: `grep -n "monitorSessionId\|windows-multiplexer\|tmux attach -t omni-\|shared monitor" README.md docs/plans/2026-04-06-omni-opencode-shared-monitor-design.md`
Expected: incomplete or missing references before doc updates.

**Step 3: Write minimal implementation**

Update documentation to match the shared monitor architecture and attach contract.

**Step 4: Re-run doc grep**

Run: `grep -n "monitorSessionId\|windows-multiplexer\|tmux attach -t omni-\|shared monitor" README.md docs/plans/2026-04-06-omni-opencode-shared-monitor-design.md`
Expected: PASS with all required references present.

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-04-06-omni-opencode-shared-monitor-design.md
git commit -m "docs: describe shared monitor session architecture"
```

### Task 10: Live Verification Against Real OpenCode Sessions

**Files:**
- Modify: `docs/plans/2026-04-06-omni-opencode-shared-monitor-implementation.md`

**Step 1: Run Windows live verification**

Prove in a fresh live OpenCode session that:
- Codex launch returns the shared Windows attach command
- Claude launch in the same parent session returns the same attach command
- one shared multiplexer window is reused
- the visible window is attached to real Codex/Claude CLIs rather than broker-log playback
- focused input reaches the selected delegated CLI

**Step 2: Run Linux/macOS live verification**

Prove in a fresh live session that:
- one shared `tmux` session is reused for multiple delegated jobs in the same parent session
- attach command remains stable across jobs

**Step 3: Run full automated verification**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 4: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add docs/plans/2026-04-06-omni-opencode-shared-monitor-implementation.md
git commit -m "test: verify shared monitor sessions live"
```
