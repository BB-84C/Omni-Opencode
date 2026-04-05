import { describe, expect, it, vi } from "vitest"
import { createPluginRuntimeSelection, preparePluginRuntimeStart } from "../src/plugin.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeReadResult, RuntimeSnapshot } from "../src/runtime/types.js"

function createRuntime(): Runtime {
  return {
    async start(): Promise<RuntimeJob> {
      return {
        id: "job-1",
        backend: "claude-code",
        command: "claude -p hello",
        status: "running",
        monitor: {
          id: "monitor-1",
          attach: { mode: "pty", target: "monitor-1" },
          launch: { command: "claude -p hello", cwd: "C:/vault" },
        },
      }
    },
    async read(): Promise<RuntimeReadResult> {
      return { data: "" }
    },
    async stop(): Promise<void> {},
    async snapshot(): Promise<RuntimeSnapshot> {
      return { jobs: [] }
    },
    async openMonitor(): Promise<RuntimeMonitor> {
      return {
        id: "monitor-1",
        attach: { mode: "pty", target: "monitor-1" },
        launch: { command: "claude -p hello", cwd: "C:/vault" },
      }
    },
  }
}

describe("plugin runtime selection seam", () => {
  it("exposes selected runtime info for plugin startup", async () => {
    const selection = createPluginRuntimeSelection({
      platform: "win32",
      createWindowsRuntime: () => createRuntime(),
    })

    const started = await preparePluginRuntimeStart(selection, {
      backend: "claude-code",
      command: "claude -p hello",
    })

    expect(started.kind).toBe("windows-pty")
    expect(started.autoOpenMonitor).toBe(true)
    expect(started.job.id).toBe("job-1")
    expect(started.monitor).toEqual({
      id: "monitor-1",
      attach: { mode: "pty", target: "monitor-1" },
      launch: { command: "claude -p hello", cwd: "C:/vault" },
    })
  })

  it("returns manual-open startup info when auto-open is disabled", async () => {
    const openMonitor = vi.fn(async (): Promise<RuntimeMonitor> => ({
      id: "monitor-1",
      attach: { mode: "pty", target: "monitor-1" },
      launch: { command: "claude -p hello", cwd: "C:/vault" },
    }))
    const runtime: Runtime = {
      async start(): Promise<RuntimeJob> {
        return {
          id: "job-1",
          backend: "claude-code",
          command: "claude -p hello",
          status: "running",
          monitor: {
            id: "monitor-1",
            attach: { mode: "pty", target: "monitor-1" },
            launch: { command: "claude -p hello", cwd: "C:/vault" },
          },
        }
      },
      async read(): Promise<RuntimeReadResult> {
        return { data: "" }
      },
      async stop(): Promise<void> {},
      async snapshot(): Promise<RuntimeSnapshot> {
        return { jobs: [] }
      },
      openMonitor,
    }

    const selection = createPluginRuntimeSelection({
      platform: "win32",
      autoOpenMonitor: false,
      createWindowsRuntime: () => runtime,
    })

    const started = await preparePluginRuntimeStart(selection, {
      backend: "claude-code",
      command: "claude -p hello",
    })

    expect(started.autoOpenMonitor).toBe(false)
    expect(started.monitor).toBeUndefined()
    expect(started.job.monitor.attach).toEqual({ mode: "pty", target: "monitor-1" })
    expect(openMonitor).not.toHaveBeenCalled()
  })
})
