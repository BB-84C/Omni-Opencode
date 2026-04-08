import { describe, expect, it, vi } from "vitest"
import {
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

describe("Windows psmux dashboard layout", () => {
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

  it("creates the dashboard with real split-window commands and discovers left and right pane ids from list-panes", async () => {
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
    expectCommandContaining(queryCommands, `${binaryPath} new-window -P -F "#{window_index} #{pane_id}" -t ${sessionId} -n job-runtime-1 -d -- powershell.exe`)
    expectCommandContaining(queryCommands, 'codex exec "hello"')
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
    )).toThrow("Expected dashboard 'parent-session-1:dashboard' to have exactly 2 panes, found 1")
  })

  it("rejects a vertical top and bottom two-pane dashboard layout", () => {
    expect(() => discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%21 0 0 0 120 30",
        "%22 1 0 30 120 30",
      ].join("\n"),
    )).toThrow("Expected dashboard 'parent-session-1:dashboard' to use a left/right split in window 0")
  })

  it("rejects overpopulated dashboard pane lists", () => {
    expect(() => discoverWindowsPsmuxDashboardLayout(
      "parent-session-1",
      [
        "%21 0 0 0 120 60",
        "%22 1 120 0 80 20",
        "%23 2 120 20 80 20",
        "%24 3 120 40 80 20",
      ].join("\n"),
    )).toThrow("Expected dashboard 'parent-session-1:dashboard' to have exactly 2 panes, found 4")
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

  it("renders dashboard guidance and highlighted jobs inline in the left dashboard pane", async () => {
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
    const leftPaneRender = findLatestSendKeysCommand(commands, "%11")

    expect(leftPaneRender).toBeDefined()
    expect(leftPaneRender).toContain("Session: parent-session-1")
    expect(leftPaneRender).toContain("Window 0: dashboard")
    expect(leftPaneRender).toContain("Do not run psmux attach inside this shared session.")
    expect(leftPaneRender).toContain("Delegated jobs:")
    expect(leftPaneRender).toContain("runtime-1 [codex] -> window 1")
    expect(leftPaneRender).toContain("runtime-2 [claude-code] -> window 2")
    expect(commands.filter((command) => command.includes("send-keys -t %12"))).toEqual([])
  })

  it("renders only the latest two jobs inline in the left dashboard pane instead of separate highlight panes", async () => {
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
    const dashboardRenderCommand = findLatestSendKeysCommand(commands, "%11")
    const sendKeysCommands = commands.filter((command) => command.includes("send-keys -t"))

    expect(sendKeysCommands.length).toBeGreaterThan(0)
    expect(sendKeysCommands.every((command) => command.includes("send-keys -t %11"))).toBe(true)
    expect(dashboardRenderCommand).toBeDefined()
    expect(commands.filter((command) => command.includes("send-keys -t %12"))).toEqual([])
    expect(dashboardRenderCommand).not.toContain("runtime-1 [codex] -> window 1")
    expect(dashboardRenderCommand).toContain("runtime-2 [claude-code] -> window 2")
    expect(dashboardRenderCommand).toContain("runtime-3 [codex] -> window 3")
    expect(commands.filter((command) => command.includes("send-keys -t %13"))).toEqual([])
  })

  it("starts each delegated job in its own real execution window instead of treating dashboard slots as canonical homes", async () => {
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
      monitorSessionId: "parent-session-1",
    })
    await runtime.start({
      backend: "claude-code",
      command: 'claude --print "beta"',
      monitorSessionId: "parent-session-1",
    })

    const commands = runPsmuxCommand.mock.calls.map(([command]) => command)
    const queryCommands = runPsmuxQuery.mock.calls.map(([command]) => command)
    const newWindowCommands = queryCommands.filter((command) => command.includes('new-window -P -F "#{window_index} #{pane_id}"'))
    const dashboardSplitCommands = commands.filter((command) => command.includes("split-window -t parent-session-1:dashboard") || command.includes("split-window -t parent-session-1:dashboard.1 -v -p 50 -d"))
    const dashboardListPaneCommands = queryCommands.filter((command) => command.includes('list-panes -t parent-session-1:dashboard -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"'))

    expect(newWindowCommands[0]).toContain('psmux new-window -P -F "#{window_index} #{pane_id}" -t parent-session-1 -n job-runtime-1 -d -- powershell.exe')
    expect(newWindowCommands[0]).toContain('codex exec "alpha"')
    expect(newWindowCommands[1]).toContain('psmux new-window -P -F "#{window_index} #{pane_id}" -t parent-session-1 -n job-runtime-2 -d -- powershell.exe')
    expect(newWindowCommands[1]).toContain('claude --print "beta"')
    expect(dashboardSplitCommands).toEqual([
      'psmux split-window -t parent-session-1:dashboard -h -p 35 -d -- powershell.exe -NoLogo -NoProfile',
    ])
    expect(dashboardListPaneCommands).toHaveLength(1)
    expectCommandContaining(commands, 'psmux pipe-pane -t %31 -o --')
    expectCommandContaining(commands, 'runtime-1.log')
    expectCommandContaining(commands, 'psmux pipe-pane -t %41 -o --')
    expectCommandContaining(commands, 'runtime-2.log')
    expect(commands.filter((command) => command.includes("pipe-pane -t parent-session-1:job-runtime-"))).toEqual([])
    expect(runPsmuxQuery.mock.calls.filter(([command]) => command.includes('list-panes -t parent-session-1:job-runtime-') && command.includes('#{pane_id}'))).toEqual([])
    expect(commands.filter((command) => command.includes("join-pane"))).toEqual([])
    expect(queryCommands.filter((command) => command.includes("break-pane"))).toEqual([])
    expect(commands.filter((command) => command.includes("display-pane"))).toEqual([])
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
    expectCommandContaining(commands, 'psmux pipe-pane -t %77 -o --')
    expectCommandContaining(commands, 'runtime-1.log')
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
})
