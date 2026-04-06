import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(sessionID: string) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "test-agent",
    directory: "D:/Omni-Opencode/.worktrees/pty-monitor",
    worktree: "D:/Omni-Opencode/.worktrees/pty-monitor",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }
}

async function loadPlugin(runtimeKind: "windows-pty" | "tmux" = "windows-pty") {
  vi.resetModules()

  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => ({
      id: backend === "claude-code" ? "claude-job-1" : "codex-job-1",
      backend,
      command,
      status: "running" as const,
      monitor: {
        id: `${backend}-monitor-1`,
        attach: { mode: "pty" as const, target: `${backend}-pty-1` },
        launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      },
    })),
    read: vi.fn(async () => ({ data: "" })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ jobs: [] })),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: `${jobId}-monitor`,
      attach: { mode: "pty" as const, target: `${jobId}-pty` },
      launch: { command: `attached ${jobId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: runtimeKind,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string }) => {
        const job = await runtime.start(params)
        const monitor = await runtime.openMonitor(job.id)
        return { job, monitor }
      },
    }),
  }))

  const { OmniOpencodePlugin } = await import("../src/plugin.js")
  const client = {
    session: {
      create: vi.fn(),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    message: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  }
  const plugin = await OmniOpencodePlugin({
    client: client as never,
    directory: uniqueStateDir("delegation-tools"),
  } as never)

  return { plugin, client, runtime }
}

describe("parent-facing delegation tools", () => {
  it("exposes delegate_to_claude and delegate_to_codex again", async () => {
    const { plugin } = await loadPlugin()

    expect(plugin.tool).toHaveProperty("delegate_to_claude")
    expect(plugin.tool).toHaveProperty("delegate_to_codex")
  })

  it("keys launched jobs on the parent session id and returns monitor metadata immediately", async () => {
    const { plugin, runtime } = await loadPlugin("tmux")

    const output = await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1") as never,
    )
    const result = JSON.parse(output) as {
      jobId: string
      batchId: string
      parentSessionId: string
      backend: string
      status: string
      attachCommand: string
      monitorTarget: string
      autoOpenAttempted: boolean
      autoOpenSucceeded: boolean
      monitor: {
        id: string
        attach: { mode: string; target: string }
        launch: { command: string; cwd: string }
      }
    }

    expect(runtime.start).toHaveBeenCalledWith({
      backend: "claude-code",
      command: expect.stringContaining("inspect the vault door"),
    })
    expect(result).toEqual({
      jobId: "parent-session-1:claude-job-1",
      parentSessionId: "parent-session-1",
      batchId: "parent-session-1",
      backend: "claude-code",
      status: "running",
      monitor: {
      attachCommand: "attached claude-job-1",
      monitorTarget: "claude-job-1-pty",
      autoOpenAttempted: true,
      autoOpenSucceeded: true,
        id: "claude-job-1-monitor",
        attach: { mode: "pty", target: "claude-job-1-pty" },
        launch: {
          command: "attached claude-job-1",
          cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
        },
      },
    })

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"jobId": "parent-session-1:claude-job-1"')
    expect(snapshot).toContain('"parentSessionId": "parent-session-1"')
    expect(snapshot).toContain('"runtimeType": "tmux"')
    expect(snapshot).not.toContain('"childSessionId"')
  })

  it("launches directly from the parent session without creating wrapper child sessions", async () => {
    const { plugin, client } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-9") as never,
    )

    expect(client.session.create).not.toHaveBeenCalled()
  })

  it("uses delegated job id terminology for cancel lookups and responses", async () => {
    const { plugin, runtime } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-9") as never,
    )

    const cancelResult = await plugin.tool!.delegated_job_cancel.execute(
      { jobId: "parent-session-9:codex-job-1" },
      makeContext("parent-session-9") as never,
    )

    expect(runtime.stop).toHaveBeenCalledWith("codex-job-1")
    expect(cancelResult).toBe("Cancelled delegated job parent-session-9:codex-job-1")
  })
})
