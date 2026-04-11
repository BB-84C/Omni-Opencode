import { readFileSync, rmSync } from "node:fs"
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderDashboard } from "../src/runtime/windows-dashboard-renderer.js"
import {
  buildWindowsPsmuxDashboardSnapshotPath,
  createWindowsPsmuxDashboardLayout,
  createWindowsPsmuxRuntime,
  discoverWindowsPsmuxDashboardLayout,
  registerWindowsPsmuxDashboardJob,
  unregisterWindowsPsmuxDashboardJob,
} from "../src/runtime/windows-psmux.js"

function createManagedInstallResult(binaryPath = "psmux") {
  return {
    binaryPath,
    manifestPath: "D:/Omni-Opencode/.omni-tools/psmux/manifest.json",
    installed: false,
  }
}

const claudeHeavyStdoutFixture = readFileSync(
  new URL("./fixtures/claude-heavy-stdout.jsonl", import.meta.url),
  "utf8",
)

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
  }
}

function createRuntime(options: Parameters<typeof createWindowsPsmuxRuntime>[0]) {
  return createWindowsPsmuxRuntime(options)
}

function joinLines(lines: string[]): string {
  return lines.join("\n")
}

function createTwoPaneDashboardGeometry() {
  return joinLines([
    "%11 0 0 0 120 60",
    "%12 1 120 0 80 60",
  ])
}

function createDashboardListPanesQuery(
  sessionId: string,
  responses: string[],
) {
  let index = 0

  return (command: string) => {
    if (command !== `psmux list-panes -t ${sessionId}:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`) {
      return undefined
    }

    const response = responses[index] ?? responses.at(-1)
    index += 1
    return response ?? ""
  }
}

function createJobWindowQuery(jobWindowOutputs: Record<string, string>) {
  return (command: string) => {
    for (const [jobRuntimeName, windowOutput] of Object.entries(jobWindowOutputs)) {
      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes(jobRuntimeName)) {
        return windowOutput
      }
    }

    return undefined
  }
}

function createDashboardRuntimeQuery(options: {
  sessionId: string
  dashboardResponses?: string[]
  jobWindowOutputs: Record<string, string>
  breakPaneTarget?: string
}) {
  const readDashboard = createDashboardListPanesQuery(
    options.sessionId,
    options.dashboardResponses ?? [createTwoPaneDashboardGeometry()],
  )
  const readJobWindow = createJobWindowQuery(options.jobWindowOutputs)

  return vi.fn<(command: string) => Promise<string>>(async (command) => {
    const dashboardResponse = readDashboard(command)
    if (dashboardResponse !== undefined) {
      return dashboardResponse
    }

    const jobWindowResponse = readJobWindow(command)
    if (jobWindowResponse !== undefined) {
      return jobWindowResponse
    }

    if (command.includes("break-pane")) {
      return options.breakPaneTarget ?? "%91"
    }

    throw new Error(`Unexpected query: ${command}`)
  })
}

function expectCommandContaining(commands: string[], snippet: string) {
  expect(commands.some((command) => command.includes(snippet))).toBe(true)
}

function findLatestSendKeysCommand(commands: string[], paneTarget: string) {
  return commands.findLast((command) => command.includes(`send-keys -t ${paneTarget}`))
}

function createBackendResolutionQueryStub(paths: { codex?: string; node?: string; claude?: string } = {}) {
  const codexPath = paths.codex ?? "C:/tools/codex.exe"
  const nodePath = paths.node ?? "C:/Program Files/nodejs/node.exe"
  const claudePath = paths.claude ?? "C:/tools/claude.exe"

  return vi.fn(async (command: string) => {
    if (command.includes("Failed to resolve codex.js") || command.includes("node_modules/@openai/codex/bin/codex.js")) {
      const match = command.match(/\$commandPath = '([^']+)'/)
      const resolvedShimPath = match?.[1] ?? codexPath
      if (resolvedShimPath.endsWith(".js")) {
        return resolvedShimPath
      }

      const normalizedCodexPath = resolvedShimPath.replace(/\\/g, "/")
      const codexDirectory = normalizedCodexPath.slice(0, normalizedCodexPath.lastIndexOf("/"))
      return `${codexDirectory}/node_modules/@openai/codex/bin/codex.js`
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

async function createTempWorkspace() {
  return mkdtemp(join(tmpdir(), "windows-psmux-dashboard-"))
}

async function readDashboardSnapshot(cwd: string, sessionId: string) {
  const raw = await readFile(buildWindowsPsmuxDashboardSnapshotPath(join(cwd, ".omni-monitors"), sessionId), "utf8")
  return JSON.parse(raw) as {
    jobs: Array<{
      id: string
      status: string
      phase?: string
    }>
  }
}

describe("Windows psmux dashboard layout", () => {
  beforeEach(() => {
    // Clean up leftover dashboard snapshots from prior tests so nextId
    // isn't bumped by stale data in the shared .omni-monitors directory.
    try { rmSync("D:/Omni-Opencode/.omni-monitors/parent-session-1-dashboard.json") } catch {}
    try { rmSync("D:/Omni-Opencode/.omni-monitors/parent-session-shell-refresh-dashboard.json") } catch {}
  })

  it("creates a new dashboard with only one horizontal split", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const sessionId = "parent-session-1"
    const binaryPath = createManagedInstallResult().binaryPath
    const runPsmuxQuery = vi.fn<(command: string) => Promise<string>>(async (command) => {
      if (command === `${binaryPath} list-panes -t ${sessionId}:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`) {
        return createTwoPaneDashboardGeometry()
      }

      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes("job-runtime-1")) {
        return "1 %21"
      }

      throw new Error(`Unexpected query: ${command}`)
    })
    const runtime = createRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand,
      hasSharedSession: async () => false,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: sessionId,
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands).toContain(`${binaryPath} split-window -t ${sessionId}:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile`)
    expect(commands.filter((command) => command.includes("split-window"))).toEqual([
      `${binaryPath} split-window -t ${sessionId}:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile`,
    ])
  })

  it("keeps the legacy non-delegated fallback on script-backed job windows while discovering dashboard panes", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const sessionId = "parent-session-1"
    const binaryPath = createManagedInstallResult().binaryPath
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId,
      dashboardResponses: [createTwoPaneDashboardGeometry()],
      jobWindowOutputs: { "job-runtime-1": "1 %21" },
    })
    const runtime = createRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession: async () => false,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: sessionId,
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands).toContain(`${binaryPath} split-window -t ${sessionId}:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile`)
    expect(runPsmuxQuery).toHaveBeenNthCalledWith(1, `${binaryPath} list-panes -t ${sessionId}:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`)
    expect(runPsmuxQuery.mock.calls.filter(([command]) => command.includes(`list-panes -t ${sessionId}:dashboard`))).toHaveLength(1)
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)
    expectCommandContaining(queryCommands, `${binaryPath} new-window -P -F "#{window_index} #{pane_id}" -t ${sessionId} -n job-runtime-1 -d -- powershell.exe -NoLogo -NoProfile -File`)
    expectCommandContaining(queryCommands, 'runtime-1.ps1')
  })

  it("keeps dashboard window 0 while delegated jobs launch renderer-hosted stream-json windows 1 and 2", { timeout: 10000 }, async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const sessionId = "parent-session-1"
    const binaryPath = createManagedInstallResult().binaryPath
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId,
      dashboardResponses: [createTwoPaneDashboardGeometry()],
      jobWindowOutputs: { "job-runtime-1": "1 %31", "job-runtime-2": "2 %41" },
    })
    const runtime = createRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession: async () => false,
      runPsmuxQuery,
    })

    const codexJob = await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect codex window",
        promptFingerprint: "fingerprint-codex",
        correlationMarker: "omni-opencode:parent-session-1:message-1:codex",
      },
      monitorSessionId: sessionId,
    })
    const claudeJob = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      commandArgs: ["claude", "--print", "hello"],
      launchMetadata: {
        prompt: "inspect claude window",
        promptFingerprint: "fingerprint-claude",
        correlationMarker: "omni-opencode:parent-session-1:message-2:claude-code",
      },
      monitorSessionId: sessionId,
    })

    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)
    expect(queryCommands.filter((command) => command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes('powershell.exe -NoLogo -NoProfile -File'))).toHaveLength(2)
    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands.filter((command) => command.includes("send-keys -t %31"))).toEqual([])
    expect(commands.filter((command) => command.includes("send-keys -t %41"))).toEqual([])
    expect(commands.filter((command) => command.includes("send-keys -t %11") || command.includes("send-keys -t %12"))).toEqual([])
    expect(codexJob.monitor.structuredStreamCaptureTarget).toBe("D:/Omni-Opencode/.omni-monitors/parent-session-1-runtime-1.stream.jsonl")
    expect(claudeJob.monitor.structuredStreamCaptureTarget).toBe("D:/Omni-Opencode/.omni-monitors/parent-session-1-runtime-2.stream.jsonl")
    expect(codexJob.monitor.launch.outputMode).toBe("stream-json-renderer")
    expect(claudeJob.monitor.launch.outputMode).toBe("stream-json-renderer")
    expect(codexJob.monitor.attach.windowIndex).toBe(0)
    expect(claudeJob.monitor.attach.windowIndex).toBe(0)
    expect(codexJob.monitor.window).toEqual({ target: `${sessionId}:1`, index: 1 })
    expect(claudeJob.monitor.window).toEqual({ target: `${sessionId}:2`, index: 2 })
  })

  it("derives left and right dashboard roles from real pane geometry", () => {
    const dashboard = discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%22 1 120 0 80 60",
        "%21 0 0 0 120 60",
      ].join("\n"),
    )

    expect(dashboard.window.target).toBe("parent-session-1:dashboard")
    expect(dashboard.panes.dashboard.target).toBe("%21")
    expect(dashboard.panes.shell.target).toBe("%22")
  })

  it("discovers a two-pane dashboard with a runtime-owned left pane and shell right pane", () => {
    const dashboard = discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      createTwoPaneDashboardGeometry(),
    ) as unknown as {
      panes: Record<string, { id: string; target: string }>
    }

    const panes = Object.values(dashboard.panes)

    expect(panes).toHaveLength(2)
    expect(panes).toContainEqual({ id: "dashboard", target: "%11" })
    expect(panes).toContainEqual({ id: "shell", target: "%12" })
  })

  it("fails clearly on malformed numeric geometry output", () => {
    expect(() => discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%21 0 0 0 120 60",
        "%22 1 120 nope 80 40",
        "%23 2 120 40 80 20",
      ].join("\n"),
    )).toThrow("Invalid psmux pane geometry")
  })

  it("rejects underpopulated dashboard pane lists", () => {
    expect(() => discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%21 0 0 0 120 60",
      ].join("\n"),
    )).toThrow("Expected dashboard 'parent-session-1:dashboard' to have at least 2 panes, found 1")
  })

  it("tolerates extra panes and picks the leftmost as dashboard", () => {
    const layout = discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%21 0 0 0 120 60",
        "%22 1 120 0 80 20",
        "%23 2 120 20 80 20",
        "%24 3 120 40 80 20",
      ].join("\n"),
    )
    expect(layout.panes.dashboard.target).toBe("%21")
    expect(layout.panes.shell.target).toBe("%22")
  })

  it("targets the shared monitor at the dashboard window", async () => {
    const binaryPath = createManagedInstallResult().binaryPath
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      dashboardResponses: [createTwoPaneDashboardGeometry()],
      jobWindowOutputs: { "job-runtime-1": "1 %21" },
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      launchSharedSessionClient: async () => createMockPty(),
      hasSharedSession: async () => false,
      runPsmuxCommand: async () => undefined,
      runPsmuxQuery,
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(job.monitor.attach.target).toBe("parent-session-1:dashboard")
    expect(job.monitor.attachCommand).toBe(`${binaryPath} attach -t parent-session-1`)
  })

  it("does not send dashboard content via send-keys since the dashboard process is file-driven", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      dashboardResponses: [createTwoPaneDashboardGeometry(), createTwoPaneDashboardGeometry()],
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
      },
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
      runPsmuxQuery,
      buildDashboardProcessCommand: (snapshotPath) => `node --dashboard-process "${snapshotPath}"`,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const dashboardSendKeys = commands.filter((command) => command.includes("send-keys -t %11") || command.includes("send-keys -t %12"))

    expect(dashboardSendKeys).toEqual([])
  })

  it("does not send dashboard keys even with multiple jobs", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      dashboardResponses: [
        createTwoPaneDashboardGeometry(),
        createTwoPaneDashboardGeometry(),
        createTwoPaneDashboardGeometry(),
      ],
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
        "job-runtime-3": "3 %51",
      },
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
      runPsmuxQuery,
      buildDashboardProcessCommand: (snapshotPath) => `node --dashboard-process "${snapshotPath}"`,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "codex",
      command: 'codex exec "gamma"',
      monitorSessionId: "parent-session-1",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const dashboardSendKeys = commands.filter((command) => command.includes("send-keys -t %11") || command.includes("send-keys -t %12") || command.includes("send-keys -t %13"))

    expect(dashboardSendKeys).toEqual([])
  })

  it("starts each delegated job in its own renderer-backed execution window instead of treating dashboard slots as canonical homes", { timeout: 10000 }, async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      dashboardResponses: [createTwoPaneDashboardGeometry(), createTwoPaneDashboardGeometry()],
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
      },
      breakPaneTarget: "%51",
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      commandArgs: ["codex", "exec", "alpha"],
      launchMetadata: {
        prompt: "alpha",
        promptFingerprint: "fingerprint-alpha",
        correlationMarker: "omni-opencode:parent-session-1:message-1:codex",
      },
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      commandArgs: ["claude", "--print", "beta"],
      launchMetadata: {
        prompt: "beta",
        promptFingerprint: "fingerprint-beta",
        correlationMarker: "omni-opencode:parent-session-1:message-2:claude-code",
      },
      monitorSessionId: "parent-session-1",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)
    const dashboardSplitCommands = commands.filter((command) => command.includes("split-window -t parent-session-1:dashboard") || command.includes("split-window -t parent-session-1:dashboard.1 -v -p 50 -d"))
    const dashboardListPaneCommands = queryCommands.filter((command) => command.includes('list-panes -t parent-session-1:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"'))

    expect(queryCommands.filter((command) => command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes('powershell.exe -NoLogo -NoProfile -File'))).toHaveLength(2)
    expect(dashboardSplitCommands).toEqual([
      'psmux split-window -t parent-session-1:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile',
    ])
    expect(dashboardListPaneCommands).toHaveLength(1)
    expect(commands.filter((command) => command.includes('pipe-pane -t %31 -o --'))).toEqual([])
    expect(commands.filter((command) => command.includes('pipe-pane -t %41 -o --'))).toEqual([])
    expect(commands.filter((command) => command.includes("pipe-pane -t parent-session-1:job-runtime-"))).toEqual([])
    expect(runPsmuxQuery.mock.calls.filter(([command]) => command.includes('list-panes -t parent-session-1:job-runtime-') && command.includes('#{pane_id}'))).toEqual([])
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(queryCommands.filter((command) => command.includes("break-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("display-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("send-keys -t %31"))).toEqual([])
    expect(commands.filter((command) => command.includes("send-keys -t %41"))).toEqual([])
  })

  it("does not compose latest-job dashboard highlights with join-pane or break-pane", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
        "job-runtime-3": "3 %61",
      },
      breakPaneTarget: "%81",
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
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
    const thirdJob = await runtime.start({
      backend: "codex",
      command: 'codex exec "gamma"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.stop("runtime-1")

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)

    expect(firstJob.monitor.window).toEqual({
      target: "parent-session-1:1",
      index: 1,
    })
    expect(secondJob.monitor.window).toEqual({
      target: "parent-session-1:2",
      index: 2,
    })
    expect(thirdJob.monitor.window).toEqual({
      target: "parent-session-1:3",
      index: 3,
    })
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(queryCommands.filter((command) => command.includes("break-pane"))).toEqual([])
    expect(queryCommands.filter((command) => command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes('job-runtime-'))).toHaveLength(3)
    expect(commands.filter((command) => command.includes("display-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("clear-pane"))).toEqual([])
  })

  it("does not rebalance dashboard highlights with break-pane or split-window when a job stops", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
      },
      breakPaneTarget: "%81",
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.stop("runtime-2")

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)

    expect(queryCommands.filter((command) => command.includes("break-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("split-window -t %12 -v -b -p 50 -d"))).toEqual([])
    expect(commands).toContain("psmux kill-window -t parent-session-1:job-runtime-2")
    expect(commands).not.toContain("psmux kill-window -t parent-session-1:job-runtime-1")
    expect(commands).not.toContain("psmux kill-session -t parent-session-1")
  })

  it("keeps a non-last shared-session job running in memory when kill-window fails", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async (command) => {
      if (command === "psmux kill-window -t parent-session-1:job-runtime-2") {
        throw new Error("kill-window failed")
      }
    })
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createDashboardRuntimeQuery({
      sessionId: "parent-session-1",
      jobWindowOutputs: {
        "job-runtime-1": "1 %31",
        "job-runtime-2": "2 %41",
      },
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "alpha"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })

    await expect(runtime.stop("runtime-2")).rejects.toThrow("kill-window failed")

    const snapshot = await runtime.snapshot()
    expect(snapshot.jobs.find((job) => job.id === "runtime-2")?.status).toBe("running")
    expect(snapshot.jobs.find((job) => job.id === "runtime-1")?.status).toBe("running")
    expect(runPsmuxCommand.mock.calls.map(([command]) => command)).not.toContain("psmux kill-session -t parent-session-1")
  })

  it("uses creation-time pane output so short-lived jobs do not depend on a later empty pane lookup", async () => {
    const runPsmuxCommand = vi.fn<(command: string) => Promise<void>>(async () => undefined)
    const readDashboard = createDashboardListPanesQuery("parent-session-1", [
      createTwoPaneDashboardGeometry(),
    ])
    const readJobWindow = createJobWindowQuery({ "job-runtime-1": "1 %77" })
    const runPsmuxQuery = vi.fn<(command: string) => Promise<string>>(async (command) => {
      const dashboardResponse = readDashboard(command)
      if (dashboardResponse !== undefined) {
        return dashboardResponse
      }

      const jobWindowResponse = readJobWindow(command)
      if (jobWindowResponse !== undefined) {
        return jobWindowResponse
      }

      if (command.includes('list-panes -t parent-session-1:job-runtime-1 -F "#{pane_id}"')) {
        return ""
      }

      throw new Error(`Unexpected query: ${command}`)
    })
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand,
      hasSharedSession: async () => false,
      runPsmuxQuery,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "fast"',
      monitorSessionId: "parent-session-1",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    expect(commands.filter((command) => command.includes('pipe-pane -t %77 -o --'))).toEqual([])
    expect(runPsmuxQuery.mock.calls.filter(([command]) => command.includes('list-panes -t parent-session-1:job-runtime-1 -F "#{pane_id}"'))).toEqual([])
  })

  it("tracks the latest two jobs as dashboard metadata without slot occupancy state", () => {
    const registered = registerWindowsPsmuxDashboardJob(
      registerWindowsPsmuxDashboardJob(
        registerWindowsPsmuxDashboardJob(
          createWindowsPsmuxDashboardLayout("parent-session-1"),
          "runtime-1",
        ),
        "runtime-2",
      ),
      "runtime-3",
    )

    expect((registered as unknown as { metadata?: { highlightedJobIds?: string[] } }).metadata?.highlightedJobIds).toEqual([
      "runtime-2",
      "runtime-3",
    ])
    expect(registered.jobIds).toEqual(["runtime-1", "runtime-2", "runtime-3"])
    expect((registered as unknown as { slots?: unknown }).slots).toBeUndefined()
    expect((registered as unknown as { jobTargets?: Record<string, string> }).jobTargets).toBeUndefined()
  })

  it("removes naturally completed jobs from dashboard highlight metadata while retaining older history", () => {
    const registered = registerWindowsPsmuxDashboardJob(
      registerWindowsPsmuxDashboardJob(
        registerWindowsPsmuxDashboardJob(
          createWindowsPsmuxDashboardLayout("parent-session-1"),
          "runtime-1",
        ),
        "runtime-2",
      ),
      "runtime-3",
    )

    const unregistered = unregisterWindowsPsmuxDashboardJob(registered, "runtime-3")

    expect(unregistered.metadata.highlightedJobIds).toEqual(["runtime-1", "runtime-2"])
    expect(unregistered.jobIds).toEqual(["runtime-1", "runtime-2"])
  })

  it("records active dashboard phase markers and waiting approval from stream events", async () => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect the dashboard",
        promptFingerprint: "fingerprint-dashboard-running",
        correlationMarker: "omni-opencode:parent-session-1:message-1:codex",
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      `${JSON.stringify({ type: "thread.run.started" })}\n${JSON.stringify({ type: "approval.requested", message: "allow once" })}\n`,
      "utf8",
    )

    await runtime.snapshot()
    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "waiting-approval",
        phase: "--> approval.requested",
      }),
    ]))
  })

  it("keeps exact codex provider event names in a running dashboard phase with an active indicator", async () => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect running phase",
        promptFingerprint: "fingerprint-running-phase",
        correlationMarker: "omni-opencode:parent-session-1:message-running:codex",
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      `${JSON.stringify({ type: "item.started" })}\n`,
      "utf8",
    )

    await runtime.snapshot()
    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")
    const rendered = renderDashboard(snapshot as Parameters<typeof renderDashboard>[0], 0)

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "running",
        phase: "--> item.started",
      }),
    ]))
    expect(rendered).toContain(job.id)
    expect(rendered).toContain("⠋")
    expect(rendered).toContain("\x1b[1m\x1b[97m[window 1]\x1b[0m")
    expect(rendered).not.toContain("No delegated jobs yet. Waiting for work...")
    expect(rendered).not.toContain("✓")
    expect(rendered).not.toContain("✗")
  })

  it("shows latest claude event as dashboard phase while running", async () => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude -p "hello" --output-format stream-json',
      commandArgs: ["claude", "-p", "hello", "--output-format", "stream-json"],
      launchMetadata: {
        prompt: "inspect claude streamed lifecycle phases",
        promptFingerprint: "fingerprint-claude-lifecycle-phases",
        correlationMarker: "omni-opencode:parent-session-1:message-noise:claude-code",
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      [
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Working" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "tool-1", input: {} }] } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ].join("\n") + "\n",
      "utf8",
    )

    await runtime.snapshot()
    let snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "running",
        phase: "--> message_delta",
      }),
    ]))

    await writeFile(
      job.monitor.structuredStreamCaptureTarget!,
      [
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Working" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "tool-1", input: {} }] } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ].join("\n") + "\n",
      "utf8",
    )

    await runtime.snapshot()
    snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "completed",
        phase: "--> message_delta",
      }),
    ]))
  })

  it("prefers claude final result.success as the terminal dashboard phase", async () => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude -p "hello" --output-format stream-json',
      commandArgs: ["claude", "-p", "hello", "--output-format", "stream-json"],
      launchMetadata: {
        prompt: "inspect claude result success phase",
        promptFingerprint: "fingerprint-claude-result-success-phase",
        correlationMarker: "omni-opencode:parent-session-1:message-result-success:claude-code",
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(job.monitor.structuredStreamCaptureTarget!, claudeHeavyStdoutFixture, "utf8")

    await runtime.snapshot()
    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "completed",
        phase: "--> result.success",
      }),
    ]))
  })

  it("updates a completed claude job to result.success when that later terminal event arrives", async () => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude -p "hello" --output-format stream-json',
      commandArgs: ["claude", "-p", "hello", "--output-format", "stream-json"],
      launchMetadata: {
        prompt: "inspect delayed claude result success phase",
        promptFingerprint: "fingerprint-delayed-claude-result-success-phase",
        correlationMarker: "omni-opencode:parent-session-1:message-delayed-result-success:claude-code",
      },
      monitorSessionId: "parent-session-1",
    })

    const messageDeltaOnly = [
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      }),
      "",
    ].join("\n")

    const resultOnly = [
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
      }),
      "",
    ].join("\n")

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(job.monitor.structuredStreamCaptureTarget!, messageDeltaOnly, "utf8")

    await runtime.snapshot()

    await appendFile(job.monitor.structuredStreamCaptureTarget!, resultOnly, "utf8")
    await runtime.snapshot()

    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "completed",
        phase: "--> result.success",
      }),
    ]))
  })

  it.each([
    {
      name: "completed",
      backend: "codex" as const,
      event: { type: "turn.completed" },
      expectedStatus: "completed",
      expectedPhase: "--> turn.completed",
    },
    {
      name: "failed",
      backend: "codex" as const,
      event: { type: "error", message: "Containment breach" },
      expectedStatus: "failed",
      expectedPhase: "--> error",
    },
    {
      name: "cancelled",
      backend: "codex" as const,
      event: { type: "turn.cancelled" },
      expectedStatus: "cancelled",
      expectedPhase: "--> turn.cancelled",
    },
  ])("retains %s dashboard lifecycle state from stream events", async ({ backend, event, expectedStatus, expectedPhase }) => {
    const cwd = await createTempWorkspace()
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runShellQuery: createBackendResolutionQueryStub(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend,
      command: backend === "codex" ? 'codex exec --color never "hello"' : 'claude -p "hello" --output-format stream-json',
      commandArgs: backend === "codex"
        ? ["codex", "exec", "--color", "never", "hello"]
        : ["claude", "-p", "hello", "--output-format", "stream-json"],
      launchMetadata: {
        prompt: `inspect ${expectedStatus}`,
        promptFingerprint: `fingerprint-${expectedStatus}`,
        correlationMarker: `omni-opencode:parent-session-1:message-${expectedStatus}:${backend}`,
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(job.monitor.transcriptCaptureTarget!, "renderer output\n", "utf8")
    await writeFile(job.monitor.structuredStreamCaptureTarget!, `${JSON.stringify(event)}\n`, "utf8")

    await runtime.snapshot()
    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: expectedStatus,
        phase: expectedPhase,
      }),
    ]))
  })

  it("keeps renderer backend spawn failures in a failed dashboard state", async () => {
    const cwd = await createTempWorkspace()
    const runShellQuery = createBackendResolutionQueryStub()
    const runtime = createWindowsPsmuxRuntime({
      ...({ runShellQuery } as object),
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      runPsmuxCommand: vi.fn(async () => undefined),
      runPsmuxQuery: createDashboardRuntimeQuery({
        sessionId: "parent-session-1",
        dashboardResponses: [createTwoPaneDashboardGeometry()],
        jobWindowOutputs: { "job-runtime-1": "1 %31" },
      }),
    })

    const job = await runtime.start({
      backend: "codex",
      command: 'codex exec --color never "hello"',
      commandArgs: ["codex", "exec", "--color", "never", "hello"],
      launchMetadata: {
        prompt: "inspect renderer spawn failure",
        promptFingerprint: "fingerprint-renderer-spawn-failure",
        correlationMarker: "omni-opencode:parent-session-1:message-renderer-spawn-failure:codex",
      },
      monitorSessionId: "parent-session-1",
    })

    await writeFile(
      job.monitor.transcriptCaptureTarget!,
      "[renderer] error: spawn codex ENOENT\n__OMNI_OPENCODE_PSMUX_EXIT__:1\n",
      "utf8",
    )

    await runtime.snapshot()
    const snapshot = await readDashboardSnapshot(cwd, "parent-session-1")

    expect(snapshot.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        status: "failed",
        phase: "--> renderer exited with code 1",
      }),
    ]))
  })
})
