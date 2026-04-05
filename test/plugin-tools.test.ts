import { describe, it, expect, vi, beforeEach } from "vitest"
import { delegatedJobsList, delegatedJobSnapshot, delegatedJobCancel } from "../src/plugin/tools.js"
import type { ToolContext } from "../src/plugin/tools.js"
import { createJobStore } from "../src/core/store.js"
import { FakeAdapter } from "../src/adapters/fake-adapter.js"
import { createSessionManager } from "../src/plugin/session-manager.js"
import type { OpenCodeClient } from "../src/plugin/session-manager.js"
import type { JobRecord } from "../src/core/jobs.js"

function makeMockClient(): OpenCodeClient {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-session-abc" } }),
      get: vi.fn().mockResolvedValue({ data: { id: "child-session-abc" } }),
    },
    message: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  }
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "parent-session-1:job-1",
    parentSessionId: "parent-session-1",
    runtimeType: "tmux",
    runtimeHandle: "runtime-handle-1",
    attachTarget: "runtime-handle-1",
    terminalLogPath: "logs/job-1.log",
    childSessionId: "child-session-1",
    backend: "codex",
    status: "running",
    ...overrides,
  }
}

async function makeContext(jobs: JobRecord[] = []): Promise<ToolContext> {
  const store = createJobStore()
  for (const job of jobs) {
    await store.save(job)
  }
  const adapter = new FakeAdapter()
  const sessionManager = createSessionManager(makeMockClient())
  return { store, adapter, sessionManager }
}

describe("delegatedJobsList", () => {
  it("returns empty list when no jobs in store", async () => {
    const ctx = await makeContext()
    const result = await delegatedJobsList(ctx)
    expect(result.jobs).toEqual([])
  })

  it("returns all jobs from the store with mapped fields", async () => {
    const ctx = await makeContext([
      makeJob({ jobId: "parent-session-1:job-1", childSessionId: "child-1", backend: "codex", status: "running", resumable: true }),
      makeJob({ jobId: "parent-session-1:job-2", childSessionId: "child-2", backend: "claude-code", status: "interrupted", resumable: false }),
    ])

    const result = await delegatedJobsList(ctx)
    expect(result.jobs).toHaveLength(2)

    const job1 = result.jobs.find((j) => j.childSessionId === "child-1")
    expect(job1).toEqual({ childSessionId: "child-1", backend: "codex", status: "running", resumable: true })

    const job2 = result.jobs.find((j) => j.childSessionId === "child-2")
    expect(job2).toEqual({ childSessionId: "child-2", backend: "claude-code", status: "interrupted", resumable: false })
  })

  it("defaults resumable to false when not set", async () => {
    const ctx = await makeContext([makeJob({ jobId: "parent-session-1:job-1", childSessionId: "child-1" })])
    const result = await delegatedJobsList(ctx)
    expect(result.jobs[0]!.resumable).toBe(false)
  })
})

describe("delegatedJobSnapshot", () => {
  it("returns snapshot merged with store data", async () => {
    const jobId = "parent-session-1:snap-job"
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({ childSessionId: "child-snap", prompt: "do work" })

    const store = createJobStore()
    await store.save(makeJob({
      jobId,
      childSessionId: "child-snap",
      backend: "codex",
      status: "running",
      backendThreadId: handle.id,
      resumable: true,
    }))

    const ctx: ToolContext = { store, adapter, sessionManager: createSessionManager(makeMockClient()) }
    const result = await delegatedJobSnapshot(ctx, jobId)

    expect(result.childSessionId).toBe(jobId)
    expect(result.status).toBe("running")
    expect(result.changedFiles).toEqual([])
    expect(typeof result.lastEventSeq).toBe("number")
    expect(result.resumable).toBe(true)
  })

  it("throws when job not found in store", async () => {
    const ctx = await makeContext()
    await expect(delegatedJobSnapshot(ctx, "non-existent")).rejects.toThrow()
  })
})

describe("delegatedJobCancel", () => {
  it("calls adapter.cancelJob and updates store status to interrupted", async () => {
    const jobId = "parent-session-1:cancel-job"
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({ childSessionId: "child-cancel", prompt: "do work" })

    const store = createJobStore()
    await store.save(makeJob({
      jobId,
      childSessionId: "child-cancel",
      backend: "codex",
      status: "running",
      backendThreadId: handle.id,
    }))

    const cancelSpy = vi.spyOn(adapter, "cancelJob")
    const ctx: ToolContext = { store, adapter, sessionManager: createSessionManager(makeMockClient()) }
    const result = await delegatedJobCancel(ctx, jobId)

    expect(result.cancelled).toBe(true)
    expect(cancelSpy).toHaveBeenCalledOnce()
    expect(cancelSpy).toHaveBeenCalledWith(handle.id)

    const updatedJob = await store.get(jobId)
    expect(updatedJob?.status).toBe("interrupted")
  })

  it("uses childSessionId as fallback when backendThreadId is not set", async () => {
    const jobId = "parent-session-1:noid-job"
    const adapter = new FakeAdapter()
    await adapter.startJob({ childSessionId: "child-noid", prompt: "do work" })

    const store = createJobStore()
    await store.save(makeJob({
      jobId,
      childSessionId: "child-noid",
      backend: "codex",
      status: "running",
      // No backendThreadId set
    }))

    const cancelSpy = vi.spyOn(adapter, "cancelJob").mockResolvedValue(undefined)
    const ctx: ToolContext = { store, adapter, sessionManager: createSessionManager(makeMockClient()) }
    const result = await delegatedJobCancel(ctx, jobId)

    expect(result.cancelled).toBe(true)
    expect(cancelSpy).toHaveBeenCalledWith(jobId)
  })

  it("throws when job not found in store", async () => {
    const ctx = await makeContext()
    await expect(delegatedJobCancel(ctx, "non-existent")).rejects.toThrow()
  })
})
