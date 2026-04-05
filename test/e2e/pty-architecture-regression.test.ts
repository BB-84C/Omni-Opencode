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

  const codexAdapter = {
    startJob: vi.fn().mockResolvedValue({ id: "job-1", childSessionId: "parent-session-1" }),
    resumeJob: vi.fn(),
    cancelJob: vi.fn(),
    async *subscribeEvents() {},
    getSnapshot: vi.fn().mockResolvedValue({
      id: "job-1",
      childSessionId: "parent-session-1",
      status: "running",
      changedFiles: [],
      lastEventSeq: 0,
    }),
  }

  vi.doMock("../../src/adapters/claude-client.js", () => ({
    createClaudeClient: () => ({ abort() {}, async *run() {} }),
  }))
  vi.doMock("../../src/adapters/claude-adapter.js", () => ({
    createClaudeAdapter: () => ({
      startJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      subscribeEvents: vi.fn(),
      getSnapshot: vi.fn(),
    }),
  }))
  vi.doMock("../../src/adapters/codex-client.js", () => ({
    createCodexClient: () => ({ close() {}, startThread: vi.fn(), cancelThread: vi.fn(), subscribeNotifications: vi.fn() }),
  }))
  vi.doMock("../../src/adapters/codex-adapter.js", () => ({
    createCodexAdapter: () => codexAdapter,
  }))

  const { OmniOpencodePlugin } = await import("../../src/plugin.js")
  const plugin = await OmniOpencodePlugin({
    client: {
      message: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    },
    directory: uniqueStateDir("pty-architecture-regression"),
  } as never)

  return { plugin, codexAdapter }
}

async function startDelegationForMonitoring(plugin: Awaited<ReturnType<typeof loadPlugin>>["plugin"]) {
  const startTool = plugin.tool?.delegate_to_codex

  expect(plugin.tool).toHaveProperty("delegate_to_codex")
  if (!startTool) {
    throw new Error("expected parent-facing delegate_to_codex entrypoint to seed monitoring")
  }

  await startTool.execute(
    { prompt: "observe this job" },
    makeContext("parent-session-1") as never,
  )
}

describe("PTY architecture regressions", () => {
  it("exposes delegation as parent-facing tools without requiring config-injected subagent entrypoints", async () => {
    const { plugin } = await loadPlugin()

    expect(plugin.config).toBeUndefined()
    expect(plugin.tool).toHaveProperty("delegate_to_claude")
    expect(plugin.tool).toHaveProperty("delegate_to_codex")
  })

  it("lists parent-facing jobs using a composite parent-session plus job identifier", async () => {
    const { plugin } = await loadPlugin()
    await startDelegationForMonitoring(plugin)

    const output = await plugin.tool!.delegated_jobs_list.execute({}, makeContext("parent-session-1") as never)

    expect(output).toContain("parent-session-1:")
  })

  it("looks up monitoring telemetry by the composite parent-session plus job identifier", async () => {
    const { plugin } = await loadPlugin()
    await startDelegationForMonitoring(plugin)

    const output = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(output).not.toContain("No job found")
    expect(output).toContain("parent-session-1:")
  })
})
