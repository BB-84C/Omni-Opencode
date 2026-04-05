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
            summary: "Claude monitor completed",
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
            summary: "Codex monitor completed",
            changedFiles: ["README.md"],
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
          launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }
    }),
    read: vi.fn(async (jobId: string) => ({
      data: outputByJobId.get(jobId)?.shift() ?? "",
    })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      jobs: Array.from(outputByJobId.keys()).map((jobId) => {
        const backend = jobId.startsWith("claude") ? "claude-code" as const : "codex" as const
        const calls = (snapshotCalls.get(jobId) ?? 0) + 1
        snapshotCalls.set(jobId, calls)
        return {
          id: jobId,
          backend,
          command: backend === "claude-code"
            ? 'claude --print "watch the monitor"'
            : 'codex "watch the monitor"',
          status: calls >= 2 ? "stopped" as const : "running" as const,
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

  vi.doMock("../../src/runtime/select-runtime.js", () => ({
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

  const { OmniOpencodePlugin } = await import("../../src/plugin.js")
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
    directory: uniqueStateDir("monitor-flow"),
  } as never)

  return { plugin, client, runtime }
}

function parseSnapshot(snapshot: string): {
  transcriptByteLength?: number
  transcriptChunkCount?: number
  status: string
  cleanupState?: string
  cleanupReason?: string
  summary?: string
} {
  return JSON.parse(snapshot) as {
    transcriptByteLength?: number
    transcriptChunkCount?: number
    status: string
    cleanupState?: string
    cleanupReason?: string
    summary?: string
  }
}

describe("monitor flow e2e", () => {
  it("launches both backends, advances transcript capture, reports completion, and records cleanup metadata", async () => {
    const { plugin, client } = await loadPlugin()

    const claudeLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
      monitor: { attach: { target: string } }
    }
    const codexLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
      monitor: { attach: { target: string } }
    }

    expect(claudeLaunch.monitor.attach.target).toBe("claude-job-1-pty")
    expect(codexLaunch.monitor.attach.target).toBe("codex-job-1-pty")

    await vi.waitFor(async () => {
      const claudeSnapshot = parseSnapshot(await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: claudeLaunch.jobId },
        makeContext("parent-session-1") as never,
      ))
      const codexSnapshot = parseSnapshot(await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: codexLaunch.jobId },
        makeContext("parent-session-1") as never,
      ))

      expect(claudeSnapshot.transcriptByteLength).toBeGreaterThan(0)
      expect(codexSnapshot.transcriptByteLength).toBeGreaterThan(0)
      expect(claudeSnapshot.transcriptChunkCount).toBeGreaterThan(0)
      expect(codexSnapshot.transcriptChunkCount).toBeGreaterThan(0)
    })

    await vi.waitFor(() => {
      expect(client.message.create).toHaveBeenCalledTimes(2)
    })

    const parentUpdates = vi.mocked(client.message.create).mock.calls.map(([call]) => call.content)
    expect(parentUpdates.some(content => content.includes(claudeLaunch.jobId) && content.includes("completed"))).toBe(true)
    expect(parentUpdates.some(content => content.includes(codexLaunch.jobId) && content.includes("completed"))).toBe(true)

    const claudeFinal = parseSnapshot(await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: claudeLaunch.jobId },
      makeContext("parent-session-1") as never,
    ))
    const codexFinal = parseSnapshot(await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: codexLaunch.jobId },
      makeContext("parent-session-1") as never,
    ))

    for (const snapshot of [claudeFinal, codexFinal]) {
      expect(snapshot.status).toBe("completed")
      expect(snapshot.cleanupState).toBe("completed")
      expect(snapshot.cleanupReason).toBe("completed")
      expect(snapshot.summary).toBeTruthy()
      expect(snapshot.transcriptByteLength).toBeGreaterThan(0)
      expect(snapshot.transcriptChunkCount).toBeGreaterThan(0)
    }
  })
})
