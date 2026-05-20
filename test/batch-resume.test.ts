import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(sessionID: string, messageID = "message-1") {
  const permissions = {
    edit: "allow",
    bash: "allow",
    webfetch: "deny",
    task: "deny",
  } as const

  return {
    sessionID,
    messageID,
    agent: "test-agent",
    permissions,
    authoritativeDelegationPermissions: {
      permissions,
    },
    directory: "D:/Omni-Opencode/.worktrees/pty-monitor",
    worktree: "D:/Omni-Opencode/.worktrees/pty-monitor",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }
}

async function writeJobRecord(directory: string, jobId: string, content: Record<string, unknown>) {
  await mkdir(join(directory, ".broker-state"), { recursive: true })
  await writeFile(join(directory, ".broker-state", `${encodeURIComponent(jobId)}.json`), JSON.stringify(content, null, 2), "utf-8")
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

async function loadResumePlugin() {
  vi.resetModules()

  let codexLaunchCount = 0
  const jobStates = new Map<string, {
    backend: "claude-code" | "codex"
    command: string
    status: "running" | "stopped"
  }>()
  const outputByJobId = new Map<string, string[]>([
    [
      "codex-job-1",
      [JSON.stringify({
        finalReport: {
          summary: "Initial codex batch finished",
          changedFiles: ["src/plugin.ts"],
        },
      })],
    ],
    [
      "codex-job-2",
      [JSON.stringify({
        finalReport: {
          summary: "Resumed codex batch finished",
          changedFiles: ["src/plugin.ts"],
        },
      })],
    ],
  ])

  const runtime = {
    start: vi.fn(async ({
      backend,
      command,
      backendSessionId,
      backendResumeSessionId,
    }: {
      backend: "claude-code" | "codex"
      command: string
      backendSessionId?: string
      backendResumeSessionId?: string
    }) => {
      codexLaunchCount += 1
      const jobId = `codex-job-${codexLaunchCount}`
      jobStates.set(jobId, { backend, command, status: "running" })
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        backendSessionId: backendSessionId ?? `codex-session-${codexLaunchCount}`,
        backendResumeSessionId: backendResumeSessionId ?? `codex-resume-${codexLaunchCount}`,
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
      jobs: Array.from(jobStates.entries()).map(([jobId, state]) => ({
        id: jobId,
        backend: state.backend,
        command: state.command,
        status: state.status,
        monitor: {
          id: "monitor-parent-session-1",
          sessionId: "parent-session-1",
          attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
          attachCommand: "psmux attach -t parent-session-1",
          transcriptCaptureTarget: `D:/Omni-Opencode/.omni-monitors/${jobId}.log`,
          launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      })),
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
      start: async (params: {
        backend: "claude-code" | "codex"
        command: string
        backendSessionId?: string
        backendResumeSessionId?: string
      }) => {
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
    directory: uniqueStateDir("batch-resume-strict"),
  } as never)

  return {
    plugin,
    runtime,
    stopJob(jobId: string) {
      const job = jobStates.get(jobId)
      if (job) {
        job.status = "stopped"
      }
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
    }, { timeout: 5000 })

    const aggregate = vi.mocked(client.message.create).mock.calls[0]?.[0]
    expect(aggregate).toMatchObject({
      sessionId: "parent-session-1",
      role: "user",
    })
    expect(aggregate?.content).toContain("2 delegated job(s) finished.")
    expect(aggregate?.content).toContain(claudeLaunch.jobId)
    expect(aggregate?.content).toContain(codexLaunch.jobId)
    expect(aggregate?.content).toContain(`[claude-code] completed`)
    expect(aggregate?.content).toContain(`[codex] completed`)
    expect(aggregate?.content).toContain("delegated_job_snapshot")
    expect(aggregate?.content).toContain("delegated_job_read")
    expect(aggregate?.content).toContain("delegated_job_attach")
  })

  it("creates a new linked resume job that reuses stored controls when overrides are omitted", async () => {
    const { plugin, runtime, stopJob } = await loadResumePlugin()

    const source = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "watch the monitor", model: "gpt-5-codex", reasoningEffort: "high" },
      makeContext("parent-session-1", "message-1") as never,
    )) as { jobId: string }

    stopJob("codex-job-1")
    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: source.jobId },
        makeContext("parent-session-1", "message-1") as never,
      )

      expect(snapshot).toContain('"status": "completed"')
    })

    const resumed = JSON.parse(await plugin.tool!.delegated_job_resume.execute(
      { jobId: source.jobId, prompt: "continue with more detail" },
      makeContext("parent-session-1", "message-2") as never,
    )) as {
      jobId: string
      batchId: string
      resumedFromJobId: string
      rootJobId: string
      requestedModel: string
      requestedReasoningEffort: string
    }

    const resumeLaunch = vi.mocked(runtime.start).mock.calls[1]?.[0] as {
      backendResumeSessionId?: string
      launchMetadata?: { prompt?: string; requestedModel?: string; requestedReasoningEffort?: string }
    }

    expect(resumed.resumedFromJobId).toBe(source.jobId)
    expect(resumed.rootJobId).toBe(source.jobId)
    expect(resumed.batchId).toBe("parent-session-1:message-2")
    expect(resumed.requestedModel).toBe("gpt-5-codex")
    expect(resumed.requestedReasoningEffort).toBe("high")
    expect(resumeLaunch.backendResumeSessionId).toBe("codex-resume-1")
    expect(resumeLaunch.launchMetadata?.prompt).toContain("continue with more detail")
    expect(resumeLaunch.launchMetadata?.requestedModel).toBe("gpt-5-codex")
    expect(resumeLaunch.launchMetadata?.requestedReasoningEffort).toBe("high")
  })

  it("fails strict resume when the source job has no stored backend resume identity", async () => {
    const directory = uniqueStateDir("batch-resume-missing-identity")

    await writeJobRecord(directory, "parent-session-1:codex-job-404", {
      jobId: "parent-session-1:codex-job-404",
      batchId: "parent-session-1:message-1",
      parentSessionId: "parent-session-1",
      parentMessageId: "message-1",
      runtimeType: "pty",
      runtimeHandle: "codex-job-404",
      attachTarget: "parent-session-1:dashboard",
      terminalLogPath: "D:/Omni-Opencode/.omni-monitors/codex-job-404.log",
      status: "completed",
      backend: "codex",
      backendThreadId: "codex-job-404",
      effectiveModel: "default",
      effectiveReasoningEffort: "default",
    })

    vi.resetModules()
    const { OmniOpencodePlugin } = await import("../src/plugin.js")
    const plugin = await OmniOpencodePlugin({
      client: {
        session: { create: vi.fn(), promptAsync: vi.fn() },
        message: { create: vi.fn().mockResolvedValue(undefined) },
      } as never,
      directory,
    } as never)

    await expect(plugin.tool!.delegated_job_resume.execute(
      { jobId: "parent-session-1:codex-job-404", prompt: "continue" },
      makeContext("parent-session-1", "message-2") as never,
    )).rejects.toThrow(/resume/i)
  })
})
