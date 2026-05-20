import { beforeEach, describe, expect, it, vi } from "vitest"
import { rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectRuntime } from "../src/runtime/select-runtime.js"
import { ARCHIVED_RUNTIME_KINDS } from "../src/runtime/types.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeReadResult, RuntimeSnapshot } from "../src/runtime/types.js"
import { createWindowsPsmuxRuntime } from "../src/runtime/windows-psmux.js"
import * as windowsPsmuxModule from "../src/runtime/windows-psmux.js"
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

    const newWindowMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} new-window -P -F "#{window_index} #{pane_id}" -t ([^ ]+) -n job-runtime-(\\d+)(?: -c .+?)? -d -- `))
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

    const newWindowMatch = command.match(new RegExp(`^${escapeRegex(binaryPath)} new-window -P -F "#{window_index} #{pane_id}" -t ([^ ]+) -n job-runtime-(\\d+)(?: -c .+?)? -d -- `))
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

function createBackendResolutionQueryStub(paths: { codex?: string; codexCmd?: string; node?: string; claude?: string } = {}) {
  const codexPath = paths.codex ?? "C:/tools/codex.exe"
  const codexCmdPath = paths.codexCmd ?? "C:/Users/test/AppData/Roaming/npm/codex.cmd"
  const nodePath = paths.node ?? "C:/Program Files/nodejs/node.exe"
  const claudePath = paths.claude ?? "C:/tools/claude.exe"

  return vi.fn(async (command: string) => {
    if (command.includes("Failed to resolve codex.js") || command.includes("node_modules/@openai/codex/bin/codex.js")) {
      const match = command.match(/\$commandPath = '([^']+)'/)
      const resolvedShimPath = match?.[1]
        ?? (command.includes(codexCmdPath) ? codexCmdPath : codexPath)
      if (resolvedShimPath.endsWith(".js")) {
        return resolvedShimPath
      }

      const normalizedCodexPath = resolvedShimPath.replace(/\\/g, "/")
      const codexDirectory = normalizedCodexPath.slice(0, normalizedCodexPath.lastIndexOf("/"))
      return `${codexDirectory}/node_modules/@openai/codex/bin/codex.js`
    }

    if (command.includes("Get-Command 'codex.cmd'")) {
      return codexCmdPath
    }

    if (command.includes("Get-Command 'codex'")) {
      return codexPath
    }

    if (command.includes("Get-Command 'node'")) {
      return nodePath
    }

    if (command.includes("Get-Command 'claude'")) {
      return claudePath
    }

    throw new Error(`Unexpected shell query: ${command}`)
  })
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

async function runNodeScript(
  scriptPath: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr })
    })
  })
}

function buildExpectedDelegatedTranscriptHeader(prompt: string): string[] {
  return [
    "[omni-opencode] prompt",
    prompt,
    "------------------------------",
  ]
}

function encodeDelegatedTranscriptHeader(prompt: string): string {
  return Buffer.from(`${buildExpectedDelegatedTranscriptHeader(prompt).join("\n")}\n`, "utf8").toString("base64")
}

function buildClaudeBackendScriptWithPolicy(
  backendCommand: string,
  promptText: string,
  policy: {
    allowedTools: string[]
    disallowedTools: string[]
    permissionMode: string
  },
) {
  const builder = (windowsPsmuxModule as {
    buildWindowsPsmuxClaudeBackendScript?: (
      backendCommand: string,
      promptText: string,
      policy: {
        allowedTools: string[]
        disallowedTools: string[]
        permissionMode: string
      },
    ) => string
  }).buildWindowsPsmuxClaudeBackendScript

  if (typeof builder !== "function") {
    throw new Error("Expected windows-psmux to export buildWindowsPsmuxClaudeBackendScript")
  }

  return builder(backendCommand, promptText, policy)
}

type ExpectedCodexPolicy = {
  sandboxMode: "read-only" | "workspace-write"
  writableRoots: string[]
  networkAccess: boolean
  approvalPolicy: string
}

describe("Windows psmux runtime contract", () => {
  beforeEach(() => {
    // Clean up leftover dashboard snapshots from prior tests so nextId
    // isn't bumped by stale data in the shared .omni-monitors directory.
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs")
      for (const f of readdirSync("D:/Omni-Opencode/.omni-monitors")) {
        if (f.startsWith("parent-session-") && f.endsWith("-dashboard.json")) {
          rmSync(`D:/Omni-Opencode/.omni-monitors/${f}`)
        }
      }
    } catch {}
  })

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

  it("quotes the generated job script path when the workspace path contains spaces", async () => {
    const workspace = await createTempWorkspace("windows psmux spaced workspace")
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-space-path",
    })

    const commands = (runPsmuxQuery.mock.calls as unknown as Array<[string]>).map(([command]) => command)
    expectCommandContaining(commands, 'powershell.exe -NoLogo -NoProfile -File "')
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
    // hasSharedSession is called on every ensureSharedSession: once for the first start (no cache),
    // once for the second start (cache hit, liveness check), and once for openMonitor on a different session.
    expect(hasSharedSession).toHaveBeenCalledWith("parent-session-reattach")
    expect(hasSharedSession).toHaveBeenCalledWith("parent-session-detached")
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
      hasSharedSession: async () => false,
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

  it("writes per-job transcript scripts without changing the visible attach contract", async () => {
    const cwd = await createTempWorkspace()
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
      cwd,
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
    expect(firstJob.monitor.transcriptCaptureTarget).toBe(`${cwd.replace(/\\/g, "/")}/.omni-monitors/parent-session-1-runtime-1.log`)
    expect(secondJob.monitor.transcriptCaptureTarget).toBe(`${cwd.replace(/\\/g, "/")}/.omni-monitors/parent-session-1-runtime-2.log`)
    const commands = (runPsmuxCommand.mock.calls as unknown as Array<[string]>).map(([command]) => command)
    expect(commands.filter((command) => command.includes("pipe-pane -t %31 -o --"))).toEqual([])
    expect(commands.filter((command) => command.includes("pipe-pane -t %41 -o --"))).toEqual([])
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(runPsmuxQuery.mock.calls.map(([command]) => command).filter((command) => command.includes("break-pane"))).toEqual([])

    const firstJobScript = await readFile(join(cwd, ".omni-monitors", "runtime-1.ps1"), "utf8")
    const secondJobScript = await readFile(join(cwd, ".omni-monitors", "runtime-2.ps1"), "utf8")

    expect(firstJobScript).toContain('claude --print "hello"')
    expect(secondJobScript).toContain('codex exec "hello"')
    expect(firstJobScript).toContain('Tee-Object -FilePath')
    expect(secondJobScript).toContain('Tee-Object -FilePath')
    expect(firstJobScript).toContain('parent-session-1-runtime-1.log')
    expect(secondJobScript).toContain('parent-session-1-runtime-2.log')
    expect(firstJobScript).toContain('__OMNI_OPENCODE_PSMUX_EXIT__')
    expect(secondJobScript).toContain('__OMNI_OPENCODE_PSMUX_EXIT__')
  })

  it("launches each job window in the per-job cwd when provided", async () => {
    const runtimeCwd = await createTempWorkspace()
    const jobCwd = await createTempWorkspace()
    const runPsmuxQuery = createDashboardQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: runtimeCwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-cwd",
      cwd: jobCwd,
    })

    const newWindowCommand = runPsmuxQuery.mock.calls
      .map(([command]) => command)
      .find((command) => command.includes("new-window -P -F"))

    expect(newWindowCommand).toContain(` -c ${jobCwd.replace(/\\/g, "/")}`)
  })

  it("launches delegated codex job windows through a stream-json renderer", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()
    const runPsmuxArgQuery = vi.fn(async () => "1 %31")
    const runShellCommand = vi.fn(async () => undefined)
    const workspace = await createTempWorkspace()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellCommand,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand,
      runPsmuxQuery,
      runPsmuxArgQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-1",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-1:codex",
        requestedModel: "gpt-5-codex",
        requestedReasoningEffort: "medium",
        effectiveModel: "gpt-5-codex",
        effectiveReasoningEffort: "medium",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    expect(runPsmuxArgQuery).not.toHaveBeenCalled()
    const jobScript = await readFile(join(workspace, ".omni-monitors", "runtime-1.ps1"), "utf8")
    const rendererScript = await readFile(join(workspace, ".omni-monitors", "delegation-renderer.cjs"), "utf8")
    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")
    expect(jobScript).toContain("delegation-renderer.cjs")
    expect(jobScript).toContain("parent-session-direct-cli-runtime-1.backend.ps1")
    expect(jobScript).toContain(`& 'C:/Program Files/nodejs/node.exe'`)
    expect(rendererScript).toContain("const backendScriptPath = process.argv[5];")
    expect(rendererScript).toContain("const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath]")
    expect(backendScript).toContain('& "C:/Program Files/nodejs/node.exe"')
    expect(backendScript).toContain('FromBase64String')
    expect(backendScript).toContain('$omniPrompt')
    expect(backendScript).toContain("$omniCodexArgs = @('exec', '--json', '-')")
    expect(backendScript).toContain("$omniCodexArgs += '--model'")
    expect(backendScript).toContain("$omniCodexArgs += 'gpt-5-codex'")
    expect(backendScript).toContain("$omniCodexArgs += '-c'")
    expect(backendScript).toContain('model_reasoning_effort="medium"')
    expect(backendScript).toContain('$omniPrompt | & "C:/Program Files/nodejs/node.exe" "C:/tools/node_modules/@openai/codex/bin/codex.js" @omniCodexArgs')
  })

  it("derives the codex backend script from a configured codex shim path", async () => {
    const workspace = await createTempWorkspace()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'C:/custom/npm/codex.cmd exec --color never "hello"',
      commandArgs: ["C:/custom/npm/codex.cmd", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-custom-codex-shim",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-custom-codex:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")

    expect(backendScript).toContain('FromBase64String')
    expect(backendScript).toContain('$omniPrompt | & "C:/Program Files/nodejs/node.exe" "C:/custom/npm/node_modules/@openai/codex/bin/codex.js" @omniCodexArgs')
  })

  it("falls back to launching the resolved Codex executable when npm-style codex.js resolution is unavailable", async () => {
    const workspace = await createTempWorkspace()
    const runShellQuery = vi.fn(async (command: string) => {
      if (command.includes("Get-Command 'node'")) {
        return "C:/Program Files/nodejs/node.exe"
      }

      if (command.includes("Get-Command 'codex'")) {
        return "C:/portable/codex.exe"
      }

      if (command.includes("node_modules/@openai/codex/bin/codex.js")) {
        throw new Error("Failed to resolve codex.js")
      }

      throw new Error(`Unexpected shell query: ${command}`)
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery,
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-fallback-codex-exe",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-fallback-codex:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")

    expect(backendScript).toContain('FromBase64String')
    expect(backendScript).toContain("$omniCodexArgs = @('exec', '--json', '-')")
    expect(backendScript).toContain('$omniPrompt | & "C:/portable/codex.exe" @omniCodexArgs')
    expect(backendScript).not.toContain('node_modules/@openai/codex/bin/codex.js')
  })

  it("includes mapped Codex sandbox settings in delegated backend scripts", async () => {
    const workspace = await createTempWorkspace()
    const expectedCodexPolicy: ExpectedCodexPolicy = {
      sandboxMode: "workspace-write",
      writableRoots: [workspace],
      networkAccess: false,
      approvalPolicy: "never",
    }

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-codex-policy",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-policy:codex",
        codexPolicy: expectedCodexPolicy,
      } as {
        prompt: string
        promptFingerprint: string
        correlationMarker: string
        codexPolicy: ExpectedCodexPolicy
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")
    const codexConfigPath = join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.codex-config.json")
    const codexConfig = JSON.parse(await readFile(codexConfigPath, "utf8")) as ExpectedCodexPolicy

    expect(codexConfig).toEqual(expectedCodexPolicy)
    expect(backendScript).toContain("parent-session-direct-cli-runtime-1.codex-config.json")
    expect(backendScript).not.toContain(`--config \"${codexConfigPath.replace(/\\/g, "/")}\"`)
    expect(backendScript).toContain("Get-Content")
    expect(backendScript).toContain("ConvertFrom-Json")
    expect(backendScript).toContain("$omniCodexArgs += '-c'")
    expect(backendScript).toContain("sandbox_mode=")
    expect(backendScript).toContain("approval_policy=")
    expect(backendScript).toContain("--add-dir")
    expect(backendScript).not.toContain("sandbox_workspace_write.writable_roots=")
  })

  it("encodes multiline Codex prompts safely in delegated backend scripts", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const prompt = [
      "In the current workspace, update or create `hi.md` so its full content is exactly:",
      "",
      ' Hi "Codex\\',
      "",
      "Make only that requested change.",
    ].join("\n")

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt,
        promptFingerprint: "fingerprint-codex-multiline-prompt",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-multiline:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")

    expect(backendScript).toContain("FromBase64String")
    expect(backendScript).toContain("$omniPrompt")
    expect(backendScript).toContain("@('exec', '--json', '-')")
    expect(backendScript).toContain("$omniPrompt | &")
    expect(backendScript).not.toContain(prompt)
    expect(backendScript).not.toContain("$omniCodexArgs += 'In the current workspace")
  })

  it("resolves delegated backend executables before renderer launch", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()
    const runShellQuery = createBackendResolutionQueryStub()

    const runtime = createWindowsPsmuxRuntime({
      ...({ runShellQuery } as object),
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-resolved-codex",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-resolved:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const jobScript = await readFile("D:/Omni-Opencode/.omni-monitors/runtime-1.ps1", "utf8")

    expect(runShellQuery.mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining([
      expect.stringContaining("Get-Command 'node'"),
      expect.stringContaining("Get-Command 'codex'"),
    ]))
    expect(jobScript).toContain("'C:/Program Files/nodejs/node.exe'")
  })

  it("launches delegated claude job windows through a stream-json renderer", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()
    const runPsmuxArgQuery = vi.fn(async () => "1 %31")
    const workspace = await createTempWorkspace()

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand,
      runPsmuxQuery,
      runPsmuxArgQuery,
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        claudePolicy: {
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
          disallowedTools: ["WebFetch", "WebSearch"],
          permissionMode: "bypassPermissions",
        },
        prompt: "inspect the overseer terminal",
        promptFingerprint: "fingerprint-claude-1",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-2:claude-code",
        requestedModel: "claude-opus-4-1",
        requestedReasoningEffort: "high",
        effectiveModel: "claude-opus-4-1",
        effectiveReasoningEffort: "high",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    expect(runPsmuxArgQuery).not.toHaveBeenCalled()
    const jobScript = await readFile(join(workspace, ".omni-monitors", "runtime-1.ps1"), "utf8")
    const rendererScript = await readFile(join(workspace, ".omni-monitors", "delegation-renderer.cjs"), "utf8")
    const backendScript = await readFile(join(workspace, ".omni-monitors", "parent-session-direct-cli-runtime-1.backend.ps1"), "utf8")
    expect(jobScript).toContain("delegation-renderer.cjs")
    expect(jobScript).toContain("parent-session-direct-cli-runtime-1.backend.ps1")
    expect(rendererScript).toContain("const backendScriptPath = process.argv[5];")
    expect(rendererScript).toContain("const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath]")
    expect(rendererScript).toContain("const payload = record && typeof record.event === 'object' && record.event ? record.event : record;")
    expect(rendererScript).toContain("delta && typeof delta.type === 'string' && delta.type === 'text_delta'")
    expect(backendScript).toContain('& "C:/tools/claude.exe" -p "inspect the overseer terminal')
    expect(backendScript).toContain('--output-format stream-json --verbose --include-partial-messages')
    expect(backendScript).toContain('--model claude-opus-4-1')
    expect(backendScript).toContain('--effort high')
    expect(backendScript).toContain("--permission-mode bypassPermissions")
    expect(backendScript).toContain("--allowedTools Read,Glob,Grep,Edit,Write,Bash")
    expect(backendScript).toContain("--disallowedTools WebFetch,WebSearch")
  })

  it("builds Claude backend scripts with mapped permission flags", () => {
    const backendScript = buildClaudeBackendScriptWithPolicy(
      "C:/tools/claude.exe",
      "inspect the overseer terminal [marker: omni-opencode:parent-session-direct-cli:message-permissions:claude-code]",
      {
        allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        disallowedTools: ["WebFetch", "WebSearch"],
        permissionMode: "bypassPermissions",
      },
    )

    expect(backendScript).toContain("--permission-mode bypassPermissions")
    expect(backendScript).toContain("--allowedTools Read,Glob,Grep,Edit,Write,Bash")
    expect(backendScript).toContain("--disallowedTools WebFetch,WebSearch")
  })

  it("treats Codex stderr as backend progress noise without replacing stdout transcript content", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-codex-transcript",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-transcript:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-codex-fixture.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-codex-fixture.log")
    const streamPath = join(logDirectory, "renderer-codex-fixture.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "thread.message.delta", delta: "Final answer" })}')`,
      `[Console]::Error.WriteLine('Reading additional input from stdin...')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "turn.completed" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "codex",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toContain("Final answer\n")
    expect(transcript).toContain("[codex] progress: Reading additional input from stdin...\n")
    expect(transcript).not.toContain("[codex] final result\n")
    expect(transcript).not.toContain("[codex stderr]")
  })

  it("preserves markdown-like readability in the live Windows transcript renderer path", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect transcript markdown formatting",
        promptFingerprint: "fingerprint-codex-markdown-transcript",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-markdown-transcript:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-codex-markdown-fixture.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-codex-markdown-fixture.log")
    const streamPath = join(logDirectory, "renderer-codex-markdown-fixture.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "thread.message.delta", delta: "## Findings\n- Package name: `omni-opencode`" })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "turn.completed" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "codex",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe([
      "\x1b[1m\x1b[36mFindings\x1b[0m",
      "  • Package name: \x1b[36momni-opencode\x1b[0m",
      "",
    ].join("\n"))
  })

  it("renders Codex transcripts with retained progress and direct final output in the live Windows path", async () => {
    const prompt = "inspect live cli transcript feel"
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt,
        promptFingerprint: "fingerprint-codex-cli-like-transcript",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-cli-like-transcript:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-codex-cli-like-fixture.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-codex-cli-like-fixture.log")
    const streamPath = join(logDirectory, "renderer-codex-cli-like-fixture.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Error.WriteLine('Inspecting package metadata')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "assistant.message.delta", delta: "Inspecting package metadata" })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "## Findings\n- Package name: `omni-opencode`" } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "turn.completed" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "codex",
      transcriptPath,
      streamPath,
      backendScriptPath,
      encodeDelegatedTranscriptHeader(prompt),
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe([
      ...buildExpectedDelegatedTranscriptHeader(prompt),
      "[codex] progress: Inspecting package metadata",
      "Inspecting package metadata",
      "\x1b[1m\x1b[36mFindings\x1b[0m",
      "  • Package name: \x1b[36momni-opencode\x1b[0m",
      "",
    ].join("\n"))
    expect(transcript.indexOf("[omni-opencode] prompt\n")).toBe(0)
    expect(transcript.match(/\[omni-opencode\] prompt/g)).toHaveLength(1)
  })

  it("renders Codex final text when it only arrives on turn.completed", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect codex final turn text",
        promptFingerprint: "fingerprint-codex-final-turn-text",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-final-turn-text:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-codex-final-turn-text.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-codex-final-turn-text.log")
    const streamPath = join(logDirectory, "renderer-codex-final-turn-text.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "turn.completed", text: "## Findings\n- Package name: `omni-opencode`" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "codex",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe([
      "\x1b[1m\x1b[36mFindings\x1b[0m",
      "  • Package name: \x1b[36momni-opencode\x1b[0m",
      "",
    ].join("\n"))
  })

  it("coalesces Claude text deltas and suppresses duplicate assistant or result snapshots in transcript output", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt: "inspect the overseer terminal",
        promptFingerprint: "fingerprint-claude-transcript",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-claude-transcript:claude-code",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-claude-fixture.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-claude-fixture.log")
    const streamPath = join(logDirectory, "renderer-claude-fixture.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1", role: "assistant", content: [] } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PACKAGE: omni-opencode" } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\nTITLE: Omni-Opencode" } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode" }] } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "result", subtype: "success", result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "claude-code",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe("PACKAGE: omni-opencode\nTITLE: Omni-Opencode\n")
  })

  it("waits for late Claude result text before writing the final result marker", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt: "inspect late claude result",
        promptFingerprint: "fingerprint-claude-late-result",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-claude-late-result:claude-code",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-claude-late-result.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-claude-late-result.log")
    const streamPath = join(logDirectory, "renderer-claude-late-result.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1", role: "assistant", content: [] } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null } } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "result", subtype: "success", result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "claude-code",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe("PACKAGE: omni-opencode\nTITLE: Omni-Opencode\n")
  })

  it("renders summarized intermediate Claude tool activity without dumping raw tool payloads", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt: "inspect tool activity",
        promptFingerprint: "fingerprint-claude-tool-summary",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-claude-tool-summary:claude-code",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-claude-tool-summary.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-claude-tool-summary.log")
    const streamPath = join(logDirectory, "renderer-claude-tool-summary.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "D:/Omni-Opencode/package.json" } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "tool_result", tool_use_id: "toolu_01", is_error: true, content: [{ type: "text", text: "{\"name\":\"omni-opencode\"}" }] })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "result", subtype: "success", result: "## Findings\n- Package name: `omni-opencode`" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "claude-code",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe([
      "[claude] tool_use: Read",
      "[claude] tool_result: error",
      "\x1b[1m\x1b[36mFindings\x1b[0m",
      "  • Package name: \x1b[36momni-opencode\x1b[0m",
      "",
    ].join("\n"))
    expect(transcript).not.toContain('{"name":"omni-opencode"}')
  })

  it("renders Claude transcripts with concise tool lines and direct assistant output in the live Windows path", async () => {
    const prompt = "inspect claude cli transcript feel"
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt,
        promptFingerprint: "fingerprint-claude-cli-like-transcript",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-claude-cli-like-transcript:claude-code",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-claude-cli-like-fixture.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-claude-cli-like-fixture.log")
    const streamPath = join(logDirectory, "renderer-claude-cli-like-fixture.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "tool_use", id: "toolu_02", name: "Read", input: { file_path: "D:/Omni-Opencode/package.json" } })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "ok" }] })}')`,
      `[Console]::Out.WriteLine('${JSON.stringify({ type: "result", subtype: "success", result: "## Findings\n- Package name: `omni-opencode`" })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "claude-code",
      transcriptPath,
      streamPath,
      backendScriptPath,
      encodeDelegatedTranscriptHeader(prompt),
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe([
      ...buildExpectedDelegatedTranscriptHeader(prompt),
      "[claude] tool_use: Read",
      "[claude] tool_result: ok",
      "\x1b[1m\x1b[36mFindings\x1b[0m",
      "  • Package name: \x1b[36momni-opencode\x1b[0m",
      "",
    ].join("\n"))
    expect(transcript.indexOf("[omni-opencode] prompt\n")).toBe(0)
    expect(transcript.match(/\[omni-opencode\] prompt/g)).toHaveLength(1)
    expect(transcript).not.toContain('{"type":"tool_use"')
    expect(transcript).not.toContain('[claude] final result')
  })

  it("flushes a final structured JSON line even when stdout ends without a trailing newline", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect unterminated codex output",
        promptFingerprint: "fingerprint-codex-unterminated-output",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-codex-unterminated:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const logDirectory = join(workspace, ".omni-monitors")
    const rendererScriptPath = join(logDirectory, "delegation-renderer.cjs")
    const backendScriptPath = join(logDirectory, "renderer-codex-unterminated.backend.ps1")
    const transcriptPath = join(logDirectory, "renderer-codex-unterminated.log")
    const streamPath = join(logDirectory, "renderer-codex-unterminated.stream.log")

    await writeFile(backendScriptPath, [
      `[Console]::Out.Write('${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } })}')`,
    ].join("\n"), "utf8")

    const result = await runNodeScript(rendererScriptPath, [
      "codex",
      transcriptPath,
      streamPath,
      backendScriptPath,
    ])

    expect(result.exitCode).toBe(0)
    const transcript = await readFile(transcriptPath, "utf8")

    expect(transcript).toBe("Final answer\n")
  })

  it("marks delegated jobs complete from structured stream completion events", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the vault door",
        promptFingerprint: "fingerprint-1",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-1:codex",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      `${JSON.stringify({ type: "thread.message.delta", delta: "renderer output" })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
      "utf8",
    )

    await expect(runtime.read(job.id)).resolves.toEqual({ data: "renderer output\n" })
    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, status: "stopped" }),
    ]))
  })

  it("marks delegated renderer jobs complete from plain-text Claude output and NUL-padded exit markers", async () => {
    const workspace = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt: "inspect the overseer terminal",
        promptFingerprint: "fingerprint-claude-raw-fallback",
        correlationMarker: "omni-opencode:parent-session-direct-cli:message-3:claude-code",
      },
      monitorSessionId: "parent-session-direct-cli",
    })

    const jobScript = await readFile(join(workspace, ".omni-monitors", "runtime-1.ps1"), "utf8")
    expect(jobScript).toContain('__OMNI_OPENCODE_PSMUX_EXIT__')

    await writeFile(
      job.monitor.transcriptCaptureTarget!,
      `renderer output\n${"__OMNI_OPENCODE_PSMUX_EXIT__:0".split("").join("\0")}\n`,
      "utf8",
    )
    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      "Plain Claude text output\n",
      "utf8",
    )

    await expect(runtime.read(job.id)).resolves.toEqual({ data: "renderer output\n" })
    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, status: "stopped" }),
    ]))
  })

  it("keeps non-delegated commandArgs launches on the legacy script-backed wrapper path", async () => {
    const workspace = await createTempWorkspace()
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createDashboardQueryStub()
    const runPsmuxArgQuery = vi.fn(async () => "1 %31")

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: workspace,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      runPsmuxArgQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      monitorSessionId: "parent-session-legacy-command-args",
    })

    expect(runPsmuxArgQuery).not.toHaveBeenCalled()
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)
    expectCommandContaining(
      queryCommands,
      `${MANAGED_BINARY_PATH} new-window -P -F "#{window_index} #{pane_id}" -t parent-session-legacy-command-args -n job-runtime-1 -d -- powershell.exe -NoLogo -NoProfile -File`,
    )
    expectCommandContaining(queryCommands, "runtime-1.ps1")
    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands.filter((command) => command.includes("send-keys -t %31"))).toEqual([])
    const jobScript = await readFile(join(workspace, ".omni-monitors", "runtime-1.ps1"), "utf8")
    expect(jobScript).toContain('codex exec --color never "hello"')
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

  it("marks a job stopped during snapshot even if runtime.read already consumed the exit marker", async () => {
    const readTranscriptCaptureFile = vi
      .fn(async (_target: string, offset: number) => {
        if (offset === 0) {
          const data = "line one\n__OMNI_OPENCODE_PSMUX_EXIT__:0\n"
          return { data, nextOffset: data.length }
        }

        return { data: "", nextOffset: offset }
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

    await expect(runtime.read(job.id)).resolves.toEqual({ data: "line one\n" })
    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, status: "stopped" }),
    ]))
  })

  it("parses inline exit markers after transcript output without a trailing newline", async () => {
    const readTranscriptCaptureFile = vi
      .fn(async (_target: string, offset: number) => {
        if (offset === 0) {
          const data = "final line without newline__OMNI_OPENCODE_PSMUX_EXIT__:0\n"
          return { data, nextOffset: data.length }
        }

        return { data: "", nextOffset: offset }
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
      monitorSessionId: "parent-session-inline-exit-marker",
    })

    await expect(runtime.read(job.id)).resolves.toEqual({ data: "final line without newline\n" })

    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, status: "stopped" }),
    ]))
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
      hasSharedSession: async () => false,
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
    // Old layout (1 pane) triggers a repair: split-window adds the missing pane
    // without killing the session, preserving old job windows.
    expect(runPsmuxCommand).not.toHaveBeenCalledWith(`${MANAGED_BINARY_PATH} kill-session -t parent-session-old-layout`)
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

  it("respawns the dashboard process in the left pane when reattaching to an existing session", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => true)
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

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-respawn",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const respawnCommands = commands.filter((command) => command.includes("respawn-pane"))

    expect(respawnCommands).toHaveLength(1)
    expect(respawnCommands[0]).toContain("respawn-pane -k -t %11")
    // Dashboard command is sent via send-keys after respawn (psmux ignores -- <cmd> on respawn-pane)
    const sendKeysCommands = commands.filter((command) => command.includes("send-keys -t %11"))
    expect(sendKeysCommands.length).toBeGreaterThanOrEqual(1)
    expect(sendKeysCommands.some((c) => c.includes("node"))).toBe(true)
    expect(commands.filter((command) => command.includes("kill-session"))).toEqual([])
    expect(commands.filter((command) => command.includes("kill-window -t parent-session-respawn:dashboard"))).toEqual([])
  })

  it("does not respawn the dashboard process when creating a brand new session", async () => {
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

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-new",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands.filter((command) => command.includes("respawn-pane"))).toEqual([])
  })

  it("preserves the right-pane shell and job windows when respawning the dashboard process", async () => {
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => true)
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

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-preserve",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)

    expect(commands.filter((command) => command.includes("kill-session"))).toEqual([])
    expect(commands.filter((command) => command.includes("kill-window"))).toEqual([])
    expect(commands.filter((command) => command.includes("split-window"))).toEqual([])
    expect(commands.filter((command) => command.includes("respawn-pane -k -t %11"))).toHaveLength(1)
    expect(commands.filter((command) => command.includes("respawn-pane -k -t %12"))).toEqual([])
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

})
