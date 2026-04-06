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

async function loadPlugin() {
  vi.resetModules()

  const outputByJobId = new Map<string, string[]>([
    [
      "claude-job-1",
      [
        "Claude progress 1\n",
        JSON.stringify({
          finalReport: {
            summary: "Claude batch finished",
            changedFiles: ["src/plugin.ts"],
          },
        }),
      ],
    ],
    [
      "codex-job-1",
      [
        "Codex progress 1\n",
        JSON.stringify({
          finalReport: {
            summary: "Codex batch finished",
            changedFiles: ["src/core/store.ts"],
          },
        }),
      ],
    ],
  ])

  const snapshotCalls = new Map<string, number>()
  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => {
      const jobId = backend === "claude-code" ? "claude-job-1" : "codex-job-1"
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `${jobId}-monitor`,
          attach: { mode: "pty" as const, target: `${jobId}-pty` },
          launch: { command: `attached ${jobId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }
    }),
    read: vi.fn(async (jobId: string) => ({
      data: outputByJobId.get(jobId)?.shift() ?? "",
    })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      jobs: ["claude-job-1", "codex-job-1"].map((jobId) => {
        const calls = (snapshotCalls.get(jobId) ?? 0) + 1
        snapshotCalls.set(jobId, calls)

        const backend = jobId.startsWith("claude") ? "claude-code" as const : "codex" as const
        const stopAfter = jobId === "claude-job-1" ? 2 : 4

        return {
          id: jobId,
          backend,
          command: backend === "claude-code"
            ? 'claude --print "watch the monitor"'
            : 'codex "watch the monitor"',
          status: calls >= stopAfter ? "stopped" as const : "running" as const,
          monitor: {
            id: `${jobId}-monitor`,
            attach: { mode: "pty" as const, target: `${jobId}-pty` },
            launch: { command: `attached ${jobId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
          },
        }
      }),
    })),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: `${jobId}-monitor`,
      attach: { mode: "pty" as const, target: `${jobId}-pty` },
      launch: { command: `attached ${jobId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: "windows-pty" as const,
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
      promptAsync: vi.fn(),
    },
    message: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  }
  const plugin = await OmniOpencodePlugin({
    client: client as never,
    directory: uniqueStateDir("batch-resume"),
  } as never)

  return { plugin, client }
}

describe("batch resume aggregation", () => {
  it("groups jobs from one parent turn into one batch", async () => {
    const { plugin, client } = await loadPlugin()

    const claudeLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
    }

    const codexLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
    }

    const claudeSnapshot = JSON.parse(await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: claudeLaunch.jobId },
      makeContext("parent-session-1") as never,
    )) as { batchId?: string }
    const codexSnapshot = JSON.parse(await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: codexLaunch.jobId },
      makeContext("parent-session-1") as never,
    )) as { batchId?: string }

    expect(claudeSnapshot.batchId).toBeTruthy()
    expect(codexSnapshot.batchId).toBe(claudeSnapshot.batchId)
    expect(client.message.create).not.toHaveBeenCalled()
  })
})
