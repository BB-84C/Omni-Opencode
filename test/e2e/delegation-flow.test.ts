import { describe, expect, it, vi } from "vitest"
import { FakeAdapter } from "../../src/adapters/fake-adapter.js"
import { createJobStore } from "../../src/core/store.js"
import { buildDelegationPolicy } from "../../src/core/policy.js"
import { toClaudePolicy, toCodexPolicy } from "../../src/adapters/policy-mappers.js"
import { projectEvent } from "../../src/opencode/projection.js"
import { DeltaCoalescer } from "../../src/opencode/render.js"
import { createSessionManager } from "../../src/plugin/session-manager.js"
import { delegatedJobResume } from "../../src/plugin/tools.js"
import { buildInterruptCheckpoint } from "../../src/plugin/resume.js"
import { recoverJobs } from "../../src/plugin/recovery.js"
import type { DelegatedEvent } from "../../src/core/events.js"
import type { JobRecord } from "../../src/core/jobs.js"
import type { BackendAdapter, JobSnapshot } from "../../src/adapters/types.js"
import type { SessionManager } from "../../src/plugin/session-manager.js"

describe("delegation flow e2e", () => {
  it("Scenario 1: Full happy-path delegation flow", async () => {
    // 1. Create a job store
    const store = createJobStore()

    // 2. Create a fake adapter
    const adapter = new FakeAdapter()

    // 3. Create a mock OpenCode client
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-e2e-1" } }),
        get: vi.fn().mockResolvedValue({ data: { id: "child-e2e-1" } }),
      },
      message: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    }

    // 4. Create session manager from mock client
    const sessionManager = createSessionManager(mockClient)

    // 5. Create a delegated child session via session manager
    const childSessionId = await sessionManager.createDelegatedChild({
      parentSessionId: "parent-session-1",
      title: "E2E Test Job",
      backend: "claude-code",
    })

    expect(childSessionId).toBe("child-e2e-1")
    expect(mockClient.session.create).toHaveBeenCalledOnce()

    // 6. Start a job via the fake adapter
    const handle = await adapter.startJob({
      childSessionId,
      prompt: "implement the feature",
    })

    expect(handle.id).toBeTruthy()
    expect(handle.childSessionId).toBe("child-e2e-1")

    // 7. Subscribe to events and collect them all
    const events: DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(handle.id)) {
      events.push(event)
    }

    // Assert events contain result.final
    const types = events.map((e) => e.type)
    expect(types).toContain("result.final")

    // 8. Project each event through projectEvent()
    const projected = events.map((e) => projectEvent(e))

    // Assert all projected messages have a kind and text
    for (const msg of projected) {
      expect(msg.kind).toBeTruthy()
      expect(typeof msg.kind).toBe("string")
      expect(msg.text).toBeTruthy()
      expect(typeof msg.text).toBe("string")
    }

    // 9. Assert session manager's createDelegatedChild was called
    expect(mockClient.session.create).toHaveBeenCalledWith({
      parentId: "parent-session-1",
      title: "E2E Test Job",
      metadata: { backend: "claude-code" },
    })
  })

  it("Scenario 2: Interrupt and resume", async () => {
    const store = createJobStore()
    const adapter = new FakeAdapter()

    // 1. Start a job via fake adapter
    const handle = await adapter.startJob({
      childSessionId: "child-interrupt-1",
      prompt: "long running task",
    })

    // Save job record to store so tools can look it up
    const jobRecord: JobRecord = {
      childSessionId: "child-interrupt-1",
      backend: "claude-code",
      backendThreadId: handle.id,
      status: "running",
      resumable: true,
    }
    await store.save(jobRecord)

    // 2. Collect a few events then cancel
    const iter = adapter.subscribeEvents(handle.id)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toBeDefined()

    await adapter.cancelJob(handle.id)

    // Verify snapshot shows interrupted
    const snapshot = await adapter.getSnapshot(handle.id)
    expect(snapshot.status).toBe("interrupted")

    // Update store to reflect interrupted
    await store.save({ ...jobRecord, status: "interrupted" })

    // 3. Build an interrupt checkpoint from the job state
    const checkpoint = buildInterruptCheckpoint({
      childSessionId: "child-interrupt-1",
      status: "interrupted",
      changedFiles: [],
      resumable: true,
    })

    // 4. Assert checkpoint is resumable
    expect(checkpoint.resumable).toBe(true)
    expect(checkpoint.status).toBe("interrupted")
    expect(checkpoint.childSessionId).toBe("child-interrupt-1")

    // 5. Resume the job via delegatedJobResume from plugin/tools
    // Need store with the job saved as interrupted (with backendThreadId = handle.id)
    const mockSessionManager: SessionManager = {
      createDelegatedChild: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn(),
    }

    const ctx = { store, adapter, sessionManager: mockSessionManager }
    const resumedHandle = await delegatedJobResume(ctx, "child-interrupt-1", {
      checkpoint,
    })

    // 6. Assert the resumed job emits events again ending in result.final
    expect(resumedHandle.id).toBeTruthy()
    expect(resumedHandle.childSessionId).toBe("child-interrupt-1")

    const resumedEvents: DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(resumedHandle.id)) {
      resumedEvents.push(event)
    }

    expect(resumedEvents.length).toBeGreaterThan(0)
    const lastEvent = resumedEvents[resumedEvents.length - 1]
    expect(lastEvent.type).toBe("result.final")
  })

  it("Scenario 3: Policy enforcement", async () => {
    // 1. Build a delegation policy
    const policy = buildDelegationPolicy({
      projectRoot: "/repo",
      allowEdits: true,
      allowShell: false,
      allowNetwork: false,
    })

    // 2. Assert allowsPath for paths inside the project
    expect(policy.allowsPath("/repo/src/index.ts")).toBe(true)
    expect(policy.allowsPath("/repo")).toBe(true)

    // 3. Assert allowsPath for paths outside the project
    expect(policy.allowsPath("/etc/passwd")).toBe(false)
    expect(policy.allowsPath("/home/user/secret.txt")).toBe(false)

    // 4. Map to Claude policy — assert no "Bash" tool (shell is disabled)
    const claudePolicy = toClaudePolicy(policy)
    expect(claudePolicy.allowedTools).not.toContain("Bash")
    expect(claudePolicy.allowedTools).toContain("Read")
    expect(claudePolicy.allowedTools).toContain("Edit")
    expect(claudePolicy.allowedTools).toContain("Write")

    // 5. Map to Codex policy — assert sandboxed is true (shell is disabled)
    const codexPolicy = toCodexPolicy(policy)
    expect(codexPolicy.sandboxed).toBe(true)
    expect(codexPolicy.allowShell).toBe(false)
    expect(codexPolicy.allowEdits).toBe(true)
  })

  it("Scenario 4: Recovery after restart", async () => {
    // 1. Create a store with a "running" job record
    const store = createJobStore()
    const runningJob: JobRecord = {
      childSessionId: "child-recovery-1",
      backend: "codex",
      backendThreadId: "fake-thread-123",
      status: "running",
      resumable: true,
    }
    await store.save(runningJob)

    // 2. Create a mock adapter whose getSnapshot returns { status: "completed", ... }
    const mockAdapter: BackendAdapter = {
      startJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      subscribeEvents: vi.fn(),
      getSnapshot: vi.fn().mockResolvedValue({
        id: "fake-thread-123",
        childSessionId: "child-recovery-1",
        status: "completed",
        changedFiles: ["src/main.ts"],
        lastEventSeq: 5,
      } satisfies JobSnapshot),
    }

    // 3. Create a mock session manager
    const mockSessionManager: SessionManager = {
      createDelegatedChild: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn(),
    }

    // 4. Call recoverJobs
    const results = await recoverJobs({
      store,
      adapter: mockAdapter,
      sessionManager: mockSessionManager,
    })

    // 5. Assert result contains action "marked-interrupted" for the running job
    expect(results).toHaveLength(1)
    expect(results[0].childSessionId).toBe("child-recovery-1")
    expect(results[0].action).toBe("marked-interrupted")

    // 6. Assert store now has the job as "completed"
    const updatedJob = await store.get("child-recovery-1")
    expect(updatedJob).toBeDefined()
    expect(updatedJob!.status).toBe("completed")

    // 7. Assert sessionManager.postMessage was called with a recovery note
    expect(mockSessionManager.postMessage).toHaveBeenCalledOnce()
    expect(mockSessionManager.postMessage).toHaveBeenCalledWith(
      "child-recovery-1",
      expect.stringContaining("Recovery"),
    )
  })

  it("Scenario 5: Delta coalescing", async () => {
    const coalescer = new DeltaCoalescer()
    const sessionId = "child-coalesce-1"

    // 1. Push 3 assistant.delta events
    const result1 = coalescer.push({ type: "assistant.delta", sessionId, text: "Hello" })
    const result2 = coalescer.push({ type: "assistant.delta", sessionId, text: ", " })
    const result3 = coalescer.push({ type: "assistant.delta", sessionId, text: "world!" })

    // While accumulating deltas, push returns null
    expect(result1).toBeNull()
    expect(result2).toBeNull()
    expect(result3).toBeNull()

    // 2. Push a status.update event — this triggers a flush of the buffered deltas
    const flushResult = coalescer.push({ type: "status.update", sessionId, message: "processing" })

    // 3. Assert: the flush before the status update returns a combined message
    expect(flushResult).not.toBeNull()
    expect(flushResult!.kind).toBe("message")
    expect(flushResult!.text).toBe("Hello, world!")
    expect(flushResult!.sessionId).toBe(sessionId)

    // 4. Assert: the status.update projects to kind "status"
    const statusProjected = projectEvent({ type: "status.update", sessionId, message: "processing" })
    expect(statusProjected.kind).toBe("status")
    expect(statusProjected.text).toBe("processing")
  })
})
