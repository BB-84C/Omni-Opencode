import { describe, it, expect, vi } from "vitest"
import {
  buildInterruptCheckpoint,
  interruptCheckpointToMessage,
  resumeInstructionFromCheckpoint,
} from "../src/plugin/resume.js"
import { delegatedJobResume } from "../src/plugin/tools.js"
import type { ToolContext } from "../src/plugin/tools.js"
import type { JobRecord } from "../src/core/jobs.js"

// --- buildInterruptCheckpoint tests ---

describe("buildInterruptCheckpoint", () => {
  it("returns status 'interrupted'", () => {
    const cp = buildInterruptCheckpoint({ childSessionId: "sess-1", status: "interrupted" })
    expect(cp.status).toBe("interrupted")
  })

  it("sets phase to activeTool when provided", () => {
    const cp = buildInterruptCheckpoint({
      childSessionId: "sess-1",
      status: "interrupted",
      activeTool: "read_file",
      activeCommand: "npm test",
    })
    expect(cp.phase).toBe("tool:read_file")
  })

  it("sets phase to activeCommand when no activeTool", () => {
    const cp = buildInterruptCheckpoint({
      childSessionId: "sess-1",
      status: "interrupted",
      activeCommand: "npm test",
    })
    expect(cp.phase).toBe("command:npm test")
  })

  it("defaults phase to 'running' when neither present", () => {
    const cp = buildInterruptCheckpoint({ childSessionId: "sess-1", status: "interrupted" })
    expect(cp.phase).toBe("running")
  })

  it("sets resumable: true by default", () => {
    const cp = buildInterruptCheckpoint({ childSessionId: "sess-1", status: "interrupted" })
    expect(cp.resumable).toBe(true)
  })
})

// --- interruptCheckpointToMessage tests ---

describe("interruptCheckpointToMessage", () => {
  it("includes 'interrupted' in output", () => {
    const cp = buildInterruptCheckpoint({ childSessionId: "sess-1", status: "interrupted" })
    const msg = interruptCheckpointToMessage(cp)
    expect(msg).toContain("interrupted")
  })

  it("lists changedFiles", () => {
    const cp = buildInterruptCheckpoint({
      childSessionId: "sess-1",
      status: "interrupted",
      changedFiles: ["src/index.ts", "src/core/store.ts"],
    })
    const msg = interruptCheckpointToMessage(cp)
    expect(msg).toContain("src/index.ts")
    expect(msg).toContain("src/core/store.ts")
  })
})

// --- resumeInstructionFromCheckpoint tests ---

describe("resumeInstructionFromCheckpoint", () => {
  it("includes the extraInstruction when provided", () => {
    const cp = buildInterruptCheckpoint({
      childSessionId: "sess-1",
      status: "interrupted",
      changedFiles: ["src/index.ts"],
    })
    const instruction = resumeInstructionFromCheckpoint(cp, "Focus on the failing tests.")
    expect(instruction).toContain("Focus on the failing tests.")
  })
})

// --- delegatedJobResume tests ---

describe("delegatedJobResume", () => {
  it("calls adapter.resumeJob and updates store status to 'running'", async () => {
    const job: JobRecord = {
      childSessionId: "sess-resume",
      backend: "codex",
      status: "interrupted",
      backendThreadId: "backend-thread-99",
      resumable: true,
    }

    const mockHandle = { id: "backend-thread-99", childSessionId: "sess-resume" }
    const resumeJob = vi.fn().mockResolvedValue(mockHandle)
    const get = vi.fn().mockResolvedValue(job)
    const save = vi.fn().mockResolvedValue(undefined)

    const ctx: ToolContext = {
      store: { get, save, list: vi.fn(), delete: vi.fn() } as any,
      adapter: { resumeJob, startJob: vi.fn(), cancelJob: vi.fn(), subscribeEvents: vi.fn(), getSnapshot: vi.fn() },
      sessionManager: {} as any,
    }

    const result = await delegatedJobResume(ctx, "sess-resume", { instruction: "Continue." })

    expect(resumeJob).toHaveBeenCalledWith("backend-thread-99", "Continue.")
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }))
    expect(result).toEqual(mockHandle)
  })
})
