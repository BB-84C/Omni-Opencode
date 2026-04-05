import { describe, expect, it, vi } from "vitest"
import { createTmuxRuntime, type TmuxBackend } from "../src/runtime/tmux-runtime.js"

describe("createTmuxRuntime", () => {
  it("creates named tmux sessions and exposes stable monitor metadata", async () => {
    const createSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => void>()
    const readOutput = vi
      .fn<(sessionName: string, cursor: string | undefined) => { data: string; cursor?: string; active: boolean }>()
      .mockReturnValueOnce({ data: "booting\n", cursor: "%2", active: true })
      .mockReturnValueOnce({ data: "ready\n", cursor: "%3", active: true })
    const killSession = vi.fn<(sessionName: string) => void>()
    const backend: TmuxBackend = {
      createSession,
      readOutput,
      killSession,
    }

    const runtime = createTmuxRuntime({
      backend,
      cwd: "/workspace/project",
      platform: "linux",
      sessionPrefix: "omni",
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: "claude -p hello",
    })

    expect(createSession).toHaveBeenCalledWith({
      sessionName: "omni-claude-code-1",
      command: "claude -p hello",
      cwd: "/workspace/project",
    })
    expect(job.monitor).toEqual({
      id: "omni-claude-code-1",
      attach: {
        mode: "tmux",
        target: "omni-claude-code-1",
      },
      launch: {
        command: "claude -p hello",
        cwd: "/workspace/project",
      },
    })
    expect(await runtime.openMonitor(job.id)).toEqual(job.monitor)

    expect(await runtime.read(job.id)).toEqual({ data: "booting\n" })
    expect(await runtime.read(job.id)).toEqual({ data: "ready\n" })

    await runtime.stop(job.id)

    expect(killSession).toHaveBeenCalledWith("omni-claude-code-1")
    await expect(runtime.snapshot()).resolves.toEqual({
      jobs: [{ ...job, status: "stopped" }],
    })
  })

  it("fails clearly on unsupported platforms", () => {
    expect(
      () =>
        createTmuxRuntime({
          backend: {
            createSession() {},
            readOutput() {
              return { data: "", active: true }
            },
            killSession() {},
          },
          platform: "win32",
        }),
    ).toThrow("Tmux runtime requires linux or darwin")
  })

  it("marks jobs stopped when tmux reports the session exited naturally", async () => {
    const backend: TmuxBackend = {
      createSession: vi.fn(),
      readOutput: vi
        .fn<(sessionName: string, cursor: string | undefined) => { data: string; cursor?: string; active: boolean }>()
        .mockReturnValueOnce({ data: "partial\n", cursor: "%2", active: true })
        .mockReturnValueOnce({ data: "done\n", cursor: "%3", active: false }),
      killSession: vi.fn(),
    }
    const runtime = createTmuxRuntime({ backend, platform: "darwin" })
    const job = await runtime.start({ backend: "codex", command: "codex run" })

    await expect(runtime.read(job.id)).resolves.toEqual({ data: "partial\n" })
    await expect(runtime.read(job.id)).resolves.toEqual({ data: "done\n" })
    await expect(runtime.snapshot()).resolves.toEqual({
      jobs: [
        {
          ...job,
          status: "stopped",
        },
      ],
    })
  })
})
