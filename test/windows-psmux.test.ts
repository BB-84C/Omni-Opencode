import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobStore } from "../src/core/store.js"
import { createStoredJobRecord } from "../src/plugin.js"
import { selectRuntime } from "../src/runtime/select-runtime.js"
import { ARCHIVED_RUNTIME_KINDS } from "../src/runtime/types.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeReadResult, RuntimeSnapshot } from "../src/runtime/types.js"
import { createWindowsPsmuxRuntime } from "../src/runtime/windows-psmux.js"
import { makeContext } from "./helpers/delegation-plugin-fixture.js"

const MANAGED_BINARY_PATH = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function createDashboardQueryStub(binaryPath = MANAGED_BINARY_PATH) {
  return vi.fn(async (command: string) => {
    const dashboardMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} list-panes -t ([^:]+):dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"$`))
    if (dashboardMatch) {
      return [
        "%11 0 0 0 120 60",
        "%12 1 120 0 80 60",
      ].join("\n")
    }

    const newWindowMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} new-window -P -F "#{window_index} #{pane_id}" -t ([^ ]+) -n job-runtime-(\\d+) -d -- `))
    if (newWindowMatch) {
      return `${Number(newWindowMatch[2])} %${Number(newWindowMatch[2]) * 10 + 21}`
    }

    const jobListMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} list-panes -t ([^:]+):job-runtime-(\\d+) -F "#{pane_id}"$`))
    if (jobListMatch) {
      return `%${Number(jobListMatch[2]) * 10 + 21}`
    }

    if (command.includes("break-pane")) {
      return "%91"
    }

    throw new Error(`Unexpected query: ${command}`)
  })
}

function createTwoPaneDashboardQueryStub(binaryPath = MANAGED_BINARY_PATH) {
  return vi.fn(async (command: string) => {
    const dashboardMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} list-panes -t ([^:]+):dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"$`))
    if (dashboardMatch) {
      return [
        "%11 0 0 0 120 60",
        "%12 1 120 0 80 60",
      ].join("\n")
    }

    const newWindowMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} new-window -P -F "#{window_index} #{pane_id}" -t ([^ ]+) -n job-runtime-(\\d+) -d -- `))
    if (newWindowMatch) {
      return `${Number(newWindowMatch[2])} %${Number(newWindowMatch[2]) * 10 + 21}`
    }

    const jobListMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} list-panes -t ([^:]+):job-runtime-(\\d+) -F "#{pane_id}"$`))
    if (jobListMatch) {
      return `%${Number(jobListMatch[2]) * 10 + 21}`
    }

    if (command.includes("break-pane")) {
      return "%91"
    }

    throw new Error(`Unexpected query: ${command}`)
  })
}

function expectCommandContaining(commands: string[], snippet: string) {
  expect(commands.some((command) => command.includes(snippet))).toBe(true)
}

function createMockPty() {
  const dataListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []

  return {
    pid: 1,
    kill() {},
    onData(listener: (chunk: string) => void) {
      dataListeners.push(listener)
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListeners.push(listener)
    },
    emitData(chunk: string) {
      for (const listener of dataListeners) {
        listener(chunk)
      }
    },
    exit(exitCode: number) {
      for (const listener of exitListeners) {
        listener({ exitCode })
      }
    },
  }
}

function createManagedInstallResult(binaryPath = MANAGED_BINARY_PATH) {
  return {
    binaryPath,
    manifestPath: "D:/Omni-Opencode/.omni-tools/psmux/manifest.json",
    installed: false,
  }
}

function stubDashboardProcessCommand(snapshotPath: string): string {
  return `node --dashboard-process "${snapshotPath}"`
}

const CUSTOM_MANAGED_BINARY_PATH = "D:/custom-tools/psmux.exe"

function createStubRuntime(mode: "pty" | "tmux"): Runtime {
  return {
    async start(): Promise<RuntimeJob> {
      return {
        id: `job-${mode}`,
        backend: "codex",
        command: "codex run",
        status: "running",
        monitor: {
          id: `monitor-${mode}`,
          attach: { mode, target: `target-${mode}` },
          launch: { command: "codex run" },
        },
      }
    },
    async read(): Promise<RuntimeReadResult> {
      return { data: "" }
    },
    async stop(): Promise<void> {},
    async snapshot(): Promise<RuntimeSnapshot> {
      return { jobs: [] }
    },
    async openMonitor(): Promise<RuntimeMonitor> {
      return {
        id: `monitor-${mode}`,
        attach: { mode, target: `target-${mode}` },
        launch: { command: "codex run" },
      }
    },
  }
}

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "windows-psmux-"))
}

describe("Windows psmux runtime contract", () => {
  it("selects the Windows psmux runtime on the primary win32 path", () => {
    const createWindowsPsmuxRuntime = vi.fn(() => createStubRuntime("pty"))
    const createTmuxRuntime = vi.fn(() => createStubRuntime("tmux"))

    const selected = selectRuntime({
      platform: "win32",
      createWindowsPsmuxRuntime,
      createTmuxRuntime,
    })

    expect(selected.kind).toBe("windows-psmux")
    expect(selected.kind).not.toBe("windows-pty")
    expect(createWindowsPsmuxRuntime).toHaveBeenCalledOnce()
    expect(createTmuxRuntime).not.toHaveBeenCalled()
  })

  it("keeps the legacy createWindowsRuntime hook as a fallback alias for the primary Windows path", async () => {
    const runtime = createStubRuntime("pty")
    const createWindowsRuntime = vi.fn(() => runtime)

    const selected = selectRuntime({
      platform: "win32",
      createWindowsRuntime,
    })

    const { job, monitor } = await selected.start({ backend: "codex", command: "codex run" })

    expect(selected.kind).toBe("windows-psmux")
    expect(createWindowsRuntime).toHaveBeenCalledOnce()
    expect(job.monitor).toEqual(monitor)
  })

  it("archives only the legacy Windows PTY runtime", () => {
    expect(ARCHIVED_RUNTIME_KINDS).toEqual(["windows-pty"])
    expect(ARCHIVED_RUNTIME_KINDS).not.toContain("windows-psmux")
    expect(ARCHIVED_RUNTIME_KINDS).not.toContain("tmux")
  })

  it("routes win32 starts through the windows psmux runtime seam, not the archived Windows PTY seam", async () => {
    const start = vi.fn(async (): Promise<RuntimeJob> => ({
      id: "job-psmux",
      backend: "claude-code",
      command: 'claude --print "hello"',
      status: "running",
      monitor: {
        id: "monitor-psmux",
        attach: { mode: "pty", target: "target-psmux" },
        launch: { command: "psmux attach -t parent-session-psmux" },
      },
    }))
    const openMonitor = vi.fn(async (): Promise<RuntimeMonitor> => ({
      id: "monitor-psmux",
      attach: { mode: "pty", target: "target-psmux" },
      launch: { command: "psmux attach -t parent-session-psmux" },
    }))
    const runtime: Runtime = {
      start,
      read: vi.fn(async (): Promise<RuntimeReadResult> => ({ data: "" })),
      stop: vi.fn(async (): Promise<void> => {}),
      snapshot: vi.fn(async (): Promise<RuntimeSnapshot> => ({ jobs: [] })),
      openMonitor,
    }
    const createWindowsPsmuxRuntime = vi.fn(() => runtime)
    const createWindowsRuntime = vi.fn(() => {
      throw new Error("archived windows-pty runtime should not be selected")
    })

    const selection = selectRuntime({
      platform: "win32",
      createWindowsPsmuxRuntime,
      createWindowsRuntime,
    })

    const { job, monitor } = await selection.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
    })

    expect(createWindowsPsmuxRuntime).toHaveBeenCalledOnce()
    expect(createWindowsRuntime).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    expect(openMonitor).toHaveBeenCalledWith({ type: "job", jobId: job.id })
    expect(monitor).toEqual(job.monitor)
  })

  it("creates one shared psmux session per monitor session and returns the stable attach command", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(firstJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(secondJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(secondJob.monitor.attachCommand).toBe(firstJob.monitor.attachCommand)
    expect(firstJob.monitor.id).toBe("monitor-parent-session-1")
    expect(secondJob.monitor.id).toBe("monitor-parent-session-1")
    expect(firstJob.monitor.sessionId).toBe("parent-session-1")
    expect(secondJob.monitor.sessionId).toBe("parent-session-1")
    const commands = (runPsmuxCommand.mock.calls as unknown as Array<[string]>).map(([command]) => command)
    expect(commands).toContain(`${MANAGED_BINARY_PATH} start-server`)
    expectCommandContaining(commands, `${MANAGED_BINARY_PATH} new-session -d -s parent-session-1 -n dashboard -- node --dashboard-process`)
  })

  it("bootstraps the first shared launch from a real detached session without recreating the dashboard window", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-bootstrap",
    })

    const recordedCommands = (runPsmuxCommand.mock.calls as unknown as Array<[string]>).map(([command]) => command)

    expect(hasSharedSession).toHaveBeenCalledOnce()
    expect(hasSharedSession).toHaveBeenCalledWith("parent-session-bootstrap")
    expect(recordedCommands[0]).toBe(`${MANAGED_BINARY_PATH} start-server`)
    expect(recordedCommands[1]).toContain(`${MANAGED_BINARY_PATH} new-session -d -s parent-session-bootstrap -n dashboard -- node --dashboard-process`)
    expect(recordedCommands).not.toContain(
      `${MANAGED_BINARY_PATH} new-window -t parent-session-bootstrap -n dashboard`,
    )
    expect(job.monitor.attach.target).toBe("parent-session-bootstrap:dashboard")
    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-bootstrap`)
  })

  it("creates the detached dashboard session with a dedicated dashboard process, not a shell", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-shell-bootstrap",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const newSessionCommand = commands.find((command) => command.includes("new-session -d -s parent-session-shell-bootstrap -n dashboard --"))

    expect(newSessionCommand).toBeDefined()
    expect(newSessionCommand).toContain("node --dashboard-process")
    expect(newSessionCommand).not.toContain("powershell.exe -NoLogo -NoProfile")
    expect(newSessionCommand).not.toContain("Start-Sleep")
  })

  it("keeps window 0 as a two-pane dashboard with a dedicated dashboard process on the left and interactive shell on the right", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createTwoPaneDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-two-pane-shell",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const splitCommands = commands.filter((command) => command.includes("split-window -t parent-session-two-pane-shell:dashboard"))
    const newSessionCommand = commands.find((command) => command.includes("new-session -d -s parent-session-two-pane-shell -n dashboard --"))

    expect(splitCommands).toHaveLength(1)
    expect(newSessionCommand).toContain("node --dashboard-process")
    expect(splitCommands[0]).toContain("-- powershell.exe -NoLogo -NoProfile")
    expect(commands).not.toContain(
      `${MANAGED_BINARY_PATH} split-window -t parent-session-two-pane-shell:dashboard.1 -v -p 50 -d`,
    )
  })

  it("never sends keys to the dashboard or shell panes since the dashboard process is file-driven", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createTwoPaneDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-shell-refresh",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-shell-refresh",
    })
    await runtime.stop("runtime-2")

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const splitCommands = commands.filter((command) => command.includes("split-window -t parent-session-shell-refresh:dashboard"))
    const dashboardSendKeys = commands.filter((command) => command.includes("send-keys -t %11"))
    const shellSendKeys = commands.filter((command) => command.includes("send-keys -t %12"))

    expect(splitCommands).toEqual([
      `${MANAGED_BINARY_PATH} split-window -t parent-session-shell-refresh:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile`,
    ])
    expect(dashboardSendKeys).toEqual([])
    expect(shellSendKeys).toEqual([])
  })

  it("keeps reusing the live cached shared session while this process still tracks active jobs", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async (_sessionId: string) => false)
    const runPsmuxQuery = createDashboardQueryStub()
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-reattach",
    })
    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-reattach",
    })
    runPsmuxCommand.mockClear()

    const detachedMonitor = await runtime.openMonitor({
      type: "shared-session",
      monitorSessionId: "parent-session-detached",
    })

    expect(firstJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-reattach`)
    expect(detachedMonitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-detached`)
    expect(hasSharedSession).toHaveBeenNthCalledWith(1, "parent-session-reattach")
    expect(hasSharedSession).toHaveBeenNthCalledWith(2, "parent-session-detached")
    expect(hasSharedSession).toHaveBeenCalledTimes(2)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("new-session -d -s parent-session-detached"),
    )
  })

  it("uses the default command runner path to execute managed has-session and detached bootstrap commands", async () => {
    const runShellCommand = vi
      .fn(async (_command: string) => undefined)
      .mockRejectedValueOnce(new Error("missing session"))
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-default-path",
    })

    expect(runShellCommand).toHaveBeenNthCalledWith(
      1,
      `${MANAGED_BINARY_PATH} has-session -t parent-session-default-path`,
    )
    expect(runShellCommand).toHaveBeenNthCalledWith(
      2,
      `${MANAGED_BINARY_PATH} start-server`,
    )
    expect(String(runShellCommand.mock.calls[2]?.[0] ?? "")).toContain(`${MANAGED_BINARY_PATH} new-session -d -s parent-session-default-path -n dashboard -- node --dashboard-process`)
    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-default-path`)
  })

  it("does not request a second auto-open window for the same shared monitor session", async () => {
    const sharedClient = createMockPty()
    const open = vi.fn(async () => undefined)
    const launchSharedSessionClient = vi.fn(async () => sharedClient)
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      open,
      launchSharedSessionClient,
      runPsmuxQuery,
    })
    const selection = selectRuntime({
      platform: "win32",
      createWindowsPsmuxRuntime: () => runtime,
    })

    const firstStart = await selection.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondStart = await selection.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(firstStart.monitor).toMatchObject({
      id: firstStart.job.monitor.id,
      sessionId: firstStart.job.monitor.sessionId,
      attach: firstStart.job.monitor.attach,
      attachCommand: firstStart.job.monitor.attachCommand,
      launch: firstStart.job.monitor.launch,
      autoOpenSucceeded: true,
    })
    expect(secondStart.monitor).toMatchObject({
      id: secondStart.job.monitor.id,
      sessionId: secondStart.job.monitor.sessionId,
      attach: secondStart.job.monitor.attach,
      attachCommand: secondStart.job.monitor.attachCommand,
      launch: secondStart.job.monitor.launch,
      autoOpenSucceeded: false,
    })
    expect(firstStart.job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(secondStart.job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      jobId: "parent-session-1",
      target: firstStart.job.monitor.attach.target,
      cwd: "D:/Omni-Opencode",
      attachCommand: `${MANAGED_BINARY_PATH} attach -t parent-session-1`,
      logTailCommand: undefined,
    })
  })

  it("creates a fresh shared session after the cached client exits and no active jobs remain", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })

    await runtime.stop(firstJob.id)

    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(secondJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(runPsmuxCommand).toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-1`)
    const recordedCommands = runPsmuxCommand.mock.calls as unknown as Array<[string]>
    expect(
      recordedCommands
        .map((call) => call[0])
        .filter((command) => command === `${MANAGED_BINARY_PATH} start-server`),
    ).toHaveLength(2)
  })

  it("configures background pipe-pane bookkeeping per delegated job without changing the visible attach contract", async () => {
    const sharedClient = createMockPty()
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = vi.fn(async (command: string) => {
      if (command === `${MANAGED_BINARY_PATH} list-panes -t parent-session-1:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`) {
        return [
          "%11 0 0 0 120 60",
          "%12 1 120 0 80 60",
        ].join("\n")
      }

      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes('job-runtime-1')) {
        return "1 %31"
      }

      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes('job-runtime-2')) {
        return "2 %41"
      }

      if (command.includes("break-pane")) {
        return "%51"
      }

      throw new Error(`Unexpected query: ${command}`)
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => sharedClient),
      runPsmuxCommand,
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(firstJob.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(secondJob.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(firstJob.monitor.attach.windowIndex).toBe(0)
    expect(secondJob.monitor.attach.windowIndex).toBe(0)
    expect(firstJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(secondJob.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-1`)
    expect(firstJob.monitor.logTailCommand).toBeUndefined()
    expect(secondJob.monitor.logTailCommand).toBeUndefined()
    expect(firstJob.monitor.transcriptCaptureTarget).toBe("D:/Omni-Opencode/.omni-monitors/runtime-1.log")
    expect(secondJob.monitor.transcriptCaptureTarget).toBe("D:/Omni-Opencode/.omni-monitors/runtime-2.log")
    const commands = (runPsmuxCommand.mock.calls as unknown as Array<[string]>).map(([command]) => command)
    expectCommandContaining(commands, `${MANAGED_BINARY_PATH} pipe-pane -t %31 -o --`)
    expectCommandContaining(commands, "runtime-1.log")
    expectCommandContaining(commands, `${MANAGED_BINARY_PATH} pipe-pane -t %41 -o --`)
    expectCommandContaining(commands, "runtime-2.log")
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(runPsmuxQuery.mock.calls.map(([command]) => command).filter((command) => command.includes("break-pane"))).toEqual([])
  })

  it("stores real psmux window identities per job while keeping the dashboard at window 0", async () => {
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })
    const reopenedSecondMonitor = await runtime.openMonitor({ type: "job", jobId: secondJob.id })

    expect(firstJob.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(secondJob.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(firstJob.monitor.attach.windowIndex).toBe(0)
    expect(secondJob.monitor.attach.windowIndex).toBe(0)
    expect(reopenedSecondMonitor.attach.target).toBe("parent-session-1:dashboard")
    expect(reopenedSecondMonitor.attach.windowIndex).toBe(0)
    expect(firstJob.monitor.window).toEqual({
      index: 1,
      target: "parent-session-1:1",
    })
    expect(secondJob.monitor.window).toEqual({
      index: 2,
      target: "parent-session-1:2",
    })
    expect(reopenedSecondMonitor.window).toEqual({
      index: 2,
      target: "parent-session-1:2",
    })
  })

  it("exposes the stored real job window identity through later openMonitor lookups", async () => {
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery,
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-lookup",
    })

    const monitor = await runtime.openMonitor({ type: "job", jobId: job.id })

    expect(monitor.attach.target).toBe("parent-session-lookup:dashboard")
    expect(monitor.attach.windowIndex).toBe(0)
    expect(monitor.window).toEqual({
      index: 1,
      target: "parent-session-lookup:1",
    })
  })

  it("checks existing shared sessions via the resolved managed binary path without invoking bare PATH startup", async () => {
    const runPsmuxCommand = vi.fn(async (command: string) => {
      return undefined
    })
    const ensureManagedPsmuxInstalled = vi.fn(async () => createManagedInstallResult())
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-managed",
    })

    expect(runPsmuxCommand).toHaveBeenCalledWith(
      `${MANAGED_BINARY_PATH} has-session -t parent-session-managed`,
    )
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("start-server"))
    expect(ensureManagedPsmuxInstalled).toHaveBeenCalledOnce()
  })

  it("uses the managed resolver result instead of a PATH-only detection result", async () => {
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => true,
      runPsmuxCommand: vi.fn(async () => undefined),
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
      runPsmuxQuery,
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-managed",
    })

    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-managed`)
  })

  it("does not retarget the stopped job during stop-time cleanup", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub(CUSTOM_MANAGED_BINARY_PATH)
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(CUSTOM_MANAGED_BINARY_PATH),
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
      runPsmuxCommand,
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-cleanup",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-cleanup",
    })

    runPsmuxCommand.mockClear()

    await runtime.stop(firstJob.id)

    const recordedCommands = (runPsmuxCommand.mock.calls as unknown as Array<[string]>).map(([command]) => command)
    expect(recordedCommands.filter((command) => !command.includes("kill-window"))).not.toContainEqual(
      expect.stringContaining(`parent-session-cleanup:job-${firstJob.id}`),
    )
  })

  it("reads transcript data from each job pipe-pane capture target and marks only completed jobs stopped", async () => {
    const cwd = await createTempWorkspace()
    const sharedClient = createMockPty()
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => sharedClient),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    sharedClient.emitData("bootstrap noise should not become transcript")

    await expect(runtime.read(firstJob.id)).resolves.toEqual({ data: "" })

    await writeFile(firstJob.monitor.transcriptCaptureTarget!, "first job output\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n", "utf8")
    await writeFile(secondJob.monitor.transcriptCaptureTarget!, "second job output\n", "utf8")

    await expect(runtime.read(firstJob.id)).resolves.toEqual({ data: "first job output\n" })
    await expect(runtime.read(secondJob.id)).resolves.toEqual({ data: "second job output\n" })
    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstJob.id, status: "stopped" }),
      expect.objectContaining({ id: secondJob.id, status: "running" }),
    ]))
  })

  it("refreshes delegated_job_attach metadata without overwriting the psmux transcript capture path", async () => {
    vi.resetModules()

    const runtime = {
      start: vi.fn(async (_params?: { backend: "codex" | "claude-code"; command: string }) => ({
        id: "runtime-1",
        backend: "codex" as const,
        command: 'codex exec "hello"',
        status: "running" as const,
        monitor: {
          id: "monitor-parent-session-1",
          sessionId: "parent-session-1",
          attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
          attachCommand: "psmux attach -t parent-session-1",
          transcriptCaptureTarget: "D:/Omni-Opencode/.omni-monitors/runtime-1.log",
          launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode" },
        },
      })),
      read: vi.fn(async (): Promise<RuntimeReadResult> => ({ data: "" })),
      stop: vi.fn(async (): Promise<void> => undefined),
      snapshot: vi.fn(async (): Promise<RuntimeSnapshot> => ({ jobs: [] })),
      openMonitor: vi.fn(async (): Promise<RuntimeMonitor> => ({
        id: "monitor-parent-session-1",
        sessionId: "parent-session-1",
        attach: { mode: "pty", target: "parent-session-1:dashboard" },
        attachCommand: "psmux attach -t parent-session-1",
        transcriptCaptureTarget: "D:/Omni-Opencode/.omni-monitors/runtime-1.log",
        launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode" },
      })),
    }

    vi.doMock("../src/runtime/select-runtime.js", () => ({
      selectRuntime: () => ({
        kind: "windows-psmux" as const,
        runtime,
        autoOpenMonitor: true,
        start: async (params: { backend: "codex" | "claude-code"; command: string }) => {
          const job = await runtime.start(params)
          const monitor = job.monitor
          return { job, monitor }
        },
      }),
    }))

    const { OmniOpencodePlugin } = await import("../src/plugin.js")
    const plugin = await OmniOpencodePlugin({
      client: {
        session: { create: vi.fn(), promptAsync: vi.fn(async () => undefined) },
        message: { create: vi.fn(async () => undefined) },
      } as never,
      directory: await createTempWorkspace(),
    } as never)

    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "hello" },
      makeContext("parent-session-1") as never,
    )

    await plugin.tool!.delegated_job_attach.execute(
      { jobId: "parent-session-1:runtime-1" },
      makeContext("parent-session-1") as never,
    )

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:runtime-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"attachTarget": "parent-session-1:dashboard"')
    expect(snapshot).toContain('"terminalLogPath": "D:/Omni-Opencode/.omni-monitors/runtime-1.log"')
    expect(snapshot).toContain('"transcriptCaptureTarget": "D:/Omni-Opencode/.omni-monitors/runtime-1.log"')
  })

  it("advances transcript status checks incrementally across repeated snapshots", async () => {
    const readTranscriptCaptureFile = vi
      .fn(async (_target: string, offset: number) => {
        if (offset === 0) {
          return { data: "line one\n", nextOffset: "line one\n".length }
        }

        return { data: "__OMNI_OPENCODE_PSMUX_EXIT__:0\n", nextOffset: offset + "__OMNI_OPENCODE_PSMUX_EXIT__:0\n".length }
      })
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
      runPsmuxCommand: vi.fn(async () => undefined),
      readTranscriptCaptureFile,
      runPsmuxQuery,
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    await runtime.snapshot()
    await runtime.snapshot()

    expect(readTranscriptCaptureFile).toHaveBeenNthCalledWith(1, job.monitor.transcriptCaptureTarget, 0)
    expect(readTranscriptCaptureFile).toHaveBeenNthCalledWith(2, job.monitor.transcriptCaptureTarget, "line one\n".length)
  })

  it("unregisters naturally completed shared-session jobs so the last explicit stop can clean up the session", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const readTranscriptCaptureFile = vi.fn(async (target: string, offset: number) => {
      if (target.endsWith("runtime-1.log") && offset === 0) {
        return {
          data: "completed\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n",
          nextOffset: "completed\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n".length,
        }
      }

      return {
        data: "",
        nextOffset: offset,
      }
    })
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
      runPsmuxCommand,
      readTranscriptCaptureFile,
      runPsmuxQuery,
    })

    const firstJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })

    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstJob.id, status: "stopped" }),
      expect.objectContaining({ id: secondJob.id, status: "running" }),
    ]))

    await runtime.stop(secondJob.id)

    const commandCalls = runPsmuxCommand.mock.calls as unknown as Array<[string]>

    expect(commandCalls.map(([command]) => command)).toEqual(expect.arrayContaining([
      `${MANAGED_BINARY_PATH} kill-window -t parent-session-1:job-runtime-2`,
      `${MANAGED_BINARY_PATH} kill-session -t parent-session-1`,
    ]))
  })

  it("treats stop after natural completion as harmless cleanup", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const readTranscriptCaptureFile = vi.fn(async (_target: string, offset: number) => {
      if (offset === 0) {
        return {
          data: "done\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n",
          nextOffset: "done\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n".length,
        }
      }

      return { data: "", nextOffset: offset }
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
      runPsmuxCommand,
      readTranscriptCaptureFile,
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-finished",
    })

    await runtime.snapshot()
    runPsmuxCommand.mockClear()

    await expect(runtime.stop(job.id)).resolves.toBeUndefined()

    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-window -t parent-session-finished:job-runtime-1`)
    expect(runPsmuxCommand).toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-finished`)
  })

  it("fails clearly when opening a monitor for an unknown job id", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await expect(runtime.openMonitor({ type: "job", jobId: "runtime-missing" })).rejects.toThrow("Unknown runtime job: runtime-missing")

    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("start-server"))
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("new-session -d -s runtime-missing"))
  })

  it("revalidates cached shared sessions before reusing them", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(false)
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const firstJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-stale",
    })

    await runtime.stop(firstJob.id)
    runPsmuxCommand.mockClear()

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-stale",
    })

    expect(hasSharedSession).toHaveBeenNthCalledWith(1, "parent-session-stale")
    expect(hasSharedSession).toHaveBeenNthCalledWith(2, "parent-session-stale")
    expect(runPsmuxCommand).toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expect(runPsmuxCommand).toHaveBeenCalledWith(expect.stringContaining("new-session -d -s parent-session-stale"))
  })

  it("repairs an existing shared session when its dashboard still uses the old layout", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => true)
    const runPsmuxQuery = vi.fn(async (command: string) => {
      const dashboardMatch = command.match(new RegExp(`^${escapeRegex(MANAGED_BINARY_PATH)} list-panes -t ([^:]+):dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"$`))
      if (dashboardMatch) {
        return runPsmuxQuery.mock.calls.filter(([recordedCommand]) => recordedCommand === command).length === 1
          ? "%11 0 0 0 200 60"
          : [
              "%11 0 0 0 120 60",
              "%12 1 120 0 80 60",
            ].join("\n")
      }

      const newWindowMatch = command.match(new RegExp(`^${escapeRegex(MANAGED_BINARY_PATH)} new-window -P -F "#{window_index} #{pane_id}" -t ([^ ]+) -n job-runtime-(\\d+) -d -- `))
      if (newWindowMatch) {
        return `${Number(newWindowMatch[2])} %${Number(newWindowMatch[2]) * 10 + 21}`
      }

      throw new Error(`Unexpected query: ${command}`)
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: stubDashboardProcessCommand,
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-old-layout",
    })

    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-old-layout`)
    expect(hasSharedSession).toHaveBeenCalledTimes(1)
    expect(runPsmuxCommand).toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-old-layout`)
    expect(runPsmuxCommand).toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expectCommandContaining(
      runPsmuxCommand.mock.calls.map(([command]) => command),
      `${MANAGED_BINARY_PATH} new-session -d -s parent-session-old-layout -n dashboard -- node --dashboard-process`,
    )
    expect(runPsmuxCommand).toHaveBeenCalledWith(
      `${MANAGED_BINARY_PATH} split-window -t parent-session-old-layout:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile`,
    )
    expect(runPsmuxQuery.mock.calls.filter(([command]) => command.includes("list-panes -t parent-session-old-layout:dashboard"))).toHaveLength(2)
  })

  it("bubbles dashboard discovery query failures without recreating the shared session", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => true)
    const queryError = new Error("psmux list-panes query timed out")
    const runPsmuxQuery = vi.fn(async (command: string) => {
      if (command === `${MANAGED_BINARY_PATH} list-panes -t parent-session-query-failure:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`) {
        throw queryError
      }

      throw new Error(`Unexpected query: ${command}`)
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    await expect(runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-query-failure",
    })).rejects.toBe(queryError)

    expect(hasSharedSession).toHaveBeenCalledTimes(1)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-query-failure`)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expect(runPsmuxCommand.mock.calls.map(([c]) => c).filter((c: string) => c.includes("new-session -d -s parent-session-query-failure"))).toEqual([])
  })

  it("bubbles invalid dashboard discovery output without recreating the shared session", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => true)
    const runPsmuxQuery = vi.fn(async (command: string) => {
      if (command === `${MANAGED_BINARY_PATH} list-panes -t parent-session-invalid-discovery:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`) {
        return "corrupted pane output"
      }

      throw new Error(`Unexpected query: ${command}`)
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    await expect(runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-invalid-discovery",
    })).rejects.toThrow("Invalid psmux pane geometry: 'corrupted pane output'")

    expect(hasSharedSession).toHaveBeenCalledTimes(1)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-invalid-discovery`)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expect(runPsmuxCommand.mock.calls.map(([c]) => c).filter((c: string) => c.includes("new-session -d -s parent-session-invalid-discovery"))).toEqual([])
  })

  it("does not discard a live cached shared session just because one has-session probe says false", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const firstJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-live-cache",
    })

    runPsmuxCommand.mockClear()

    const secondJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-live-cache",
    })

    expect(firstJob.monitor.attachCommand).toBe(secondJob.monitor.attachCommand)
    expect(hasSharedSession).toHaveBeenCalledTimes(1)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} start-server`)
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(expect.stringContaining("new-session -d -s parent-session-live-cache"))
  })

  it("persists the per-job transcript capture target through the stored job metadata path", async () => {
    const sharedClient = createMockPty()
    const runPsmuxQuery = createDashboardQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: vi.fn(async () => sharedClient),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery,
    })
    const store = createJobStore()

    const firstJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    const secondJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    await store.save(createStoredJobRecord(
      "batch-1",
      "parent-session-1",
      "message-1",
      "windows-psmux",
      firstJob,
      firstJob.monitor,
      "running",
      true,
      true,
    ))
    await store.save(createStoredJobRecord(
      "batch-1",
      "parent-session-1",
      "message-1",
      "windows-psmux",
      secondJob,
      secondJob.monitor,
      "running",
      true,
      true,
    ))

    const storedFirstJob = await store.get(`parent-session-1:${firstJob.id}`)
    const storedSecondJob = await store.get(`parent-session-1:${secondJob.id}`)

    expect(storedFirstJob).toMatchObject({
      attachTarget: "parent-session-1:1",
      terminalLogPath: "D:/Omni-Opencode/.omni-monitors/runtime-1.log",
      logTailCommand: undefined,
      transcriptCaptureTarget: "D:/Omni-Opencode/.omni-monitors/runtime-1.log",
    })
    expect(storedSecondJob).toMatchObject({
      attachTarget: "parent-session-1:1",
      terminalLogPath: "D:/Omni-Opencode/.omni-monitors/runtime-2.log",
      logTailCommand: undefined,
      transcriptCaptureTarget: "D:/Omni-Opencode/.omni-monitors/runtime-2.log",
    })
  })
})
