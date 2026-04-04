import { describe, it, expect, vi, beforeEach } from "vitest"
import { recoverJobs } from "../src/plugin/recovery.js"
import type { JobStore } from "../src/core/store.js"
import type { BackendAdapter, JobSnapshot } from "../src/adapters/types.js"
import type { SessionManager } from "../src/plugin/session-manager.js"
import type { JobRecord } from "../src/core/jobs.js"

function makeStore(jobs: JobRecord[]): JobStore {
  return {
    list: vi.fn().mockResolvedValue(jobs),
    get: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobStore
}

function makeAdapter(snapshotResult: JobSnapshot | Error): BackendAdapter {
  const getSnapshot =
    snapshotResult instanceof Error
      ? vi.fn().mockRejectedValue(snapshotResult)
      : vi.fn().mockResolvedValue(snapshotResult)

  return {
    startJob: vi.fn(),
    resumeJob: vi.fn(),
    cancelJob: vi.fn(),
    subscribeEvents: vi.fn(),
    getSnapshot,
  } as unknown as BackendAdapter
}

function makeSessionManager(): SessionManager {
  return {
    createDelegatedChild: vi.fn(),
    postMessage: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn(),
  } as unknown as SessionManager
}

function runningJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    childSessionId: "child-1",
    backend: "codex",
    status: "running",
    ...overrides,
  }
}

describe("recoverJobs", () => {
  it("returns empty array when called with no arguments", async () => {
    const result = await recoverJobs()
    expect(result).toEqual([])
  })

  it("returns all jobs as skipped when there are no running jobs", async () => {
    const jobs: JobRecord[] = [
      { childSessionId: "child-1", backend: "codex", status: "completed" },
      { childSessionId: "child-2", backend: "claude-code", status: "failed" },
      { childSessionId: "child-3", backend: "codex", status: "interrupted", resumable: false },
    ]
    const store = makeStore(jobs)
    const adapter = makeAdapter({
      id: "job-1",
      childSessionId: "child-1",
      status: "completed",
      changedFiles: [],
      lastEventSeq: 0,
    })
    const sessionManager = makeSessionManager()

    const result = await recoverJobs({ store, adapter, sessionManager })

    expect(result).toHaveLength(3)
    expect(result.every((r) => r.action === "skipped")).toBe(true)
  })

  it("marks a running job as marked-interrupted and posts a message when snapshot is completed", async () => {
    const job = runningJob({ childSessionId: "child-1", activeTool: "read_file" })
    const store = makeStore([job])
    const snapshot: JobSnapshot = {
      id: "job-1",
      childSessionId: "child-1",
      status: "completed",
      changedFiles: [],
      lastEventSeq: 5,
    }
    const adapter = makeAdapter(snapshot)
    const sessionManager = makeSessionManager()

    const result = await recoverJobs({ store, adapter, sessionManager })

    expect(result).toHaveLength(1)
    expect(result[0].childSessionId).toBe("child-1")
    expect(result[0].action).toBe("marked-interrupted")

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-1", status: "completed" })
    )
    expect(sessionManager.postMessage).toHaveBeenCalledWith(
      "child-1",
      expect.stringContaining("Recovery")
    )
  })

  it("marks a running job as marked-interrupted when snapshot throws", async () => {
    const job = runningJob({ childSessionId: "child-2", activeCommand: "npm test" })
    const store = makeStore([job])
    const adapter = makeAdapter(new Error("backend unreachable"))
    const sessionManager = makeSessionManager()

    const result = await recoverJobs({ store, adapter, sessionManager })

    expect(result).toHaveLength(1)
    expect(result[0].action).toBe("marked-interrupted")
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-2", status: "interrupted" })
    )
    expect(sessionManager.postMessage).toHaveBeenCalledWith(
      "child-2",
      expect.stringContaining("Recovery")
    )
  })

  it("returns reconnected when running job snapshot is still running", async () => {
    const job = runningJob({ childSessionId: "child-3", backendThreadId: "thread-abc" })
    const store = makeStore([job])
    const snapshot: JobSnapshot = {
      id: "thread-abc",
      childSessionId: "child-3",
      status: "running",
      changedFiles: [],
      lastEventSeq: 2,
    }
    const adapter = makeAdapter(snapshot)
    const sessionManager = makeSessionManager()

    const result = await recoverJobs({ store, adapter, sessionManager })

    expect(result).toHaveLength(1)
    expect(result[0].action).toBe("reconnected")
    expect(store.save).not.toHaveBeenCalled()
    expect(sessionManager.postMessage).not.toHaveBeenCalled()
  })

  it("returns skipped for interrupted+resumable jobs", async () => {
    const job: JobRecord = {
      childSessionId: "child-4",
      backend: "claude-code",
      status: "interrupted",
      resumable: true,
    }
    const store = makeStore([job])
    const adapter = makeAdapter(new Error("should not be called"))
    const sessionManager = makeSessionManager()

    const result = await recoverJobs({ store, adapter, sessionManager })

    expect(result).toHaveLength(1)
    expect(result[0].action).toBe("skipped")
    expect(adapter.getSnapshot).not.toHaveBeenCalled()
  })
})
