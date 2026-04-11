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

async function loadPluginAtDirectory(directory: string, runtimeKind: "windows-psmux" | "windows-pty" | "tmux" = "windows-pty") {
  vi.resetModules()

  let launchCount = 0
  const runtime = {
    start: vi.fn(async ({ backend, command, monitorSessionId }: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
      launchCount += 1
      const jobId = backend === "claude-code" ? `claude-job-${launchCount}` : `codex-job-${launchCount}`
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `${jobId}-monitor`,
          sessionId: runtimeKind === "windows-psmux" ? (monitorSessionId ?? jobId) : undefined,
          attach: runtimeKind === "windows-psmux"
            ? { mode: "pty" as const, target: `${monitorSessionId ?? jobId}:dashboard` }
            : { mode: "pty" as const, target: `${jobId}-pty` },
          attachCommand: runtimeKind === "windows-psmux" ? `psmux attach -t ${monitorSessionId ?? jobId}` : undefined,
          launch: {
            command: runtimeKind === "windows-psmux" ? `psmux attach -t ${monitorSessionId ?? jobId}` : command,
            cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
          },
        },
      }
    }),
    read: vi.fn(async () => ({ data: "" })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ jobs: [] })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
      id: `${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}-monitor`,
      sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : undefined,
      attach: lookup.type === "shared-session"
        ? { mode: "pty" as const, target: `${lookup.monitorSessionId}:dashboard` }
        : { mode: "pty" as const, target: `${lookup.jobId}-pty` },
      attachCommand: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : undefined,
      launch: {
        command: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : `attached ${lookup.jobId}`,
        cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: runtimeKind,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
        const job = await runtime.start(params)
        const monitor = runtimeKind === "windows-psmux" && params.monitorSessionId
          ? await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId })
          : await runtime.openMonitor({ type: "job", jobId: job.id })
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
    directory,
  } as never)

  return { plugin, client, runtime }
}

type MockDelegationEnvelope = {
  capabilities: {
    workspaceWrite: "allow" | "ask" | "deny"
    shell: "allow" | "ask" | "deny"
    network: "allow" | "ask" | "deny"
    subagentLaunch: "allow" | "ask" | "deny"
    allowedRoots: string[]
  }
  fingerprint: string
}

async function loadPluginWithMockedDelegationEnvelope(
  directory: string,
  envelope: MockDelegationEnvelope,
  runtimeKind: "windows-psmux" | "windows-pty" | "tmux" = "windows-pty",
) {
  vi.resetModules()

  const state = {
    envelope,
  }

  let launchCount = 0
  const runtime = {
    start: vi.fn(async ({ backend, command, monitorSessionId }: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
      launchCount += 1
      const jobId = backend === "claude-code" ? `claude-job-${launchCount}` : `codex-job-${launchCount}`
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `${jobId}-monitor`,
          sessionId: runtimeKind === "windows-psmux" ? (monitorSessionId ?? jobId) : undefined,
          attach: runtimeKind === "windows-psmux"
            ? { mode: "pty" as const, target: `${monitorSessionId ?? jobId}:dashboard` }
            : { mode: "pty" as const, target: `${jobId}-pty` },
          attachCommand: runtimeKind === "windows-psmux" ? `psmux attach -t ${monitorSessionId ?? jobId}` : undefined,
          launch: {
            command: runtimeKind === "windows-psmux" ? `psmux attach -t ${monitorSessionId ?? jobId}` : command,
            cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
          },
        },
      }
    }),
    read: vi.fn(async () => ({ data: "" })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ jobs: [] })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
      id: `${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}-monitor`,
      sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : undefined,
      attach: lookup.type === "shared-session"
        ? { mode: "pty" as const, target: `${lookup.monitorSessionId}:dashboard` }
        : { mode: "pty" as const, target: `${lookup.jobId}-pty` },
      attachCommand: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : undefined,
      launch: {
        command: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : `attached ${lookup.jobId}`,
        cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: runtimeKind,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
        const job = await runtime.start(params)
        const monitor = runtimeKind === "windows-psmux" && params.monitorSessionId
          ? await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId })
          : await runtime.openMonitor({ type: "job", jobId: job.id })
        return { job, monitor }
      },
    }),
  }))

  vi.doMock("../src/core/delegation-permissions.js", async () => {
    const actual = await vi.importActual<typeof import("../src/core/delegation-permissions.js")>("../src/core/delegation-permissions.js")
    return {
      ...actual,
      deriveDelegationCapabilities: vi.fn(() => state.envelope.capabilities),
      fingerprintDelegationPermissions: vi.fn(() => state.envelope.fingerprint),
      fingerprintDelegationCapabilities: vi.fn(() => state.envelope.fingerprint),
    }
  })

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
    directory,
  } as never)

  return {
    plugin,
    client,
    runtime,
    setDelegationEnvelope(nextEnvelope: MockDelegationEnvelope) {
      state.envelope = nextEnvelope
    },
  }
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

    vi.mocked(runtime.start).mockImplementationOnce(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => ({
      id: "claude-job-1",
      backend,
      command,
      status: "running" as const,
      backendSessionId: "claude-session-42",
      backendResumeSessionId: "claude-resume-42",
      monitor: {
        id: "claude-job-1-monitor",
        attach: { mode: "pty" as const, target: "claude-job-1-pty" },
        launch: {
          command: "attached claude-job-1",
          cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
        },
      },
    }))

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
      commandArgs: ["claude", "--print", "inspect the vault door"],
      launchMetadata: expect.objectContaining({
        claudePolicy: {
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          disallowedTools: ["WebFetch", "WebSearch"],
          permissionMode: "bypassPermissions",
        },
        prompt: "inspect the vault door",
        promptFingerprint: expect.any(String),
        correlationMarker: "omni-opencode:parent-session-1:message-1:claude-code",
      }),
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
    expect(snapshot).toContain('"backendSessionId": "claude-session-42"')
    expect(snapshot).toContain('"backendResumeSessionId": "claude-resume-42"')
    expect(snapshot).toContain('"correlationMarker": "omni-opencode:parent-session-1:message-1:claude-code"')
    expect(snapshot).toContain('"promptFingerprint": "')
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

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude-code",
      command: expect.stringContaining("inspect the vault door"),
      cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      commandArgs: ["claude", "--print", "inspect the vault door"],
      launchMetadata: expect.objectContaining({
        claudePolicy: {
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          disallowedTools: ["WebFetch", "WebSearch"],
          permissionMode: "bypassPermissions",
        },
        prompt: "inspect the vault door",
        promptFingerprint: expect.any(String),
        correlationMarker: "omni-opencode:parent-session-1:message-1:claude-code",
      }),
      monitorSessionId: "parent-session-1",
    }))
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

  it("assigns the safe permission profile to review-style delegations without prompting the user", async () => {
    const { plugin } = await loadPlugin()
    const context = makeContext("parent-session-safe")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "review README.md and summarize the current delegation flow" },
      context as never,
    )

    expect(context.ask).not.toHaveBeenCalled()

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-safe:codex-job-1" },
      context as never,
    )

    expect(snapshot).toContain('"taskClass": "review"')
    expect(snapshot).toContain('"permissionProfile": "safe"')
    expect(snapshot).toContain('"approvalMode": "not-required"')
  })

  it("keeps review and investigation prompts safe even when they mention risky commands as subject matter", async () => {
    const { plugin, runtime } = await loadPlugin()

    const reviewContext = makeContext("parent-session-review-subject", "message-1")
    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "review why `npm test` fails and explain the likely cause without changing any files" },
      reviewContext as never,
    )

    const summaryContext = makeContext("parent-session-review-subject", "message-2")
    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "summarize the recent update to src/plugin.ts and analyze whether it looks correct; do not modify anything" },
      summaryContext as never,
    )

    expect(reviewContext.ask).not.toHaveBeenCalled()
    expect(summaryContext.ask).not.toHaveBeenCalled()
    expect(runtime.start).toHaveBeenCalledTimes(2)

    const firstSnapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-review-subject:codex-job-1" },
      reviewContext as never,
    )
    const secondSnapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-review-subject:claude-job-1" },
      summaryContext as never,
    )

    expect(firstSnapshot).toContain('"permissionProfile": "safe"')
    expect(firstSnapshot).toContain('"approvalMode": "not-required"')
    expect(secondSnapshot).toContain('"permissionProfile": "safe"')
    expect(secondSnapshot).toContain('"approvalMode": "not-required"')
  })

  it("prompts once per delegated launch with the unresolved capability names in the prompt body", async () => {
    const directory = uniqueStateDir("delegation-grouped-prompt")
    const { plugin, runtime } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "ask",
        shell: "ask",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-file-and-shell",
    })
    const context = makeContext("parent-session-approval", "message-1")
    vi.mocked(context.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts and run npm test" },
      context as never,
    )

    expect(context.ask).toHaveBeenCalledTimes(1)
    expect(context.ask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("file edits"),
      options: ["allow-once", "allow-session", "deny"],
    }))
    expect(context.ask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("shell commands"),
    }))
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude-code",
      launchMetadata: expect.objectContaining({
        claudePolicy: {
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          disallowedTools: ["WebFetch", "WebSearch"],
          permissionMode: "bypassPermissions",
        },
      }),
    }))
  })

  it("still prompts for unresolved delegated capabilities when task classification is safe", async () => {
    const directory = uniqueStateDir("delegation-safe-envelope-ask")
    const { plugin, runtime } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "ask",
        shell: "deny",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-safe-ask",
    })
    const context = makeContext("parent-session-safe-envelope", "message-1")
    vi.mocked(context.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "review src/plugin.ts and summarize likely edits" },
      context as never,
    )

    expect(context.ask).toHaveBeenCalledTimes(1)
    expect(runtime.start).toHaveBeenCalledTimes(1)

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-safe-envelope:codex-job-1" },
      context as never,
    )

    expect(snapshot).toContain('"permissionProfile": "safe"')
    expect(snapshot).toContain('"approvalMode": "once"')
  })

  it("reuses allow-session grants only for the same agent and permission fingerprint across relaunches", async () => {
    const directory = uniqueStateDir("delegation-grouped-end-to-end-grant-reuse")
    const { plugin, runtime, setDelegationEnvelope } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "ask",
        shell: "deny",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-agent-a",
    })

    const firstContext = makeContext("parent-session-approval", "message-1")
    firstContext.agent = "codex:gpt-5.4"
    vi.mocked(firstContext.ask).mockResolvedValue("allow-session")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts" },
      firstContext as never,
    )

    const crossBackendContext = makeContext("parent-session-approval", "message-2")
    crossBackendContext.agent = "codex:gpt-5.4"
    vi.mocked(crossBackendContext.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "edit src/core/jobs.ts" },
      crossBackendContext as never,
    )

    const sameBackendContext = makeContext("parent-session-approval", "message-3")
    sameBackendContext.agent = "codex:gpt-5.4"

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/core/store.ts" },
      sameBackendContext as never,
    )

    const differentAgentContext = makeContext("parent-session-approval", "message-4")
    differentAgentContext.agent = "claude:sonnet"
    vi.mocked(differentAgentContext.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/core/events.ts" },
      differentAgentContext as never,
    )

    setDelegationEnvelope({
      capabilities: {
        workspaceWrite: "ask",
        shell: "ask",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-agent-a-shell",
    })

    const changedFingerprintContext = makeContext("parent-session-approval", "message-5")
    changedFingerprintContext.agent = "codex:gpt-5.4"
    vi.mocked(changedFingerprintContext.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "edit src/core/store.ts and run npm test" },
      changedFingerprintContext as never,
    )

    expect(firstContext.ask).toHaveBeenCalledTimes(1)
    expect(crossBackendContext.ask).toHaveBeenCalledTimes(1)
    expect(sameBackendContext.ask).not.toHaveBeenCalled()
    expect(differentAgentContext.ask).toHaveBeenCalledTimes(1)
    expect(changedFingerprintContext.ask).toHaveBeenCalledTimes(1)
    expect(runtime.start).toHaveBeenCalledTimes(5)
  })

  it("passes the active worktree through as the delegated launch cwd", async () => {
    const directory = uniqueStateDir("delegation-runtime-cwd")
    const { plugin, runtime } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "allow",
        shell: "allow",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/feature-fix"],
      },
      fingerprint: "fingerprint-runtime-cwd",
    })

    const context = {
      ...makeContext("parent-session-cwd", "message-1"),
      directory: "D:/Omni-Opencode",
      worktree: "D:/Omni-Opencode/.worktrees/feature-fix",
    }

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect src/plugin.ts" },
      context as never,
    )

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      cwd: "D:/Omni-Opencode/.worktrees/feature-fix",
    }))
  })

  it("does not pass a synthetic missing workspace fallback as the delegated launch cwd", async () => {
    const directory = uniqueStateDir("delegation-runtime-missing-cwd")
    const { plugin, runtime } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "deny",
        shell: "deny",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: [],
      },
      fingerprint: "fingerprint-runtime-missing-cwd",
    })

    const context = {
      sessionID: "parent-session-missing-cwd",
      messageID: "message-1",
      agent: "codex:gpt-5.4",
      permissions: {},
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    }

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect src/plugin.ts" },
      context as never,
    )

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      cwd: undefined,
    }))
  })

  it("does not let a stored allow-session grant re-escalate a capability after it downgrades to deny", async () => {
    const directory = uniqueStateDir("delegation-grouped-grant-downgrade")
    const { plugin, runtime, setDelegationEnvelope } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "ask",
        shell: "deny",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-downgrade",
    })

    const firstContext = makeContext("parent-session-deny-downgrade", "message-1")
    firstContext.agent = "codex:gpt-5.4"
    vi.mocked(firstContext.ask).mockResolvedValue("allow-session")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts" },
      firstContext as never,
    )

    setDelegationEnvelope({
      capabilities: {
        workspaceWrite: "deny",
        shell: "deny",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-downgrade",
    })

    const secondContext = makeContext("parent-session-deny-downgrade", "message-2")
    secondContext.agent = "codex:gpt-5.4"

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "edit src/core/jobs.ts" },
      secondContext as never,
    )

    expect(secondContext.ask).not.toHaveBeenCalled()
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({
      launchMetadata: expect.objectContaining({
        codexPolicy: expect.objectContaining({
          sandboxMode: "read-only",
        }),
      }),
    }))
  })

  it("aborts launch when grouped capability approval is denied", async () => {
    const directory = uniqueStateDir("delegation-grouped-deny")
    const { plugin, runtime } = await loadPluginWithMockedDelegationEnvelope(directory, {
      capabilities: {
        workspaceWrite: "ask",
        shell: "ask",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
      fingerprint: "fingerprint-deny",
    })
    const context = makeContext("parent-session-deny", "message-1")
    vi.mocked(context.ask).mockResolvedValue("deny")

    await expect(plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts and run npm test" },
      context as never,
    )).rejects.toThrow(/not approved/i)

    expect(context.ask).toHaveBeenCalledTimes(1)
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it("uses delegated job id terminology for cancel lookups and responses", async () => {
    const { plugin, runtime } = await loadPlugin()
    const context = makeContext("parent-session-9")
    vi.mocked(context.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      context as never,
    )

    const cancelResult = await plugin.tool!.delegated_job_cancel.execute(
      { jobId: "parent-session-9:codex-job-1" },
      context as never,
    )

    expect(runtime.stop).toHaveBeenCalledWith("codex-job-1")
    expect(cancelResult).toBe("Cancelled delegated job parent-session-9:codex-job-1")
  })
})
