# Omni-Opencode External Subagents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an OpenCode plugin that delegates work to Codex and Claude Code as child-session-backed external subagents with rich streamed progress, interrupt/resume support, and full workspace edit/command capability.

**Architecture:** OpenCode owns sessions and UI, while a plugin-managed broker owns backend runtime state. Codex and Claude Code are integrated through backend adapters that normalize provider-specific streams into a single canonical delegated-event model which the plugin projects into OpenCode child sessions.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, OpenCode SDK/server APIs, Vitest, Codex app-server, Anthropic Agent SDK.

---

### Task 1: Bootstrap The Repository

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `test/smoke.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"

describe("repo bootstrap", () => {
  it("loads the plugin entry module", async () => {
    const mod = await import("../src/index")
    expect(mod).toBeTruthy()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand`
Expected: FAIL because `src/index.ts` or test tooling does not exist yet.

**Step 3: Write minimal implementation**

```ts
export const pluginName = "omni-opencode"
```

Create minimal npm, TS, and Vitest config so tests can run.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/index.ts test/smoke.test.ts
git commit -m "chore: bootstrap omni-opencode plugin repo"
```

### Task 2: Define Canonical Delegated Event Types

**Files:**
- Create: `src/core/events.ts`
- Create: `test/events.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { delegatedEventSchema } from "../src/core/events"

describe("delegated event schema", () => {
  it("accepts assistant deltas", () => {
    const result = delegatedEventSchema.safeParse({
      type: "assistant.delta",
      sessionId: "child-1",
      text: "running tests",
    })
    expect(result.success).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/events.test.ts`
Expected: FAIL because `delegatedEventSchema` is not defined.

**Step 3: Write minimal implementation**

```ts
import { z } from "zod"

export const delegatedEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assistant.delta"), sessionId: z.string(), text: z.string() }),
])
```

Then expand to cover all approved canonical event types.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/events.ts test/events.test.ts
git commit -m "feat: define canonical delegated event model"
```

### Task 3: Add Broker Job State And Persistence

**Files:**
- Create: `src/core/jobs.ts`
- Create: `src/core/store.ts`
- Create: `test/store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { createJobStore } from "../src/core/store"

describe("job store", () => {
  it("persists child-session to backend mapping", async () => {
    const store = createJobStore()
    await store.save({ childSessionId: "child-1", backend: "codex", status: "running" })
    const job = await store.get("child-1")
    expect(job?.backend).toBe("codex")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/store.test.ts`
Expected: FAIL because the job store does not exist.

**Step 3: Write minimal implementation**

```ts
export type JobRecord = {
  childSessionId: string
  backend: "codex" | "claude-code"
  status: "running" | "interrupted" | "completed" | "failed"
}
```

Implement file-backed persistence under a plugin-owned state directory.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/jobs.ts src/core/store.ts test/store.test.ts
git commit -m "feat: persist delegated job state"
```

### Task 4: Define The Backend Adapter Interface

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/fake-adapter.ts`
- Create: `test/fake-adapter.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { createFakeAdapter } from "../src/adapters/fake-adapter"

describe("fake adapter", () => {
  it("streams canonical events", async () => {
    const adapter = createFakeAdapter()
    const job = await adapter.startJob({ childSessionId: "child-1", prompt: "fix bug" })
    const events = []
    for await (const event of adapter.subscribeEvents(job.id)) {
      events.push(event.type)
    }
    expect(events).toContain("result.final")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/fake-adapter.test.ts`
Expected: FAIL because adapter contracts are missing.

**Step 3: Write minimal implementation**

Create the shared adapter contract with:

```ts
startJob()
resumeJob()
cancelJob()
subscribeEvents()
getSnapshot()
```

Implement a fake adapter that emits deterministic events for end-to-end testing.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/fake-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/types.ts src/adapters/fake-adapter.ts test/fake-adapter.test.ts
git commit -m "feat: add backend adapter contract"
```

### Task 5: Implement The Child-Session Projection Layer

**Files:**
- Create: `src/opencode/projection.ts`
- Create: `src/opencode/render.ts`
- Create: `test/projection.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { projectEvent } from "../src/opencode/projection"

describe("projection", () => {
  it("coalesces assistant deltas into readable child-session updates", () => {
    const result = projectEvent({ type: "assistant.delta", sessionId: "child-1", text: "hello" })
    expect(result.kind).toBe("message")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/projection.test.ts`
Expected: FAIL because the projection layer is missing.

**Step 3: Write minimal implementation**

Implement projection helpers that map canonical events into OpenCode child-session-friendly message payloads and chunking rules.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/projection.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/opencode/projection.ts src/opencode/render.ts test/projection.test.ts
git commit -m "feat: project delegated events into child sessions"
```

### Task 6: Implement The Plugin Control Plane

**Files:**
- Modify: `src/index.ts`
- Create: `src/plugin/session-manager.ts`
- Create: `src/plugin/tools.ts`
- Create: `test/plugin-session-manager.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest"
import { createSessionManager } from "../src/plugin/session-manager"

describe("session manager", () => {
  it("creates a child session for delegated work", async () => {
    const client = { session: { create: vi.fn().mockResolvedValue({ data: { id: "child-1" } }) } }
    const manager = createSessionManager(client as never)
    const childId = await manager.createDelegatedChild({ parentSessionId: "parent-1", title: "Codex Task" })
    expect(childId).toBe("child-1")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/plugin-session-manager.test.ts`
Expected: FAIL because the manager does not exist.

**Step 3: Write minimal implementation**

Implement plugin wiring that can:

- create child sessions
- attach metadata
- invoke broker jobs
- expose inspect/resume/cancel surfaces

**Step 4: Run test to verify it passes**

Run: `npm test -- test/plugin-session-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/plugin/session-manager.ts src/plugin/tools.ts test/plugin-session-manager.test.ts
git commit -m "feat: add plugin session orchestration"
```

### Task 7: Integrate Codex Through App Server

**Files:**
- Create: `src/adapters/codex-adapter.ts`
- Create: `src/adapters/codex-client.ts`
- Create: `test/codex-adapter.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { mapCodexEvent } from "../src/adapters/codex-adapter"

describe("codex adapter", () => {
  it("maps codex lifecycle events into canonical events", () => {
    const event = mapCodexEvent({ method: "turn/started", params: { threadId: "t1" } })
    expect(event.type).toBe("status.update")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/codex-adapter.test.ts`
Expected: FAIL because the Codex adapter does not exist.

**Step 3: Write minimal implementation**

Implement a Codex adapter that:

- starts or reuses `codex app-server`
- starts jobs/threads
- subscribes to notifications
- maps them into canonical delegated events
- supports interrupt and resume

**Step 4: Run test to verify it passes**

Run: `npm test -- test/codex-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/codex-adapter.ts src/adapters/codex-client.ts test/codex-adapter.test.ts
git commit -m "feat: integrate codex app-server adapter"
```

### Task 8: Integrate Claude Code Through Agent SDK

**Files:**
- Create: `src/adapters/claude-adapter.ts`
- Create: `src/adapters/claude-client.ts`
- Create: `test/claude-adapter.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { mapClaudeMessage } from "../src/adapters/claude-adapter"

describe("claude adapter", () => {
  it("maps sdk text messages into assistant deltas", () => {
    const event = mapClaudeMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
    expect(event.type).toBe("assistant.delta")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/claude-adapter.test.ts`
Expected: FAIL because the Claude adapter does not exist.

**Step 3: Write minimal implementation**

Implement a Claude Code adapter that:

- uses the Anthropic Agent SDK as the primary transport
- normalizes streamed SDK messages
- supports interrupt and resume snapshots
- falls back to CLI stream-json only if needed

**Step 4: Run test to verify it passes**

Run: `npm test -- test/claude-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/claude-adapter.ts src/adapters/claude-client.ts test/claude-adapter.test.ts
git commit -m "feat: integrate claude code adapter"
```

### Task 9: Add Interrupt, Inspect, Resume, And Cancel

**Files:**
- Create: `src/plugin/resume.ts`
- Modify: `src/plugin/tools.ts`
- Create: `test/resume.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { buildInterruptCheckpoint } from "../src/plugin/resume"

describe("interrupt checkpoints", () => {
  it("captures resumable state for a child session", () => {
    const checkpoint = buildInterruptCheckpoint({
      childSessionId: "child-1",
      status: "interrupted",
      changedFiles: ["src/index.ts"],
    })
    expect(checkpoint.status).toBe("interrupted")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/resume.test.ts`
Expected: FAIL because interrupt/resume helpers do not exist.

**Step 3: Write minimal implementation**

Implement plugin surfaces for:

- delegated job snapshot
- delegated job cancel
- delegated job resume
- interrupt checkpoint writing into child sessions

**Step 4: Run test to verify it passes**

Run: `npm test -- test/resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin/resume.ts src/plugin/tools.ts test/resume.test.ts
git commit -m "feat: add delegated job interrupt and resume controls"
```

### Task 10: Add Permission Translation And Enforcement

**Files:**
- Create: `src/core/policy.ts`
- Create: `src/adapters/policy-mappers.ts`
- Create: `test/policy.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { buildDelegationPolicy } from "../src/core/policy"

describe("delegation policy", () => {
  it("blocks writes outside the project root", () => {
    const policy = buildDelegationPolicy({ allowEdits: true, projectRoot: "/repo" })
    expect(policy.allowsPath("/other/file.ts")).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/policy.test.ts`
Expected: FAIL because policy logic does not exist.

**Step 3: Write minimal implementation**

Implement OpenCode-facing delegation policy and backend-specific mapper helpers.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/policy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/policy.ts src/adapters/policy-mappers.ts test/policy.test.ts
git commit -m "feat: enforce delegation policy across backends"
```

### Task 11: Add Restart Recovery

**Files:**
- Create: `src/plugin/recovery.ts`
- Modify: `src/index.ts`
- Create: `test/recovery.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { recoverJobs } from "../src/plugin/recovery"

describe("recovery", () => {
  it("reconnects or marks interrupted jobs after restart", async () => {
    const result = await recoverJobs()
    expect(Array.isArray(result)).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/recovery.test.ts`
Expected: FAIL because recovery logic is missing.

**Step 3: Write minimal implementation**

Implement plugin startup recovery that rehydrates broker state and reconnects or records recovery notes in child sessions.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/recovery.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugin/recovery.ts src/index.ts test/recovery.test.ts
git commit -m "feat: recover delegated jobs on restart"
```

### Task 12: Run End-To-End Validation

**Files:**
- Create: `test/e2e/delegation-flow.test.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"

describe("delegation flow", () => {
  it("creates a child session, streams progress, interrupts, resumes, and completes", async () => {
    expect(false).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/delegation-flow.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Replace the placeholder with a realistic end-to-end test using the fake adapter and mocked OpenCode SDK client, then document setup, backend requirements, and manual verification commands in `README.md`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand`
Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e/delegation-flow.test.ts README.md
git commit -m "test: validate delegated child-session workflow"
```

## Manual Verification Checklist

Run these after the implementation is complete:

1. `npm test -- --runInBand`
2. Start OpenCode with the plugin enabled and create a delegated Codex child session.
3. Confirm the parent session stays compact and the child session shows detailed progress.
4. Interrupt the child session mid-command.
5. Ask the parent session to inspect the child session status.
6. Resume the child job and verify it continues from stored checkpoints.
7. Repeat the same flow with Claude Code.
8. Restart OpenCode during a running delegated job and verify recovery behavior.

## Notes For The Implementing Agent

- Keep the broker/backend boundary clean.
- Do not leak raw provider event contracts into the plugin UI model.
- Favor deterministic fake-adapter tests before integrating live backends.
- Use OpenCode session APIs instead of relying on internal database details.
- Treat plugin-owned persistence as the source of truth for external backend reconciliation.
