import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(sessionID: string, messageID = "message-1") {
  return {
    sessionID,
    messageID,
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

  let phase = 1
  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => {
      const jobId = backend === "claude-code" ? "claude-job-1" : "codex-job-1"
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: "monitor-parent-session-1",
          sessionId: "parent-session-1",
          attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
          attachCommand: "psmux attach -t parent-session-1",
          transcriptCaptureTarget: `D:/Omni-Opencode/.omni-monitors/${jobId}.log`,
          launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }
    }),
    read: vi.fn(async (jobId: string) => ({
      data: outputByJobId.get(jobId)?.shift() ?? "",
    })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      jobs: ["claude-job-1", "codex-job-1"].map((jobId) => {
        const backend = jobId.startsWith("claude") ? "claude-code" as const : "codex" as const
        const stopped = phase >= 2 && jobId === "claude-job-1"
          ? true
          : phase >= 3 && jobId === "codex-job-1"
        return {
          id: jobId,
          backend,
          command: backend === "claude-code"
            ? 'claude --print "watch the monitor"'
            : 'codex "watch the monitor"',
          status: stopped ? "stopped" as const : "running" as const,
          monitor: {
            id: "monitor-parent-session-1",
            sessionId: "parent-session-1",
            attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
            attachCommand: "psmux attach -t parent-session-1",
            transcriptCaptureTarget: `D:/Omni-Opencode/.omni-monitors/${jobId}.log`,
            launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
          },
        }
      }),
    })),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: "monitor-parent-session-1",
      sessionId: "parent-session-1",
      attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
      attachCommand: "psmux attach -t parent-session-1",
      transcriptCaptureTarget: `D:/Omni-Opencode/.omni-monitors/${jobId}.log`,
      launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: "windows-psmux" as const,
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

  return {
    plugin,
    client,
    advanceToPhase(nextPhase: number) {
      phase = nextPhase
    },
  }
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
    expect(claudeSnapshot.batchId).toBe("parent-session-1:message-1")
    expect(client.message.create).not.toHaveBeenCalled()
  })

  it("emits one aggregate user follow-up only after the whole batch finishes", async () => {
    const { plugin, client, advanceToPhase } = await loadPlugin()

    const claudeLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1", "message-1") as never,
    )) as { jobId: string }

    const codexLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1", "message-1") as never,
    )) as { jobId: string }

    advanceToPhase(2)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(client.message.create).not.toHaveBeenCalled()

    advanceToPhase(3)
    await vi.waitFor(() => {
      expect(client.message.create).toHaveBeenCalledTimes(1)
    })

    const aggregate = vi.mocked(client.message.create).mock.calls[0]?.[0]
    expect(aggregate).toMatchObject({
      sessionId: "parent-session-1",
      role: "user",
    })
    expect(aggregate?.content).toContain("parent-session-1:message-1")
    expect(aggregate?.content).toContain(claudeLaunch.jobId)
    expect(aggregate?.content).toContain(codexLaunch.jobId)
    expect(aggregate?.content).toContain("delegated_job_snapshot")
    expect(aggregate?.content).toContain("delegated_job_read")
    expect(aggregate?.content).toContain("delegated_job_attach")
    expect(aggregate?.content).toContain("psmux attach -t parent-session-1")
  })
})
