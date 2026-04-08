import { describe, expect, it, vi } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadDelegationPlugin, makeContext } from "./helpers/delegation-plugin-fixture.js"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function writeJobRecord(directory: string, jobId: string, content: Record<string, unknown>) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${encodeURIComponent(jobId)}.json`), JSON.stringify(content, null, 2), "utf-8")
}

async function loadPlugin(runtimeKind: "windows-pty" | "tmux" = "windows-pty") {
  return loadDelegationPlugin({
    runtimeKind,
    stateName: "delegation-tools",
  })
}

async function loadPluginWithoutMessageCreate() {
  return loadDelegationPlugin({
    runtimeKind: "windows-pty",
    includeMessageCreate: false,
    stateName: "delegation-tools-no-message",
  })
}

async function loadWindowsPsmuxPlugin() {
  vi.resetModules()

  let launchCount = 0
  const autoOpenedSessions = new Set<string>()
  const runtime = {
    start: vi.fn(async ({
      backend,
      command,
      monitorSessionId,
    }: {
      backend: "claude-code" | "codex"
      command: string
      monitorSessionId?: string
    }) => {
      launchCount += 1
      const jobId = backend === "claude-code" ? `claude-job-${launchCount}` : `codex-job-${launchCount}`
      const sessionId = monitorSessionId ?? "missing-session"

        return {
          id: jobId,
          backend,
          command,
          status: "running" as const,
          monitor: {
            id: `monitor-${sessionId}`,
            sessionId,
            attach: { mode: "pty" as const, target: `${sessionId}:dashboard`, windowIndex: 0 },
            window: { target: `${sessionId}:job-${jobId}`, index: launchCount },
            attachCommand: `psmux attach -t ${sessionId}`,
            launch: {
              command: `psmux attach -t ${sessionId}`,
              cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
            },
        },
      }
    }),
    read: vi.fn(async () => ({ data: "" })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ jobs: [] })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
      id: `monitor-${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
      sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : undefined,
      attach: { mode: "pty" as const, target: `${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}:dashboard`, windowIndex: 0 },
      window: lookup.type === "job"
        ? { target: `parent-session-1:job-${lookup.jobId}`, index: 2 }
        : { target: `${lookup.monitorSessionId}:dashboard`, index: 0 },
      attachCommand: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
      autoOpenSucceeded: true,
      launch: {
        command: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
        cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      },
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
        monitorSessionId?: string
      }) => {
        const job = await runtime.start(params)
        const monitorSessionId = params.monitorSessionId ?? params.backend
        const monitor = autoOpenedSessions.has(monitorSessionId)
          ? job.monitor
          : await runtime.openMonitor({ type: "shared-session", monitorSessionId })

        autoOpenedSessions.add(monitorSessionId)
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
    directory: uniqueStateDir("delegation-tools-psmux"),
  } as never)

  return { plugin, client, runtime }
}

describe("parent-facing delegation tools", () => {
  it("exposes delegate_to_claude and delegate_to_codex again", async () => {
    const { plugin } = await loadPlugin()

    expect(plugin.tool).toHaveProperty("delegate_to_claude")
    expect(plugin.tool).toHaveProperty("delegate_to_codex")
  })

  it("still loads delegation tools when parent message.create is unavailable", async () => {
    const { plugin } = await loadPluginWithoutMessageCreate()

    expect(plugin.tool).toHaveProperty("delegate_to_claude")
    expect(plugin.tool).toHaveProperty("delegate_to_codex")
    expect(plugin.tool).toHaveProperty("delegated_job_snapshot")
  })

  it("injects system guidance to prefer direct delegation tools over task for Codex and Claude requests", async () => {
    const { plugin } = await loadPlugin()
    const output = { system: [] as string[] }

    await plugin["experimental.chat.system.transform"]?.(
      {
        sessionID: "parent-session-1",
        model: { providerID: "openai", modelID: "gpt-5.4" } as never,
      },
      output,
    )

    expect(output.system.join("\n")).toContain("delegate_to_claude")
    expect(output.system.join("\n")).toContain("delegate_to_codex")
    expect(output.system.join("\n")).toContain("Do not use the built-in task tool")
  })

  it("marks sessions with explicit Codex/Claude delegation requests from chat history", async () => {
    const { plugin } = await loadPlugin()
    const messages = {
      messages: [
        {
          info: { id: "message-1", sessionID: "parent-session-1", role: "user" },
          parts: [
            { type: "text", text: "use your delegation codex and Claude code, do not use your own task tool." },
          ],
        },
      ],
    }

    await plugin["experimental.chat.messages.transform"]?.({}, messages as never)

    const decision = { status: "allow" as const }
    await plugin["permission.ask"]?.(
      {
        id: "perm-1",
        type: "tool.execute",
        sessionID: "parent-session-1",
        messageID: "message-1",
        title: "webfetch",
        metadata: {},
        time: { created: Date.now() },
      } as never,
      decision,
    )

    expect(decision.status).toBe("deny")
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

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude-code",
      command: expect.stringContaining("inspect the vault door"),
      monitorSessionId: "parent-session-1",
    }))
    expect(result).toEqual({
      jobId: "parent-session-1:claude-job-1",
      batchId: "parent-session-1:message-1",
      parentSessionId: "parent-session-1",
      monitorSessionId: "parent-session-1",
      backend: "claude-code",
      status: "running",
      attachCommand: "attached claude-job-1",
      monitorTarget: "claude-job-1-pty",
      autoOpenAttempted: true,
      autoOpenSucceeded: true,
      monitor: {
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

  it("returns a Windows psmux attach command scoped to the parent monitor session", async () => {
    const { plugin, runtime } = await loadWindowsPsmuxPlugin()

    const output = await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1") as never,
    )
    const result = JSON.parse(output) as {
      batchId: string
      jobId: string
      attachCommand: string
      monitorSessionId: string
      monitorTarget: string
      autoOpenSucceeded: boolean
      monitor: {
        attach: { target: string; windowIndex?: number }
      }
    }

    expect(runtime.start).toHaveBeenCalledWith({
      backend: "claude-code",
      command: expect.stringContaining("inspect the vault door"),
      monitorSessionId: "parent-session-1",
    })
    expect(runtime.openMonitor).toHaveBeenCalledTimes(1)
    expect(result.jobId).toBe("parent-session-1:claude-job-1")
    expect(result.batchId).toBe("parent-session-1:message-1")
    expect(result.monitorSessionId).toBe("parent-session-1")
    expect(result.attachCommand).toBe("psmux attach -t parent-session-1")
    expect(result.monitorTarget).toBe("parent-session-1:dashboard")
    expect(result.monitor.attach.windowIndex).toBe(0)
    expect(result.autoOpenSucceeded).toBe(true)
  })

  it("returns the real Windows psmux session attach path when auto-open resolves a durable session", async () => {
    vi.resetModules()

    const runtime = {
      start: vi.fn(async ({ backend, command, monitorSessionId }: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => ({
        id: `${backend}-job-1`,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `bootstrap-${monitorSessionId}`,
          sessionId: monitorSessionId,
          attach: { mode: "pty" as const, target: `${monitorSessionId}:bootstrap` },
          attachCommand: `psmux attach -t ${monitorSessionId}`,
          launch: {
            command: `psmux attach -t ${monitorSessionId}`,
            cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
          },
        },
      })),
      read: vi.fn(async () => ({ data: "" })),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ jobs: [] })),
      openMonitor: vi.fn(async (_lookup: { type: "shared-session"; monitorSessionId: string }) => ({
        id: "monitor-real-session-7",
        sessionId: "real-session-7",
        attach: { mode: "pty" as const, target: "real-session-7:dashboard" },
        attachCommand: "psmux attach -t real-session-7",
        autoOpenSucceeded: true,
        launch: {
          command: "psmux attach -t real-session-7",
          cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
        },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
        runtime,
        autoOpenMonitor: true,
        start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => ({
          job: await runtime.start(params),
          monitor: await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId ?? "missing-session" }),
        }),
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
      directory: uniqueStateDir("delegation-tools-real-session"),
    } as never)

    const output = await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1") as never,
    )
    const result = JSON.parse(output) as {
      attachCommand: string
      monitorSessionId: string
      monitorTarget: string
      autoOpenSucceeded: boolean
    }

    expect(runtime.openMonitor).toHaveBeenCalledWith({ type: "shared-session", monitorSessionId: "parent-session-1" })
    expect(result.monitorSessionId).toBe("real-session-7")
    expect(result.attachCommand).toBe("psmux attach -t real-session-7")
    expect(result.monitorTarget).toBe("real-session-7:dashboard")
    expect(result.autoOpenSucceeded).toBe(true)
  })

  it("reuses the same Windows psmux attach command and shared monitor session for later launches", async () => {
    const { plugin, runtime } = await loadWindowsPsmuxPlugin()

    const firstLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1", "message-1") as never,
    )) as {
      attachCommand: string
      monitorSessionId: string
      monitorTarget: string
      autoOpenSucceeded: boolean
    }

    const secondLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect the reactor" },
      makeContext("parent-session-1", "message-2") as never,
    )) as {
      attachCommand: string
      monitorSessionId: string
      monitorTarget: string
      autoOpenSucceeded: boolean
    }

    expect(secondLaunch.attachCommand).toBe(firstLaunch.attachCommand)
    expect(secondLaunch.monitorSessionId).toBe(firstLaunch.monitorSessionId)
    expect(secondLaunch.monitorTarget).toBe(firstLaunch.monitorTarget)
    expect(firstLaunch.attachCommand).toBe("psmux attach -t parent-session-1")
    expect(firstLaunch.autoOpenSucceeded).toBe(true)
    expect(secondLaunch.autoOpenSucceeded).toBe(false)
    expect(runtime.openMonitor).toHaveBeenCalledTimes(1)
  })

  it("reports a fresh Windows psmux auto-open even when stale running records exist", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("delegation-tools-stale-psmux")
    const stateDir = join(directory, ".broker-state")
    const staleJobId = "parent-session-1:stale-job"
    await writeJobRecord(stateDir, staleJobId, {
      jobId: staleJobId,
      batchId: "parent-session-1:message-stale",
      parentSessionId: "parent-session-1",
      parentMessageId: "message-stale",
      monitorSessionId: "parent-session-1",
      runtimeType: "pty",
      runtimeHandle: "stale-runtime",
      attachTarget: "stale-target",
      attachCommand: "psmux attach -t parent-session-1",
      terminalLogPath: "stale-target",
      backend: "claude-code",
      backendThreadId: "stale-runtime",
      status: "running",
      autoOpenAttempted: true,
      autoOpenSucceeded: false,
    })

    const runtime = {
      start: vi.fn(async ({ backend, command, monitorSessionId }: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => ({
        id: `${backend}-fresh-job`,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `monitor-${monitorSessionId}`,
          sessionId: monitorSessionId,
          attach: { mode: "pty" as const, target: `${monitorSessionId}:dashboard` },
          attachCommand: `psmux attach -t ${monitorSessionId}`,
          launch: {
            command: `psmux attach -t ${monitorSessionId}`,
            cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
          },
        },
      })),
      read: vi.fn(async () => ({ data: "" })),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ jobs: [] })),
      openMonitor: vi.fn(async (lookup: { type: "shared-session"; monitorSessionId: string }) => ({
        id: `monitor-${lookup.monitorSessionId}`,
        sessionId: lookup.monitorSessionId,
        attach: { mode: "pty" as const, target: `${lookup.monitorSessionId}:dashboard` },
        attachCommand: `psmux attach -t ${lookup.monitorSessionId}`,
        autoOpenSucceeded: true,
        launch: {
          command: `psmux attach -t ${lookup.monitorSessionId}`,
          cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
        },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
        runtime,
        autoOpenMonitor: true,
        start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
          const job = await runtime.start(params)
          const monitor = await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId ?? job.id })
          return { job, monitor }
        },
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

    const output = await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1") as never,
    )
    const result = JSON.parse(output) as { autoOpenSucceeded: boolean }

    expect(runtime.openMonitor).toHaveBeenCalledWith({ type: "shared-session", monitorSessionId: "parent-session-1" })
    expect(result.autoOpenSucceeded).toBe(true)
  })

  it("launches directly from the parent session without creating wrapper child sessions", async () => {
    const { plugin, client } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-9") as never,
    )

    expect(client.session.create).not.toHaveBeenCalled()
  })

  it("launches Codex in non-interactive exec mode", async () => {
    const { plugin, runtime } = await loadPlugin()

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "read README.md and answer in one sentence" },
      makeContext("parent-session-2") as never,
    )

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      command: expect.stringMatching(/^codex exec /),
      monitorSessionId: "parent-session-2",
    }))
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
