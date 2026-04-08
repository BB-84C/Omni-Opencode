import { describe, expect, it, vi } from "vitest"
import { createTmuxRuntime, type TmuxBackend } from "../src/runtime/tmux-runtime.js"

describe("createTmuxRuntime", () => {
  it("creates one shared tmux session per parent monitor session", async () => {
    const joinSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>()
    const createSessionTarget = { targetId: "omni-parent-session-1:0.0" }
    const readOutput = vi
      .fn<(targetId: string, cursor: string | undefined) => { data: string; cursor?: string; active: boolean }>()
      .mockReturnValueOnce({ data: "booting\n", cursor: "%2", active: true })
      .mockReturnValueOnce({ data: "ready\n", cursor: "%3", active: true })
    const killTarget = vi.fn<(targetId: string) => void>()
    const killSession = vi.fn<(sessionName: string) => void>()
    const createSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>().mockReturnValue(createSessionTarget)
    const backend: TmuxBackend = {
      createSession,
      joinSession,
      readOutput,
      killTarget,
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
      monitorSessionId: "parent-session-1",
    })

    expect(createSession).toHaveBeenCalledWith({
      sessionName: "omni-parent-session-1",
      command: "claude -p hello",
      cwd: "/workspace/project",
    })
    expect(joinSession).not.toHaveBeenCalled()
    expect(job.monitor).toEqual({
      id: "omni-parent-session-1",
      sessionId: "parent-session-1",
      attach: {
        mode: "tmux",
        target: "omni-parent-session-1",
      },
      attachCommand: "tmux attach -t omni-parent-session-1",
      launch: {
        command: "claude -p hello",
        cwd: "/workspace/project",
      },
    })
    expect(await runtime.openMonitor({ type: "job", jobId: job.id })).toEqual(job.monitor)

    expect(await runtime.read(job.id)).toEqual({ data: "booting\n" })
    expect(await runtime.read(job.id)).toEqual({ data: "ready\n" })
    expect(readOutput).toHaveBeenNthCalledWith(1, "omni-parent-session-1:0.0", undefined)
    expect(readOutput).toHaveBeenNthCalledWith(2, "omni-parent-session-1:0.0", "%2")

    await runtime.stop(job.id)

    expect(killTarget).toHaveBeenCalledWith("omni-parent-session-1:0.0")
    expect(killSession).toHaveBeenCalledWith("omni-parent-session-1")
    await expect(runtime.snapshot()).resolves.toEqual({
      jobs: [{ ...job, status: "stopped" }],
    })
  })

  it("reuses the same tmux session and attach command for later jobs in one parent session", async () => {
    const createSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>().mockReturnValue({ targetId: "omni-parent-session-1:0.0" })
    const joinSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>().mockReturnValue({ targetId: "omni-parent-session-1:0.1" })
    const backend: TmuxBackend = {
      createSession,
      joinSession,
      readOutput: vi.fn().mockReturnValue({ data: "", active: true }),
      killTarget: vi.fn(),
      killSession: vi.fn(),
    }

    const runtime = createTmuxRuntime({
      backend,
      cwd: "/workspace/project",
      platform: "linux",
      sessionPrefix: "omni",
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: "claude -p first",
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: "codex exec second",
      monitorSessionId: "parent-session-1",
    })

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenNthCalledWith(1, {
      sessionName: "omni-parent-session-1",
      command: "claude -p first",
      cwd: "/workspace/project",
    })
    expect(joinSession).toHaveBeenCalledTimes(1)
    expect(joinSession).toHaveBeenNthCalledWith(1, {
      sessionName: "omni-parent-session-1",
      command: "codex exec second",
      cwd: "/workspace/project",
    })
    expect(firstJob.id).not.toBe(secondJob.id)
    expect(firstJob.monitor.id).toBe("omni-parent-session-1")
    expect(secondJob.monitor.id).toBe("omni-parent-session-1")
    expect(firstJob.monitor.attach.target).toBe("omni-parent-session-1")
    expect(secondJob.monitor.attach.target).toBe("omni-parent-session-1")
    expect(firstJob.monitor.attachCommand).toBe("tmux attach -t omni-parent-session-1")
    expect(secondJob.monitor.attachCommand).toBe(firstJob.monitor.attachCommand)
    await expect(runtime.openMonitor({ type: "job", jobId: firstJob.id })).resolves.toEqual(firstJob.monitor)
    await expect(runtime.openMonitor({ type: "job", jobId: secondJob.id })).resolves.toEqual(secondJob.monitor)
  })

  it("marks one job stopped while another shared-session job keeps running", async () => {
    const createSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>().mockReturnValue({ targetId: "omni-parent-session-1:0.0" })
    const joinSession = vi.fn<(params: {
      sessionName: string
      command: string
      cwd?: string
    }) => { targetId: string }>().mockReturnValue({ targetId: "omni-parent-session-1:0.1" })
    const readOutput = vi
      .fn<(targetId: string, cursor: string | undefined) => { data: string; cursor?: string; active: boolean }>()
      .mockImplementation((targetId) => targetId === "omni-parent-session-1:0.0"
        ? { data: "first done\n", cursor: "%2", active: false }
        : { data: "second still running\n", cursor: "%7", active: true })
    const backend: TmuxBackend = {
      createSession,
      joinSession,
      readOutput,
      killTarget: vi.fn(),
      killSession: vi.fn(),
    }

    const runtime = createTmuxRuntime({ backend, platform: "linux", sessionPrefix: "omni" })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: "claude -p first",
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: "codex exec second",
      monitorSessionId: "parent-session-1",
    })

    await expect(runtime.read(firstJob.id)).resolves.toEqual({ data: "first done\n" })
    await expect(runtime.read(secondJob.id)).resolves.toEqual({ data: "second still running\n" })
    expect(readOutput).toHaveBeenNthCalledWith(1, "omni-parent-session-1:0.0", undefined)
    expect(readOutput).toHaveBeenNthCalledWith(2, "omni-parent-session-1:0.1", undefined)
    await expect(runtime.snapshot()).resolves.toEqual({
      jobs: [
        {
          ...firstJob,
          status: "stopped",
        },
        secondJob,
      ],
    })
  })

  it("fails clearly on unsupported platforms", () => {
    expect(
      () =>
        createTmuxRuntime({
          backend: {
            createSession() {
              return { targetId: "session:0.0" }
            },
            joinSession() {
              return { targetId: "session:0.1" }
            },
            readOutput() {
              return { data: "", active: true }
            },
            killTarget() {},
            killSession() {},
          },
          platform: "win32",
        }),
    ).toThrow("Tmux runtime requires linux or darwin")
  })

  it("marks jobs stopped when tmux reports the session exited naturally", async () => {
    const backend: TmuxBackend = {
      createSession: vi.fn().mockReturnValue({ targetId: "omni-parent-session-2:0.0" }),
      joinSession: vi.fn().mockReturnValue({ targetId: "omni-parent-session-2:0.1" }),
      readOutput: vi
        .fn<(targetId: string, cursor: string | undefined) => { data: string; cursor?: string; active: boolean }>()
        .mockReturnValueOnce({ data: "partial\n", cursor: "%2", active: true })
        .mockReturnValueOnce({ data: "done\n", cursor: "%3", active: false }),
      killTarget: vi.fn(),
      killSession: vi.fn(),
    }
    const runtime = createTmuxRuntime({ backend, platform: "darwin" })
    const job = await runtime.start({ backend: "codex", command: "codex run", monitorSessionId: "parent-session-2" })

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
