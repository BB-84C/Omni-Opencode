import { describe, it, expect, beforeEach } from "vitest"
import { tmpdir } from "os"
import { join } from "path"
import { mkdir } from "fs/promises"
import { createJobStore } from "../src/core/store.js"
import type { JobRecord } from "../src/core/jobs.js"

const sampleJob: JobRecord = {
  childSessionId: "session-abc123",
  backend: "codex",
  status: "running",
  brokerJobId: "broker-1",
  backendThreadId: "thread-1",
  resumeToken: "token-xyz",
  resumable: true,
  changedFiles: ["src/index.ts"],
  lastCheckpointAt: 1700000000000,
  lastEventSeq: 5,
  activeCommand: "edit",
  activeTool: "str_replace",
}

describe("createJobStore (in-memory)", () => {
  it("save + get roundtrip", async () => {
    const store = createJobStore()
    await store.save(sampleJob)
    const retrieved = await store.get(sampleJob.childSessionId)
    expect(retrieved).toEqual(sampleJob)
  })

  it("list returns all saved jobs", async () => {
    const store = createJobStore()
    const job2: JobRecord = { ...sampleJob, childSessionId: "session-def456", backend: "claude-code" }
    await store.save(sampleJob)
    await store.save(job2)
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all).toEqual(expect.arrayContaining([sampleJob, job2]))
  })

  it("remove deletes a job", async () => {
    const store = createJobStore()
    await store.save(sampleJob)
    await store.remove(sampleJob.childSessionId)
    const retrieved = await store.get(sampleJob.childSessionId)
    expect(retrieved).toBeUndefined()
  })

  it("get on missing key returns undefined", async () => {
    const store = createJobStore()
    const result = await store.get("nonexistent-session")
    expect(result).toBeUndefined()
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
    const retrieved = await store.get(sampleJob.childSessionId)
    expect(retrieved).toEqual(sampleJob)
  })

  it("list returns all saved jobs with file persistence", async () => {
    const store = createJobStore(stateDir)
    const job2: JobRecord = { ...sampleJob, childSessionId: "session-def456", backend: "claude-code" }
    await store.save(sampleJob)
    await store.save(job2)
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all).toEqual(expect.arrayContaining([sampleJob, job2]))
  })

  it("remove deletes a job with file persistence", async () => {
    const store = createJobStore(stateDir)
    await store.save(sampleJob)
    await store.remove(sampleJob.childSessionId)
    const retrieved = await store.get(sampleJob.childSessionId)
    expect(retrieved).toBeUndefined()
  })

  it("get on missing key returns undefined with file persistence", async () => {
    const store = createJobStore(stateDir)
    const result = await store.get("nonexistent-session")
    expect(result).toBeUndefined()
  })

  it("data survives a new createJobStore instance pointing at the same dir", async () => {
    const store1 = createJobStore(stateDir)
    await store1.save(sampleJob)

    // Create a fresh store instance pointing at the same directory
    const store2 = createJobStore(stateDir)
    const retrieved = await store2.get(sampleJob.childSessionId)
    expect(retrieved).toEqual(sampleJob)
  })
})
