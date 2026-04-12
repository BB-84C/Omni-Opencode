import { describe, expect, it, vi } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createWindowsPsmuxRuntime } from "../src/runtime/windows-psmux.js"

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

async function loadPlugin(runtimeKind: "windows-psmux" | "windows-pty" | "tmux" = "tmux") {
  vi.resetModules()
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
    }) => ({
      id: backend === "claude-code" ? "claude-job-1" : "codex-job-1",
      backend,
      command,
      status: "running" as const,
      monitor: runtimeKind === "windows-psmux"
        ? {
            id: `monitor-${monitorSessionId ?? "missing-session"}`,
            sessionId: monitorSessionId,
            attach: { mode: "pty" as const, target: `${monitorSessionId}:dashboard`, windowIndex: 0 },
            window: { target: `${monitorSessionId}:job-${backend}-1`, index: backend === "claude-code" ? 1 : 2 },
            attachCommand: `psmux attach -t ${monitorSessionId}`,
            transcriptCaptureTarget: `${monitorSessionId}:job-${backend}-1:transcript`,
            launch: {
              command: `psmux attach -t ${monitorSessionId}`,
              cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
            },
          }
        : {
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
          attach: { mode: runtimeKind === "tmux" ? "tmux" as const : "pty" as const, target: "codex-target-1", windowIndex: runtimeKind === "windows-psmux" ? 0 : undefined },
          window: runtimeKind === "windows-psmux" ? { target: "parent-session-1:job-codex-job-1", index: 2 } : undefined,
          launch: { command: 'codex "repair the reactor"', cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }],
    })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => (runtimeKind === "windows-psmux"
      ? {
          id: `monitor-${lookup.type === "shared-session" ? lookup.monitorSessionId : lookup.jobId}`,
          sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : "parent-session-1",
          attach: {
            mode: "pty" as const,
            target: `${lookup.type === "shared-session" ? lookup.monitorSessionId : "parent-session-1"}:dashboard`,
            windowIndex: 0,
          },
          window: lookup.type === "job"
            ? { target: `parent-session-1:job-${lookup.jobId}`, index: 2 }
            : { target: `${lookup.monitorSessionId}:dashboard`, index: 0 },
          attachCommand: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : "parent-session-1"}`,
          autoOpenSucceeded: true,
          launch: {
            command: `psmux attach -t ${lookup.type === "shared-session" ? lookup.monitorSessionId : "parent-session-1"}`,
            cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
          },
        }
      : {
          id: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-monitor`,
          attach: { mode: runtimeKind === "tmux" ? "tmux" as const : "pty" as const, target: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-target` },
          launch: { command: `attached ${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: runtimeKind,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string; monitorSessionId?: string }) => {
        const job = await runtime.start(params)
        const monitorSessionId = params.monitorSessionId
        const monitor = runtimeKind === "windows-psmux" && monitorSessionId && autoOpenedSessions.has(monitorSessionId)
          ? job.monitor
          : await runtime.openMonitor(runtimeKind === "windows-psmux"
            ? { type: "shared-session", monitorSessionId: monitorSessionId ?? job.id }
            : { type: "job", jobId: job.id })

        if (runtimeKind === "windows-psmux" && monitorSessionId) {
          autoOpenedSessions.add(monitorSessionId)
        }

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

    expect(runtime.openMonitor).toHaveBeenLastCalledWith({ type: "job", jobId: "codex-job-1" })
    expect(output).toContain('"jobId": "parent-session-1:codex-job-1"')
    expect(output).toContain('"runtimeType": "tmux"')
    expect(output).toContain('"target": "codex-job-1-target"')
    expect(output).toContain('"command": "attached codex-job-1"')
  })

  it("uses real Windows psmux job-window navigation while keeping the shared attach command", async () => {
    const { plugin, runtime } = await loadPlugin("windows-psmux")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-1") as never,
    )

    const output = await plugin.tool!.delegated_job_attach.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )
    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(runtime.openMonitor).toHaveBeenLastCalledWith({ type: "job", jobId: "codex-job-1" })
    expect(output).toContain('"target": "parent-session-1:dashboard"')
    expect(output).toContain('"windowIndex": 0')
    expect(output).toContain('"window": {')
    expect(output).toContain('"target": "parent-session-1:job-codex-job-1"')
    expect(output).toContain('"index": 2')
    expect(output).toContain('"command": "psmux attach -t parent-session-1"')
    expect(snapshot).toContain('"attachCommand": "psmux attach -t parent-session-1"')
  })

  it("persists per-job transcript capture metadata on first Windows psmux save", async () => {
    const { plugin } = await loadPlugin("windows-psmux")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
      makeContext("parent-session-1") as never,
    )

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:codex-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"runtimeKind": "windows-psmux"')
    expect(snapshot).toContain('"transcriptCaptureTarget": "parent-session-1:job-codex-1:transcript"')
    expect(snapshot).toContain('"terminalLogPath": "parent-session-1:job-codex-1:transcript"')
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
      openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
        id: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-monitor`,
        attach: { mode: "tmux" as const, target: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-fresh-target` },
        launch: { command: `attached ${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
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

  it("keeps persisted tmux jobs on per-job attach lookup after a windows-psmux restart", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-tmux-migration")
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
      openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
        id: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-monitor`,
        attach: { mode: "tmux" as const, target: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-fresh-target` },
        launch: { command: `attached ${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
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

    expect(runtime.openMonitor).toHaveBeenCalledWith({ type: "job", jobId: "codex-job-1" })
    expect(runtime.openMonitor).not.toHaveBeenCalledWith({ type: "shared-session", monitorSessionId: "parent-session-1" })
  })

  it("keeps persisted archived windows-pty jobs on per-job attach lookup after a windows-psmux restart", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-windows-pty-migration")
    const stateDir = join(directory, ".broker-state")
    const overlayDir = join(stateDir, "final-state-overlay")
    const jobId = "parent-session-1:codex-job-1"
    const staleRecord = {
      jobId,
      parentSessionId: "parent-session-1",
      monitorSessionId: "parent-session-1",
      runtimeKind: "windows-pty",
      runtimeType: "pty",
      runtimeHandle: "codex-job-1",
      attachTarget: "codex-target-1",
      attachCommand: "psmux attach -t parent-session-1",
      terminalLogPath: "codex-target-1",
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
      openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
        id: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-monitor`,
        attach: { mode: "pty" as const, target: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-fresh-target` },
        launch: { command: `attached ${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}`, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
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

    expect(runtime.openMonitor).toHaveBeenCalledWith({ type: "job", jobId: "codex-job-1" })
    expect(runtime.openMonitor).not.toHaveBeenCalledWith({ type: "shared-session", monitorSessionId: "parent-session-1" })
  })

  it("reattaches overlay-backed Windows psmux jobs by monitor session id", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-psmux-overlay")
    const stateDir = join(directory, ".broker-state")
    const overlayDir = join(stateDir, "final-state-overlay")
    const jobId = "parent-session-1:codex-job-1"
    const staleRecord = {
      jobId,
      parentSessionId: "parent-session-1",
      monitorSessionId: "parent-session-1",
      runtimeKind: "windows-psmux",
      runtimeType: "pty",
      runtimeHandle: "codex-job-1",
      attachTarget: "stale-target",
      attachCommand: "stale attach",
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

    const open = vi.fn(async () => undefined)
    const runPsmuxCommand = vi.fn(async (command: string) => {
      if (command === "psmux has-session -t parent-session-1") {
        return undefined
      }

      return undefined
    })
    const runPsmuxQuery = vi.fn(async (command: string) => {
      if (command === 'psmux list-panes -t parent-session-1:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"') {
        return [
          "%0 0 0 0 120 60",
          "%1 1 120 0 80 60",
        ].join("\n")
      }

      return ""
    })
    const launchSharedSessionClient = vi.fn(async () => {
      let onExitHandler: (() => void) | undefined

      return {
        pid: 1,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => onExitHandler?.()),
        onData: vi.fn(),
        onExit: vi.fn((handler: () => void) => {
          onExitHandler = handler
        }),
      }
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      ensureManagedPsmuxInstalled: async () => ({
        binaryPath: "psmux",
        manifestPath: "D:/Omni-Opencode/.worktrees/pty-monitor/.omni-tools/psmux/manifest.json",
        installed: false,
      }),
      open,
      launchSharedSessionClient,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
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

    const output = await plugin.tool!.delegated_job_attach.execute(
      { jobId },
      makeContext("parent-session-1") as never,
    )

    expect(runPsmuxCommand).toHaveBeenCalledWith("psmux has-session -t parent-session-1")
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("psmux new-window -t parent-session-1"))
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("psmux split-pane -t parent-session-1:dashboard"))
    expect(open).toHaveBeenCalledWith({
      jobId: "parent-session-1",
      target: "parent-session-1:dashboard",
      cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      attachCommand: "psmux attach -t parent-session-1",
      logTailCommand: undefined,
    })
    expect(output).toContain('"target": "parent-session-1:dashboard"')
    expect(output).toContain('"command": "psmux attach -t parent-session-1"')
  })

  it("persists a discovered real Windows psmux monitor session id for later reattach", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-psmux-reattach")
    const stateDir = join(directory, ".broker-state")
    const jobId = "parent-session-1:codex-job-1"

    await writeJobRecord(stateDir, jobId, {
      jobId,
      batchId: "parent-session-1:message-1",
      parentSessionId: "parent-session-1",
      monitorSessionId: "parent-session-1",
      runtimeKind: "windows-psmux",
      runtimeType: "pty",
      runtimeHandle: "codex-job-1",
      attachTarget: "stale-target",
      attachCommand: "stale attach",
      terminalLogPath: "stale-target",
      backend: "codex",
      backendThreadId: "codex-job-1",
      status: "completed",
    })

    const runtime = {
      start: vi.fn(),
      read: vi.fn(async () => ({ data: "" })),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ jobs: [] })),
      openMonitor: vi.fn(async () => ({
        id: "monitor-real-session-7",
        sessionId: "real-session-7",
        attach: { mode: "pty" as const, target: "real-session-7:dashboard" },
        attachCommand: "psmux attach -t real-session-7",
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
    await plugin.tool!.delegated_job_attach.execute(
      { jobId },
      makeContext("parent-session-1") as never,
    )

    expect(runtime.openMonitor).toHaveBeenNthCalledWith(1, { type: "shared-session", monitorSessionId: "parent-session-1" })
    expect(runtime.openMonitor).toHaveBeenNthCalledWith(2, { type: "shared-session", monitorSessionId: "real-session-7" })

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"monitorSessionId": "real-session-7"')
  })

  it("reattaches legacy Windows psmux records missing runtimeKind through the shared session path", async () => {
    vi.resetModules()

    const directory = uniqueStateDir("job-controls-psmux-legacy-runtime-kind")
    const stateDir = join(directory, ".broker-state")
    const jobId = "parent-session-1:codex-job-1"

    await writeJobRecord(stateDir, jobId, {
      jobId,
      batchId: "parent-session-1:message-1",
      parentSessionId: "parent-session-1",
      monitorSessionId: "parent-session-1",
      runtimeType: "pty",
      runtimeHandle: "codex-job-1",
      attachTarget: "stale-target",
      attachCommand: "psmux attach -t parent-session-1",
      terminalLogPath: "stale-target",
      backend: "codex",
      backendThreadId: "codex-job-1",
      status: "completed",
    })

    const runtime = {
      start: vi.fn(),
      read: vi.fn(async () => ({ data: "" })),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ jobs: [] })),
      openMonitor: vi.fn(async () => ({
        id: "monitor-parent-session-1",
        sessionId: "parent-session-1",
        attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
        attachCommand: "psmux attach -t parent-session-1",
        launch: {
          command: "psmux attach -t parent-session-1",
          cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
        },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
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

    expect(runtime.openMonitor).toHaveBeenCalledWith({ type: "shared-session", monitorSessionId: "parent-session-1" })
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

  it("exposes batch-aware inspection details after launch", async () => {
    const { plugin } = await loadPlugin("tmux")

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "repair the reactor" },
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

    expect(snapshot).toContain('"batchId": "parent-session-1:message-1"')
    expect(snapshot).toContain('"attachCommand": "attached codex-job-1"')
    expect(snapshot).toContain('"autoOpenAttempted": true')
    expect(snapshot).toContain('"autoOpenSucceeded": true')
    expect(list).toContain("batch=parent-session-1:message-1")
  })

  it("stores a shared Windows psmux attach command on first launch and reuses it later", async () => {
    const { plugin, runtime } = await loadPlugin("windows-psmux")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the vault door" },
      makeContext("parent-session-1") as never,
    )
    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect the reactor" },
      { ...makeContext("parent-session-1"), messageID: "message-2" } as never,
    )

    const firstSnapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )
    const secondSnapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:codex-job-1" },
      { ...makeContext("parent-session-1"), messageID: "message-2" } as never,
    )

    expect(firstSnapshot).toContain('"monitorSessionId": "parent-session-1"')
    expect(firstSnapshot).toContain('"attachCommand": "psmux attach -t parent-session-1"')
    expect(firstSnapshot).toContain('"autoOpenSucceeded": true')
    expect(secondSnapshot).toContain('"monitorSessionId": "parent-session-1"')
    expect(secondSnapshot).toContain('"attachCommand": "psmux attach -t parent-session-1"')
    expect(secondSnapshot).toContain('"autoOpenSucceeded": false')
    expect(runtime.openMonitor).toHaveBeenCalledTimes(1)
  })
})
