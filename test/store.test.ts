import { describe, it, expect, beforeEach } from "vitest"
import { tmpdir } from "os"
import { join } from "path"
import { mkdir } from "fs/promises"
import { createJobStore } from "../src/core/store.js"
import type { JobRecord } from "../src/core/jobs.js"

const sampleJob: JobRecord = {
  jobId: "job-abc123",
  parentSessionId: "session-parent-1",
  runtimeType: "tmux",
  runtimeHandle: "runtime-handle-1",
  attachTarget: "runtime-handle-1",
  terminalLogPath: ".opencode/logs/job-abc123.terminal.log",
  status: "running",
  resumable: true,
  changedFiles: ["src/index.ts"],
  lastCheckpointAt: 1700000000000,
  lastEventSeq: 5,
  activeCommand: "edit",
  activeTool: "str_replace",
}

const sampleBatchJob = {
  ...sampleJob,
  jobId: "job-batch-1",
  batchId: "batch-parent-1",
} as JobRecord & { batchId: string }

const secondBatchJob = {
  ...sampleJob,
  jobId: "job-batch-2",
  runtimeHandle: "runtime-handle-2",
  attachTarget: "runtime-handle-2",
  batchId: "batch-parent-1",
} as JobRecord & { batchId: string }

const otherBatchJob = {
  ...sampleJob,
  jobId: "job-batch-3",
  runtimeHandle: "runtime-handle-3",
  attachTarget: "runtime-handle-3",
  batchId: "batch-parent-2",
} as JobRecord & { batchId: string }

describe("createJobStore (in-memory)", () => {
  it("save + get roundtrip", async () => {
    const store = createJobStore()
    await store.save(sampleJob)
    const retrieved = await store.get(sampleJob.jobId)
    expect(retrieved).toEqual(sampleJob)
  })

  it("stores the parent-session job shape", async () => {
    const store = createJobStore()
    await store.save(sampleJob)

    const retrieved = await store.get(sampleJob.jobId)

    expect(retrieved).toMatchObject({
      jobId: sampleJob.jobId,
      parentSessionId: sampleJob.parentSessionId,
      runtimeType: sampleJob.runtimeType,
      runtimeHandle: sampleJob.runtimeHandle,
      attachTarget: sampleJob.attachTarget,
      terminalLogPath: sampleJob.terminalLogPath,
    })
  })

  it("list returns all saved jobs", async () => {
    const store = createJobStore()
    const job2: JobRecord = { ...sampleJob, jobId: "job-def456", runtimeType: "pty", runtimeHandle: "runtime-handle-2", attachTarget: "runtime-handle-2" }
    await store.save(sampleJob)
    await store.save(job2)
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all).toEqual(expect.arrayContaining([sampleJob, job2]))
  })

  it("remove deletes a job", async () => {
    const store = createJobStore()
    await store.save(sampleJob)
    await store.remove(sampleJob.jobId)
    const retrieved = await store.get(sampleJob.jobId)
    expect(retrieved).toBeUndefined()
  })

  it("get on missing key returns undefined", async () => {
    const store = createJobStore()
    const result = await store.get("nonexistent-job")
    expect(result).toBeUndefined()
  })

  it("persists batch identity and returns only jobs from the requested batch", async () => {
    const store = createJobStore() as ReturnType<typeof createJobStore> & {
      listByBatch(batchId: string): Promise<JobRecord[]>
    }

    await store.save(sampleBatchJob)
    await store.save(secondBatchJob)
    await store.save(otherBatchJob)

    const retrieved = await store.get(sampleBatchJob.jobId) as JobRecord & { batchId?: string }
    const batchJobs = await store.listByBatch("batch-parent-1")

    expect(retrieved.batchId).toBe("batch-parent-1")
    expect(batchJobs).toEqual(expect.arrayContaining([sampleBatchJob, secondBatchJob]))
    expect(batchJobs).not.toEqual(expect.arrayContaining([otherBatchJob]))
  })
})

describe("createJobStore (file-backed persistence)", () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = join(tmpdir(), "omni-test-" + Date.now())
    await mkdir(stateDir, { recursive: true })
  })

  it("save + get roundtrip with file persistence", async () => {
    const store = createJobStore(stateDir)
    await store.save(sampleJob)
    const retrieved = await store.get(sampleJob.jobId)
    expect(retrieved).toEqual(sampleJob)
  })

  it("persists the parent-session job shape to disk", async () => {
    const store = createJobStore(stateDir)
    await store.save(sampleJob)

    const retrieved = await store.get(sampleJob.jobId)

    expect(retrieved).toMatchObject({
      jobId: sampleJob.jobId,
      parentSessionId: sampleJob.parentSessionId,
      runtimeType: sampleJob.runtimeType,
      runtimeHandle: sampleJob.runtimeHandle,
      attachTarget: sampleJob.attachTarget,
      terminalLogPath: sampleJob.terminalLogPath,
    })
  })

  it("list returns all saved jobs with file persistence", async () => {
    const store = createJobStore(stateDir)
    const job2: JobRecord = { ...sampleJob, jobId: "job-def456", runtimeType: "pty", runtimeHandle: "runtime-handle-2", attachTarget: "runtime-handle-2" }
    await store.save(sampleJob)
    await store.save(job2)
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all).toEqual(expect.arrayContaining([sampleJob, job2]))
  })

  it("remove deletes a job with file persistence", async () => {
    const store = createJobStore(stateDir)
    await store.save(sampleJob)
    await store.remove(sampleJob.jobId)
    const retrieved = await store.get(sampleJob.jobId)
    expect(retrieved).toBeUndefined()
  })

  it("get on missing key returns undefined with file persistence", async () => {
    const store = createJobStore(stateDir)
    const result = await store.get("nonexistent-job")
    expect(result).toBeUndefined()
  })

  it("data survives a new createJobStore instance pointing at the same dir", async () => {
    const store1 = createJobStore(stateDir)
    await store1.save(sampleJob)

    // Create a fresh store instance pointing at the same directory
    const store2 = createJobStore(stateDir)
    const retrieved = await store2.get(sampleJob.jobId)
    expect(retrieved).toEqual(sampleJob)
  })

  it("persists batch membership across store instances", async () => {
    const store1 = createJobStore(stateDir) as ReturnType<typeof createJobStore> & {
      listByBatch(batchId: string): Promise<JobRecord[]>
    }
    await store1.save(sampleBatchJob)
    await store1.save(secondBatchJob)
    await store1.save(otherBatchJob)

    const store2 = createJobStore(stateDir) as ReturnType<typeof createJobStore> & {
      listByBatch(batchId: string): Promise<JobRecord[]>
    }
    const retrieved = await store2.get(sampleBatchJob.jobId) as JobRecord & { batchId?: string }
    const batchJobs = await store2.listByBatch("batch-parent-1")

    expect(retrieved.batchId).toBe("batch-parent-1")
    expect(batchJobs).toEqual(expect.arrayContaining([sampleBatchJob, secondBatchJob]))
    expect(batchJobs).not.toEqual(expect.arrayContaining([otherBatchJob]))
  })
})
