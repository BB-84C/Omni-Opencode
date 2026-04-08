import { describe, expect, it, vi } from "vitest"
import { selectRuntime } from "../src/runtime/select-runtime.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeReadResult, RuntimeSnapshot } from "../src/runtime/types.js"

function createStubRuntime(mode: "pty" | "tmux"): Runtime {
  return {
    async start(): Promise<RuntimeJob> {
      return {
        id: `job-${mode}`,
        backend: "codex",
        command: "codex run",
        status: "running",
        monitor: {
          id: `monitor-${mode}`,
          attach: { mode, target: `target-${mode}` },
          launch: { command: "codex run" },
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
        id: `monitor-${mode}`,
        attach: { mode, target: `target-${mode}` },
        launch: { command: "codex run" },
      }
    },
  }
}

describe("selectRuntime", () => {
  it("selects the Windows psmux runtime on win32 while preserving the injected Windows runtime seam", () => {
    const createWindowsRuntime = vi.fn(() => createStubRuntime("pty"))
    const createTmuxRuntime = vi.fn(() => createStubRuntime("tmux"))

    const selected = selectRuntime({
      platform: "win32",
      createWindowsRuntime,
      createTmuxRuntime,
    })

    expect(selected.kind).toBe("windows-psmux")
    expect(selected.autoOpenMonitor).toBe(true)
    expect(createWindowsRuntime).toHaveBeenCalledOnce()
    expect(createTmuxRuntime).not.toHaveBeenCalled()
  })

  it("selects the tmux runtime on linux and darwin", () => {
    const createWindowsRuntime = vi.fn(() => createStubRuntime("pty"))
    const createTmuxRuntime = vi.fn(() => createStubRuntime("tmux"))

    const linux = selectRuntime({
      platform: "linux",
      createWindowsRuntime,
      createTmuxRuntime,
    })
    const darwin = selectRuntime({
      platform: "darwin",
      createWindowsRuntime,
      createTmuxRuntime,
    })

    expect(linux.kind).toBe("tmux")
    expect(darwin.kind).toBe("tmux")
    expect(createTmuxRuntime).toHaveBeenCalledTimes(2)
    expect(createWindowsRuntime).not.toHaveBeenCalled()
  })

  it("defaults auto-open monitor to enabled", () => {
    const selected = selectRuntime({
      platform: "linux",
      createWindowsRuntime: () => createStubRuntime("pty"),
      createTmuxRuntime: () => createStubRuntime("tmux"),
    })

    expect(selected.autoOpenMonitor).toBe(true)
  })

  it("does not auto-open the monitor when disabled", async () => {
    const runtime: Runtime = {
      async start(): Promise<RuntimeJob> {
        return {
          id: "job-manual",
          backend: "codex",
          command: "codex run",
          status: "running",
          monitor: {
            id: "monitor-manual",
            attach: { mode: "tmux", target: "target-manual" },
            launch: { command: "codex run" },
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
      openMonitor: vi.fn(async (): Promise<RuntimeMonitor> => ({
        id: "monitor-manual",
        attach: { mode: "tmux", target: "target-manual" },
        launch: { command: "codex run" },
      })),
    }

    const selected = selectRuntime({
      platform: "linux",
      autoOpenMonitor: false,
      createTmuxRuntime: () => runtime,
    })

    const result = await selected.start({ backend: "codex", command: "codex run" })

    expect(result.job.monitor).toEqual({
      id: "monitor-manual",
      attach: { mode: "tmux", target: "target-manual" },
      launch: { command: "codex run" },
    })
    expect(result.monitor).toBeUndefined()
    expect(runtime.openMonitor).not.toHaveBeenCalled()
  })

  it("always returns attach command and monitor metadata from the selected runtime seam", async () => {
    const runtime = createStubRuntime("tmux")
    const selected = selectRuntime({
      platform: "linux",
      createWindowsRuntime: () => createStubRuntime("pty"),
      createTmuxRuntime: () => runtime,
    })

    const { job, monitor } = await selected.start({ backend: "codex", command: "codex run" })

    expect(job.monitor).toEqual(monitor)
    expect(monitor.attach).toEqual({
      mode: "tmux",
      target: "target-tmux",
    })
    expect(monitor.launch).toEqual({
      command: "codex run",
    })
  })
})
