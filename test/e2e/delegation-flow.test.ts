import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(sessionID: string) {
  const permissions = {
    edit: "allow",
    bash: "allow",
    webfetch: "deny",
    task: "deny",
  } as const

  return {
    sessionID,
    messageID: "message-1",
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

async function loadPluginWithCompletedRuntime() {
  vi.resetModules()

  let snapshotCalls = 0
  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => ({
      id: "claude-job-1",
      backend,
      command,
      status: "running" as const,
      monitor: {
        id: "claude-monitor-1",
        attach: { mode: "pty" as const, target: "claude-pty-1" },
        attachCommand: "omni monitor claude-job-1",
        launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      },
    })),
    read: vi.fn(async () => ({
      data: JSON.stringify({
        finalReport: {
          summary: "completed through the PTY runtime monitor",
          changedFiles: ["src/plugin.ts", "README.md"],
        },
      }),
    })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => {
      snapshotCalls += 1
      return {
        jobs: [{
          id: "claude-job-1",
          backend: "claude-code" as const,
          command: 'claude --print "implement the feature"',
          status: snapshotCalls >= 2 ? "stopped" as const : "running" as const,
          monitor: {
            id: "claude-monitor-1",
            attach: { mode: "pty" as const, target: "claude-pty-1" },
            attachCommand: "omni monitor claude-job-1",
            launch: { command: "attached claude-job-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
          },
        }],
      }
    }),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: `${jobId}-monitor`,
      attach: { mode: "pty" as const, target: `${jobId}-pty` },
      attachCommand: `omni monitor ${jobId}`,
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
  const messageCreate = vi.fn().mockResolvedValue(undefined)
  const plugin = await OmniOpencodePlugin({
    client: {
      message: {
        create: messageCreate,
      },
    },
    directory: uniqueStateDir("delegation-flow-regression"),
  } as never)

  return { plugin, messageCreate, runtime }
}

describe("delegation flow e2e", () => {
  it("PTY regression: parent-facing delegation completes without wrapper subagents, session.idle, or same-session projection", async () => {
    const { plugin, messageCreate, runtime } = await loadPluginWithCompletedRuntime()

    expect(plugin.config).toBeUndefined()
    expect(plugin.tool).toHaveProperty("delegate_to_claude")
    const delegateTool = plugin.tool!.delegate_to_claude
    if (!delegateTool) {
      throw new Error("expected parent-facing delegate_to_claude tool")
    }

    const launchResult = await delegateTool.execute(
      { prompt: "implement the feature" },
      makeContext("parent-session-1") as never,
    )

    expect(JSON.parse(launchResult)).toEqual(expect.objectContaining({
      jobId: "parent-session-1:claude-job-1",
      batchId: "parent-session-1:message-1",
      parentSessionId: "parent-session-1",
      backend: "claude-code",
      status: "running",
      attachCommand: "omni monitor claude-job-1",
    }))
    expect(runtime.openMonitor).toHaveBeenCalledWith("claude-job-1")

    await vi.waitFor(() => {
      expect(messageCreate).toHaveBeenCalledWith({
        sessionId: "parent-session-1",
        role: "user",
        content: expect.stringContaining("1 delegated job(s) finished."),
      })
    })

    const followUp = vi.mocked(messageCreate).mock.calls[0]?.[0]?.content
    expect(followUp).toContain("parent-session-1:claude-job-1")
    expect(followUp).toContain("[claude-code] completed")
    expect(followUp).toContain("delegated_job_snapshot")
    expect(followUp).toContain("delegated_job_read")
    expect(followUp).toContain("delegated_job_attach")

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"runtimeType": "pty"')
    expect(snapshot).not.toContain('"childSessionId"')
  })
})
