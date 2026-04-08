import { describe, expect, it } from "vitest"
import { createFakeRuntime } from "../src/runtime/fake-runtime"

describe("runtime abstraction", () => {
  it("starts a monitored job and exposes stable monitor metadata", async () => {
    const runtime = createFakeRuntime()
    const job = await runtime.start({ backend: "claude-code", command: "claude -p hello" })
    const monitor = await runtime.openMonitor({ type: "job", jobId: job.id })

    expect(job.monitor.id).toBeTruthy()
    expect(job.monitor.attach).toEqual({
      mode: "pty",
      target: job.monitor.id,
    })
    expect(job.monitor.launch).toEqual({ command: "claude -p hello" })
    expect(monitor).toEqual(job.monitor)

    await runtime.stop(job.id)

    const snapshot = await runtime.snapshot()
    expect(snapshot.jobs).toContainEqual({
      ...job,
      status: "stopped",
    })
  })
})
