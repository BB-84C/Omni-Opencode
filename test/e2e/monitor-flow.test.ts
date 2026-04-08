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
          id: "monitor-parent-session-1",
          sessionId: "parent-session-1",
          attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
          attachCommand: "psmux attach -t parent-session-1",
          launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
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
            id: "monitor-parent-session-1",
            sessionId: "parent-session-1",
            attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
            attachCommand: "psmux attach -t parent-session-1",
            launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
          },
        }
      }),
    })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
      id: `monitor-${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
      sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : undefined,
      attach: { mode: "pty" as const, target: `${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}:dashboard` },
      attachCommand: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
      launch: {
        command: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
        cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      },
    })),
  }

  vi.doMock("../../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: "windows-psmux" as const,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
        const job = await runtime.start(params)
        const monitor = await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId ?? "missing-session" })
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
  it("launches both backends, blocks same-turn polling, then injects one aggregate follow-up after the batch completes", async () => {
    const { plugin, client } = await loadPlugin()

    const claudeLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
      batchId: string
      attachCommand: string
      monitor: { attach: { target: string } }
    }
    const codexLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "watch the monitor" },
      makeContext("parent-session-1") as never,
    )) as {
      jobId: string
      batchId: string
      attachCommand: string
      monitor: { attach: { target: string } }
    }

    expect(claudeLaunch.batchId).toBe("parent-session-1:message-1")
    expect(codexLaunch.batchId).toBe(claudeLaunch.batchId)
    expect(claudeLaunch.attachCommand).toBe("psmux attach -t parent-session-1")
    expect(codexLaunch.attachCommand).toBe("psmux attach -t parent-session-1")
    expect(claudeLaunch.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(codexLaunch.monitor.attach.target).toBe("parent-session-1:dashboard")

    const deniedPollingDecision = { status: "allow" as const }
    await plugin["permission.ask"]?.(
      {
        id: "perm-1",
        type: "tool.execute",
        sessionID: "parent-session-1",
        messageID: "message-1",
        title: "delegated_job_snapshot",
        metadata: {},
        time: { created: Date.now() },
      } as never,
      deniedPollingDecision,
    )
    expect(deniedPollingDecision.status).toBe("deny")

    await vi.waitFor(() => {
      expect(client.message.create).toHaveBeenCalledTimes(1)
    })

    const aggregateFollowUp = vi.mocked(client.message.create).mock.calls[0]?.[0]
    expect(aggregateFollowUp).toMatchObject({
      sessionId: "parent-session-1",
      role: "user",
    })
    expect(aggregateFollowUp?.content).toContain("parent-session-1:message-1")
    expect(aggregateFollowUp?.content).toContain(claudeLaunch.jobId)
    expect(aggregateFollowUp?.content).toContain(codexLaunch.jobId)
    expect(aggregateFollowUp?.content).toContain("delegated_job_snapshot")
    expect(aggregateFollowUp?.content).toContain("delegated_job_read")
    expect(aggregateFollowUp?.content).toContain("psmux attach -t parent-session-1")

    await vi.waitFor(async () => {
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
})
