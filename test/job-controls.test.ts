import { describe, expect, it, vi } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

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

async function loadPlugin(runtimeKind: "windows-pty" | "tmux" = "tmux") {
  vi.resetModules()

  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => ({
      id: backend === "claude-code" ? "claude-job-1" : "codex-job-1",
      backend,
      command,
      status: "running" as const,
      monitor: {
        id: `${backend}-monitor-1`,
        attach: { mode: runtimeKind === "tmux" ? "tmux" as const : "pty" as const, target: `${backend}-target-1` },
        launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      },
    })),
    read: vi.fn(async (jobId: string) => ({ data: `fresh output from ${jobId}` })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      jobs: [{
        id: "codex-job-1",
        backend: "codex" as const,
        command: 'codex "repair the reactor"',
        status: "running" as const,
        monitor: {
          id: "codex-monitor-1",
          attach: { mode: runtimeKind === "tmux" ? "tmux" as const : "pty" as const, target: "codex-target-1" },
          launch: { command: 'codex "repair the reactor"', cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }],
    })),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: `${jobId}-monitor`,
      attach: { mode: runtimeKind === "tmux" ? "tmux" as const : "pty" as const, target: `${jobId}-target` },
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
    directory: uniqueStateDir("job-controls"),
  } as never)

  return { plugin, runtime }
}

async function writeJobRecord(directory: string, jobId: string, content: Record<string, unknown>) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${encodeURIComponent(jobId)}.json`), JSON.stringify(content, null, 2), "utf-8")
}

describe("PTY job controls", () => {
  it("reads delegated job output from the runtime", async () => {
    const { plugin, runtime } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-1") as never,
    )

    const output = await plugin.tool!.delegated_job_read.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(runtime.read).toHaveBeenCalledWith("codex-job-1")
    expect(output).toBe("fresh output from codex-job-1")
  })

  it("returns attach metadata for a delegated job", async () => {
    const { plugin, runtime } = await loadPlugin("tmux")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-1") as never,
    )

    const output = await plugin.tool!.delegated_job_attach.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(runtime.openMonitor).toHaveBeenLastCalledWith("codex-job-1")
    expect(output).toContain('"jobId": "parent-session-1:codex-job-1"')
    expect(output).toContain('"runtimeType": "tmux"')
    expect(output).toContain('"target": "codex-job-1-target"')
    expect(output).toContain('"command": "attached codex-job-1"')
  })

  it("refreshes attach metadata for overlay-backed final job records", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-overlay")
    const stateDir = join(directory, ".broker-state")
    const overlayDir = join(stateDir, "final-state-overlay")
    const jobId = "parent-session-1:codex-job-1"
    const staleRecord = {
      jobId,
      parentSessionId: "parent-session-1",
      runtimeType: "tmux",
      runtimeHandle: "codex-job-1",
      attachTarget: "stale-target",
      terminalLogPath: "stale-target",
      backend: "codex",
      backendThreadId: "codex-job-1",
      status: "completed",
      cleanupState: "completed",
      cleanupReason: "completed",
      cleanupUpdatedAt: 1700000000000,
    }

    await writeJobRecord(stateDir, jobId, staleRecord)
    await writeJobRecord(overlayDir, jobId, staleRecord)

    const runtime = {
      start: vi.fn(),
      read: vi.fn(async () => ({ data: "" })),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ jobs: [] })),
      openMonitor: vi.fn(async (runtimeJobId: string) => ({
        id: `${runtimeJobId}-monitor`,
        attach: { mode: "tmux" as const, target: `${runtimeJobId}-fresh-target` },
        launch: { command: `attached ${runtimeJobId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "tmux" as const,
        runtime,
        autoOpenMonitor: true,
        start: vi.fn(),
      }),
    }))

    const { OmniOpencodePlugin } = await import("../src/plugin.js")
    const plugin = await OmniOpencodePlugin({
      client: {
        session: {
          create: vi.fn(),
          promptAsync: vi.fn().mockResolvedValue(undefined),
        },
        message: {
          create: vi.fn().mockResolvedValue(undefined),
        },
      } as never,
      directory,
    } as never)

    await plugin.tool!.delegated_job_attach.execute(
      { jobId },
      makeContext("parent-session-1") as never,
    )

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId },
      makeContext("parent-session-1") as never,
    )
    const listedJobs = await plugin.tool!.delegated_jobs_list.execute(
      {},
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"attachTarget": "codex-job-1-fresh-target"')
    expect(snapshot).toContain('"terminalLogPath": "codex-job-1-fresh-target"')
    expect(listedJobs).not.toContain("stale-target")
  })

  it("tracks cleanup metadata when a delegated job is cancelled", async () => {
    const { plugin } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-1") as never,
    )

    await plugin.tool!.delegated_job_cancel.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )
    const list = await plugin.tool!.delegated_jobs_list.execute(
      {},
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "interrupted"')
    expect(snapshot).toContain('"cleanupState": "completed"')
    expect(snapshot).toContain('"cleanupReason": "cancelled"')
    expect(snapshot).toContain('"cleanupUpdatedAt":')
    expect(list).toContain("cleanup=completed/cancelled")
  })
})
