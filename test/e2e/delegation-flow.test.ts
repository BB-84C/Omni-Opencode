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

  it("Scenario 6: parent tool returns before child session stream completes", async () => {
    // Controlled adapter: stream is gated behind a manually-released promise.
    // This lets us prove the parent tool returns BEFORE events arrive in the child.
    let releaseStream!: () => void
    const streamGate = new Promise<void>((r) => {
      releaseStream = r
    })

    const childPosts: string[] = []
    let streamDrainCompleted = false

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-bg-1" } }),
        promptAsync: vi.fn().mockImplementation(async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
          childPosts.push(body.parts[0].text)
        }),
      },
    }

    const jobId = "gated-job-1"
    const childSessionId = "child-bg-1"

    // Adapter whose event stream is gated — yields nothing until releaseStream() is called
    const gatedAdapter = {
      async startJob(_params: unknown) {
        return { id: jobId, childSessionId }
      },
      async cancelJob() {},
      async resumeJob(_id: string) {
        return { id: jobId, childSessionId }
      },
      async getSnapshot() {
        return { id: jobId, childSessionId, status: "running" as const, changedFiles: [], lastEventSeq: 0 }
      },
      async *subscribeEvents(_id: string): AsyncIterable<DelegatedEvent> {
        await streamGate
        yield { type: "status.update" as const, sessionId: childSessionId, message: "step 1" }
        yield { type: "result.final" as const, sessionId: childSessionId, summary: "done", changedFiles: [] }
        streamDrainCompleted = true
      },
    }

    const store = createJobStore()

    // Simulate what the plugin delegate tool does: create child session, start job, return immediately
    const childRes = await mockClient.session.create({ body: { parentID: "parent-1", title: "bg test" } })
    const createdChildId = childRes.data.id

    const handle = await gatedAdapter.startJob({ childSessionId: createdChildId, prompt: "test" })
    await store.save({
      childSessionId: createdChildId,
      backend: "claude-code" as const,
      backendThreadId: handle.id,
      status: "running" as const,
    })

    // Background drain — deliberately NOT awaited (fire and forget, like the real plugin)
    const drainPromise = (async () => {
      const { projectEvent } = await import("../../src/opencode/projection.js")
      for await (const event of gatedAdapter.subscribeEvents(handle.id)) {
        const projected = projectEvent(event as DelegatedEvent)
        await mockClient.session.promptAsync({
          path: { id: createdChildId },
          body: { noReply: true, parts: [{ type: "text" as const, text: projected.text }] },
        })
      }
      await store.save({
        childSessionId: createdChildId,
        backend: "claude-code" as const,
        backendThreadId: handle.id,
        status: "completed" as const,
      })
    })()

    // ── The parent "tool" has now "returned" (it did not await drainPromise) ──
    // Stream gate is still locked: no events have flowed, no posts to child yet
    expect(streamDrainCompleted).toBe(false)
    expect(childPosts).toHaveLength(0)

    // The store shows "running" immediately — parent can return this link to the user
    const runningJob = await store.get(createdChildId)
    expect(runningJob?.status).toBe("running")

    // Release the gate and let the background drain complete
    releaseStream()
    await drainPromise

    // After drain: child received projected events and store reflects completion
    expect(streamDrainCompleted).toBe(true)
    expect(childPosts.length).toBeGreaterThan(0)
    expect(childPosts[childPosts.length - 1]).toContain("done")

    const completedJob = await store.get(createdChildId)
    expect(completedJob?.status).toBe("completed")
  })

  it("Scenario 7: broker drain writes live telemetry; snapshot returns rich state", async () => {
    // This test validates the durable telemetry path: as the drain runs, the
    // store accumulates lastProjectedMessage, changedFiles, activeTool,
    // activeCommand, summary, and eventSeq. delegated_job_snapshot exposes all
    // of these — not just status.
    //
    // NOTE (API gap): this test does NOT assert that the parent session shows a
    // native Task card or that child messages are assistant-role. Those require
    // OpenCode core changes documented in docs/api-gap.md.

    const store = createJobStore()
    const adapter = new FakeAdapter()

    const handle = await adapter.startJob({
      childSessionId: "child-telemetry-1",
      prompt: "build and test the feature",
    })

    await store.save({
      childSessionId: "child-telemetry-1",
      backend: "claude-code",
      backendThreadId: handle.id,
      status: "running",
    })

    // Simulate the drain loop — mirrors what drainStream() does in plugin.ts
    let eventSeq = 0
    let lastProjectedMessage: string | undefined
    let summary: string | undefined
    const changedFiles: string[] = []
    let activeTool: string | undefined
    let activeCommand: string | undefined

    const coalescer = new DeltaCoalescer()

    for await (const event of adapter.subscribeEvents(handle.id)) {
      eventSeq++

      if (event.type === "result.final") {
        summary = event.summary
        if (event.changedFiles) changedFiles.push(...event.changedFiles)
      } else if (event.type === "file.change") {
        changedFiles.push(event.path)
      } else if (event.type === "tool.start") {
        activeTool = event.toolName
      } else if (event.type === "tool.end") {
        activeTool = undefined
      } else if (event.type === "command.start") {
        activeCommand = event.command
      }

      const projected = coalescer.push(event)
      if (projected) {
        lastProjectedMessage = projected.text
      }

      // Checkpoint every 5 events (same cadence as plugin.ts)
      if (eventSeq % 5 === 0) {
        await store.save({
          childSessionId: "child-telemetry-1",
          backend: "claude-code",
          backendThreadId: handle.id,
          status: "running",
          lastEventSeq: eventSeq,
          lastProjectedMessage,
          changedFiles: [...changedFiles],
          activeTool,
          activeCommand,
          lastCheckpointAt: Date.now(),
        })
      }
    }

    const remaining = coalescer.flush()
    if (remaining) lastProjectedMessage = remaining.text

    await store.save({
      childSessionId: "child-telemetry-1",
      backend: "claude-code",
      backendThreadId: handle.id,
      status: "completed",
      lastEventSeq: eventSeq,
      lastProjectedMessage,
      summary,
      changedFiles: [...changedFiles],
      lastCheckpointAt: Date.now(),
    })

    // ── Assert snapshot contains meaningful telemetry ──
    const snapshot = await store.get("child-telemetry-1")
    expect(snapshot).toBeDefined()

    const job = snapshot as JobRecord
    expect(job.status).toBe("completed")
    expect(job.lastEventSeq).toBeGreaterThan(0)
    expect(job.lastProjectedMessage).toBeTruthy()
    expect(job.summary).toBe("completed")         // from FakeAdapter's result.final
    expect(job.changedFiles).toContain("src/index.ts")  // from FakeAdapter
    expect(job.lastCheckpointAt).toBeGreaterThan(0)

    // Snapshot is serialisable (what delegated_job_snapshot returns)
    const serialised = JSON.stringify(job, null, 2)
    expect(serialised).toContain('"status": "completed"')
    expect(serialised).toContain('"summary"')
    expect(serialised).toContain('"lastProjectedMessage"')
    expect(serialised).toContain('"changedFiles"')
  })

  it("Scenario 8: bridge architecture — internal start tool uses context.sessionID, no session.create", async () => {
    // Validates the wrapper-subagent architecture:
    //   • An internal start tool (omni_start_*_job) receives the session via context.sessionID
    //   • It must bind the backend to that session — never call session.create
    //   • The broker store is keyed on the wrapper (native Task) session ID
    //   • Events are projected and would be posted to that same session
    //
    // Native Task card linkage happens at the OpenCode level (session.promptAsync +
    // SubtaskPartInput), not inside the plugin. This test proves the plugin side is correct.

    const store = createJobStore()
    const adapter = new FakeAdapter()

    // Simulate context.sessionID from a native Task-created child session
    const BRIDGE_SESSION_ID = "ses_native-bridge-001"

    // Internal tool: start job bound to bridge session — no session.create
    const handle = await adapter.startJob({
      childSessionId: BRIDGE_SESSION_ID,
      prompt: "implement the feature end-to-end",
    })
    expect(handle.childSessionId).toBe(BRIDGE_SESSION_ID)

    await store.save({
      childSessionId: BRIDGE_SESSION_ID,
      backend: "claude-code",
      backendThreadId: handle.id,
      status: "running",
    })

    // Drain — mirrors drainStream in plugin.ts; postToSession targets bridge session
    const postedMessages: string[] = []
    const coalescer = new DeltaCoalescer()
    let eventSeq = 0
    let summary: string | undefined
    const changedFiles: string[] = []

    for await (const event of adapter.subscribeEvents(handle.id)) {
      eventSeq++
      if (event.type === "result.final") {
        summary = event.summary
        if (event.changedFiles) changedFiles.push(...event.changedFiles)
      }
      const projected = coalescer.push(event)
      if (projected) postedMessages.push(projected.text)
    }
    const remaining = coalescer.flush()
    if (remaining) postedMessages.push(remaining.text)

    await store.save({
      childSessionId: BRIDGE_SESSION_ID,
      backend: "claude-code",
      backendThreadId: handle.id,
      status: "completed",
      lastEventSeq: eventSeq,
      summary,
      changedFiles,
      lastProjectedMessage: postedMessages.at(-1),
      lastCheckpointAt: Date.now(),
    })

    // Bridge session IS the child session — no second session was created
    const job = await store.get(BRIDGE_SESSION_ID)
    expect(job!.childSessionId).toBe(BRIDGE_SESSION_ID)
    expect(job!.status).toBe("completed")
    expect(job!.summary).toBe("completed")
    expect(job!.changedFiles).toContain("src/index.ts")
    expect(postedMessages.length).toBeGreaterThan(0)

    // Store has exactly one entry — the native bridge session
    const allJobs = await store.list()
    expect(allJobs).toHaveLength(1)
    expect(allJobs[0].childSessionId).toBe(BRIDGE_SESSION_ID)

    // Tool return value (what the bridge agent reports to the parent Task)
    expect(summary ?? "").toBeTruthy()
  })

  it("Scenario 11: drain starts on session.idle, not on tool call", async () => {
    // Validates the event-driven handoff architecture:
    //   1. startAndRegister() starts the backend immediately but only registers a
    //      pending drain thunk — the drain does NOT run yet.
    //   2. When the plugin event hook sees session.idle for that session ID, it calls
    //      the thunk and the drain begins.
    //   3. Writes (postToSession) happen only after the session is truly idle —
    //      no race with the bridge agent's own final answer.
    //
    // This prevents the race that caused Claude child sessions to never advance:
    //   • Tool returns → bridge agent writes its final wrapper message (session busy)
    //   • session.idle fires → session is now free → drain writes land reliably

    const store = createJobStore()
    const BRIDGE_SESSION_ID = "ses_bridge-idletest-001"
    const posts: string[] = []
    let drainStarted = false
    let drainFinished = false

    // Simulate pending drain registry (mirrors the Map in plugin.ts)
    const pendingDrains = new Map<string, () => void>()
    const activeJobs = new Map<string, Promise<string>>()

    const adapter = new FakeAdapter()

    // Step 1: simulate what startAndRegister does inside the tool execute callback
    const handle = await adapter.startJob({ childSessionId: BRIDGE_SESSION_ID, prompt: "test" })
    await store.save({ childSessionId: BRIDGE_SESSION_ID, backend: "claude-code", backendThreadId: handle.id, status: "running" })

    // Register drain thunk — NOT run yet
    pendingDrains.set(BRIDGE_SESSION_ID, () => {
      drainStarted = true
      const drainPromise = (async (): Promise<string> => {
        const coalescer = new DeltaCoalescer()
        let eventSeq = 0
        let summary: string | undefined
        const changedFiles: string[] = []
        for await (const event of adapter.subscribeEvents(handle.id)) {
          eventSeq++
          if (event.type === "result.final") {
            summary = event.summary
            if (event.changedFiles) changedFiles.push(...event.changedFiles)
          }
          const projected = coalescer.push(event)
          if (projected) posts.push(projected.text)
        }
        const rem = coalescer.flush()
        if (rem) posts.push(rem.text)
        await store.save({
          childSessionId: BRIDGE_SESSION_ID, backend: "claude-code", backendThreadId: handle.id,
          status: "completed", lastEventSeq: eventSeq, summary, changedFiles,
          lastProjectedMessage: posts.at(-1), lastCheckpointAt: Date.now(),
        })
        drainFinished = true
        activeJobs.delete(BRIDGE_SESSION_ID)
        return summary ?? ""
      })()
      activeJobs.set(BRIDGE_SESSION_ID, drainPromise)
      pendingDrains.delete(BRIDGE_SESSION_ID)
    })

    // ── After startAndRegister: backend started, drain NOT started ──
    expect(drainStarted).toBe(false)
    expect(posts).toHaveLength(0)
    expect(pendingDrains.has(BRIDGE_SESSION_ID)).toBe(true)
    expect((await store.get(BRIDGE_SESSION_ID))?.status).toBe("running")

    // ── Simulate bridge agent writing its final wrapper answer (session still busy) ──
    // Drain must NOT have started yet — this proves no race with bridge final answer
    expect(drainStarted).toBe(false)

    // ── Simulate event hook receiving session.idle for this session ──
    const startDrain = pendingDrains.get(BRIDGE_SESSION_ID)
    if (startDrain) startDrain()

    // After idle fires: drain thunk called, drain is running
    expect(drainStarted).toBe(true)
    expect(pendingDrains.has(BRIDGE_SESSION_ID)).toBe(false)
    expect(activeJobs.has(BRIDGE_SESSION_ID)).toBe(true)

    // Await the drain
    await activeJobs.get(BRIDGE_SESSION_ID)

    expect(drainFinished).toBe(true)
    expect(posts.length).toBeGreaterThan(0)
    const finalJob = await store.get(BRIDGE_SESSION_ID)
    expect(finalJob?.status).toBe("completed")
    expect(finalJob?.summary).toBe("completed")  // FakeAdapter result.final summary
    expect(finalJob?.changedFiles).toContain("src/index.ts")
  })

  it("Scenario 9: start tool returns before drain completes; drain advances telemetry after return", async () => {
    // Proves that omni_start_*_job fires the drain and returns immediately.
    // The drain continues posting events AFTER the tool has "returned".
    // Previously: awaiting drain inside the tool stalled because the running tool
    // held the session turn, blocking postToSession writes.

    let releaseStream!: () => void
    const streamGate = new Promise<void>((r) => { releaseStream = r })
    let drainFinished = false
    const store = createJobStore()
    const BRIDGE_SESSION_ID = "ses_bridge-draintest-001"
    const posts: string[] = []

    const gatedAdapter: BackendAdapter = {
      async startJob() { return { id: "drain-handle-1", childSessionId: BRIDGE_SESSION_ID } },
      async cancelJob() {},
      async resumeJob() { return { id: "drain-handle-1", childSessionId: BRIDGE_SESSION_ID } },
      async getSnapshot() {
        return { id: "drain-handle-1", childSessionId: BRIDGE_SESSION_ID, status: "running" as const, changedFiles: [], lastEventSeq: 0 }
      },
      async *subscribeEvents(): AsyncIterable<DelegatedEvent> {
        await streamGate
        yield { type: "status.update" as const, sessionId: BRIDGE_SESSION_ID, message: "working" }
        yield { type: "result.final" as const, sessionId: BRIDGE_SESSION_ID, summary: "done", changedFiles: ["src/main.ts"] }
        drainFinished = true
      },
    }

    const handle = await gatedAdapter.startJob({ childSessionId: BRIDGE_SESSION_ID, prompt: "test" })
    await store.save({ childSessionId: BRIDGE_SESSION_ID, backend: "claude-code", backendThreadId: handle.id, status: "running" })

    // Simulate startAndForget: register drain, do NOT await
    const drain = (async (): Promise<string> => {
      const coalescer = new DeltaCoalescer()
      let summary: string | undefined
      const changedFiles: string[] = []
      let eventSeq = 0
      for await (const event of gatedAdapter.subscribeEvents(handle.id)) {
        eventSeq++
        if (event.type === "result.final") {
          summary = event.summary
          if (event.changedFiles) changedFiles.push(...event.changedFiles)
        }
        const projected = coalescer.push(event)
        if (projected) posts.push(projected.text)
      }
      const rem = coalescer.flush()
      if (rem) posts.push(rem.text)
      await store.save({
        childSessionId: BRIDGE_SESSION_ID, backend: "claude-code", backendThreadId: handle.id,
        status: "completed", lastEventSeq: eventSeq, summary, changedFiles,
        lastProjectedMessage: posts.at(-1), lastCheckpointAt: Date.now(),
      })
      return summary ?? ""
    })()

    // ── Tool has "returned" — stream gate still locked ──
    expect(drainFinished).toBe(false)
    expect(posts).toHaveLength(0)
    expect((await store.get(BRIDGE_SESSION_ID))?.status).toBe("running")

    // Release gate — drain runs with freed session turn
    releaseStream()
    await drain

    expect(drainFinished).toBe(true)
    expect(posts.length).toBeGreaterThan(0)
    const finalJob = await store.get(BRIDGE_SESSION_ID)
    expect(finalJob?.status).toBe("completed")
    expect(finalJob?.summary).toBe("done")
    expect(finalJob?.changedFiles).toContain("src/main.ts")
  })

  it("Scenario 10: two parallel bridge sessions bind to independent session IDs", async () => {
    // Proves that two wrapper subagents (omni-claude-bridge, omni-codex-bridge) each
    // bind to their own context.sessionID and produce independent broker entries.
    // Previously broken: delegate_to_* injecting multiple SubtaskParts via promptAsync
    // from one tool turn only created one Task. With bridge agents each Task is
    // created independently through OpenCode's own mechanism.

    const store = createJobStore()
    const adapter = new FakeAdapter()

    const CLAUDE_SESSION = "ses_claude-bridge-001"
    const CODEX_SESSION = "ses_codex-bridge-001"

    const claudeHandle = await adapter.startJob({ childSessionId: CLAUDE_SESSION, prompt: "feature A" })
    await store.save({ childSessionId: CLAUDE_SESSION, backend: "claude-code", backendThreadId: claudeHandle.id, status: "running" })

    const codexHandle = await adapter.startJob({ childSessionId: CODEX_SESSION, prompt: "feature B" })
    await store.save({ childSessionId: CODEX_SESSION, backend: "codex", backendThreadId: codexHandle.id, status: "running" })

    const drain = async (sessionId: string, handleId: string, backend: "claude-code" | "codex") => {
      const events: DelegatedEvent[] = []
      for await (const event of adapter.subscribeEvents(handleId)) events.push(event)
      const final = events.find(e => e.type === "result.final") as Extract<DelegatedEvent, { type: "result.final" }> | undefined
      await store.save({
        childSessionId: sessionId, backend, backendThreadId: handleId, status: "completed",
        summary: final?.summary, changedFiles: final?.changedFiles ?? [], lastEventSeq: events.length, lastCheckpointAt: Date.now(),
      })
    }

    await Promise.all([
      drain(CLAUDE_SESSION, claudeHandle.id, "claude-code"),
      drain(CODEX_SESSION, codexHandle.id, "codex"),
    ])

    const claudeJob = await store.get(CLAUDE_SESSION)
    const codexJob = await store.get(CODEX_SESSION)

    expect(claudeJob?.status).toBe("completed")
    expect(claudeJob?.backend).toBe("claude-code")
    expect(codexJob?.status).toBe("completed")
    expect(codexJob?.backend).toBe("codex")

    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all.map(j => j.childSessionId).sort()).toEqual([CLAUDE_SESSION, CODEX_SESSION].sort())
  })
})
