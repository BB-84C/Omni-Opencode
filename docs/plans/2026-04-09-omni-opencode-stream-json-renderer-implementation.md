# Omni-Opencode Stream-JSON Renderer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace delegated interactive-TUI orchestration with structured backend event streams, human-friendly `psmux` renderers, and plugin-managed permission profiles with session-scoped approval memory.

**Architecture:** Delegated Codex and Claude jobs run through structured streaming commands instead of fragile interactive pane automation. Each job window hosts a renderer process that converts backend stream events into readable colored terminal output with Markdown support. The dashboard consumes the same structured lifecycle data to show truthful running/completed/error states, and plugin-owned session state stores dangerous-permission approvals for the parent session.

**Tech Stack:** TypeScript, Node.js, Vitest, Windows `psmux`, Codex CLI, Claude Code CLI, ANSI terminal rendering.

---

### Task 1: Define Permission Profiles And Session Approval State

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/plugin.ts`
- Create or modify: approval/session-state helpers under `src/core/`
- Test: `test/delegation-tools.test.ts`
- Test: `test/completion-reporting.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- delegated jobs are assigned a permission profile by task class
- safe delegations do not prompt the user
- dangerous delegations require an approval decision
- session-scoped approval choices are stored per parent OpenCode session

Use one-time and session-wide approval cases.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts`
Expected: FAIL because permission profiles and stored approval state do not exist yet.

**Step 3: Write minimal implementation**

Add the smallest permission-profile model and plugin-owned parent-session approval state needed to satisfy the tests.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core src/plugin.ts test/delegation-tools.test.ts test/completion-reporting.test.ts
git commit -m "feat: add session-scoped delegation approval profiles"
```

### Task 2: Add Structured Stream Contracts For Codex And Claude

**Files:**
- Create: `src/runtime/delegation-stream-types.ts`
- Create: `src/runtime/codex-stream-parser.ts`
- Create: `src/runtime/claude-stream-parser.ts`
- Test: `test/codex-stream-parser.test.ts`
- Test: `test/claude-stream-parser.test.ts`

**Step 1: Write the failing test**

Add parser tests proving:

- Codex JSON stream lines are parsed into structured events
- Codex completion is detected from `turn.completed`
- Claude stream-json lines are parsed into structured events
- Claude completion is detected from `stop_reason: end_turn`
- malformed/partial lines are ignored safely until complete

**Step 2: Run test to verify it fails**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts`
Expected: FAIL because parser helpers do not exist yet.

**Step 3: Write minimal implementation**

Create narrow parser helpers and common event types for structured backend stream handling.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/delegation-stream-types.ts src/runtime/codex-stream-parser.ts src/runtime/claude-stream-parser.ts test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts
git commit -m "feat: add structured backend stream parsers"
```

### Task 3: Build The Human-Friendly Job Window Renderer

**Files:**
- Create: `src/runtime/delegation-renderer.ts`
- Test: `test/delegation-renderer.test.ts`

**Step 1: Write the failing test**

Add renderer tests proving:

- Markdown-like output is rendered readably (headings, bullets, code blocks, inline code)
- status lines use ANSI color/styling
- progress, warnings, errors, and final results are clearly distinguished
- renderer output is terminal-stable rather than raw JSON

**Step 2: Run test to verify it fails**

Run: `npm test -- test/delegation-renderer.test.ts`
Expected: FAIL because the renderer does not exist yet.

**Step 3: Write minimal implementation**

Create the smallest renderer that maps structured events to readable ANSI output with Markdown-aware formatting.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/delegation-renderer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/delegation-renderer.ts test/delegation-renderer.test.ts
git commit -m "feat: add delegated job stream renderer"
```

### Task 4: Switch Windows psmux Jobs To Stream-JSON Renderer Mode

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Modify: `src/runtime/types.ts`
- Test: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- Codex delegated jobs use `codex exec --json ...`
- Claude delegated jobs use `claude -p ... --output-format stream-json --verbose --include-partial-messages`
- delegated `psmux` windows host renderer-driven output, not backend TUIs
- backend completion is detected from real structured stream terminal events

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: FAIL because runtime still uses the previous interactive path.

**Step 3: Write minimal implementation**

Update `src/runtime/windows-psmux.ts` to:

- launch structured backend commands
- pipe their streams into renderer logic
- keep track of raw completion state for bookkeeping
- preserve dashboard window `0`

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-psmux.ts src/runtime/types.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: run delegated jobs through stream-json renderer mode"
```

### Task 5: Drive Dashboard Status From Real Stream Events

**Files:**
- Modify: `src/runtime/windows-dashboard-snapshot.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux-dashboard.test.ts`

**Step 1: Write the failing test**

Add tests proving dashboard status uses real backend lifecycle state for:

- active spinner/running indicator
- `-->` or equivalent phase marker
- waiting approval state
- completed / failed / cancelled statuses

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: FAIL because dashboard still uses cruder state transitions.

**Step 3: Write minimal implementation**

Update dashboard snapshot/render inputs so they derive from structured event-driven job state.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/windows-psmux-dashboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/windows-dashboard-snapshot.ts src/runtime/windows-psmux.ts test/windows-psmux-dashboard.test.ts
git commit -m "feat: drive dashboard status from backend stream events"
```

### Task 6: Live Verification And Docs Update

**Files:**
- Modify: `docs/plans/2026-04-09-omni-opencode-stream-json-renderer-design.md`
- Update earlier plan docs if needed for final state

**Step 1: Run focused verification**

Run: `npm test -- test/delegation-tools.test.ts test/completion-reporting.test.ts test/codex-stream-parser.test.ts test/claude-stream-parser.test.ts test/delegation-renderer.test.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/windows-psmux-install.test.ts test/windows-psmux-bootstrap.test.ts`
Expected: PASS

**Step 2: Build distribution**

Run: `npm run build`
Expected: PASS

**Step 3: Re-run live verification**

Prove:

- delegation creates a shared multi-window `psmux` session automatically
- dashboard is window `0`
- delegated job windows show rendered human-friendly output, not raw JSON
- dashboard spinner/status arrows reflect real backend lifecycle events
- safe jobs do not ask for approval
- dangerous jobs ask, and `allow once` / `allow for this session` behaves correctly
- session-wide approval is remembered by plugin state for the same parent OpenCode session

**Step 4: Update docs**

Record the final accepted model:

- stream-json backend execution
- renderer-driven job windows
- event-driven dashboard status
- plugin-owned session approval memory

**Step 5: Commit**

```bash
git add docs/plans/2026-04-09-omni-opencode-stream-json-renderer-design.md docs/plans
git commit -m "docs: record stream-json renderer delegation model"
```
