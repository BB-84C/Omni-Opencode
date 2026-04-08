import { readFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  buildDashboardSnapshot,
  type DashboardSnapshot,
  type DashboardSnapshotJob,
} from "../src/runtime/windows-dashboard-snapshot.js"
import { renderDashboard } from "../src/runtime/windows-dashboard-renderer.js"
import {
  createWindowsPsmuxRuntime,
  buildWindowsPsmuxDashboardSnapshotPath,
} from "../src/runtime/windows-psmux.js"

describe("Dashboard snapshot contract", () => {
  it("includes the parent session id", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [],
    })

    expect(snapshot.sessionId).toBe("parent-session-1")
  })

  it("includes each job with backend, window index, and status", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [
        {
          id: "runtime-1",
          backend: "codex",
          windowIndex: 1,
          status: "running",
        },
        {
          id: "runtime-2",
          backend: "claude-code",
          windowIndex: 2,
          status: "completed",
        },
      ],
    })

    expect(snapshot.jobs).toHaveLength(2)
    expect(snapshot.jobs[0]).toEqual({
      id: "runtime-1",
      backend: "codex",
      windowIndex: 1,
      status: "running",
      label: undefined,
    })
    expect(snapshot.jobs[1]).toEqual({
      id: "runtime-2",
      backend: "claude-code",
      windowIndex: 2,
      status: "completed",
      label: undefined,
    })
  })

  it("includes optional label per job", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [
        {
          id: "runtime-1",
          backend: "codex",
          windowIndex: 1,
          status: "running",
          label: "fix auth bug",
        },
      ],
    })

    expect(snapshot.jobs[0]?.label).toBe("fix auth bug")
  })

  it("supports all expected job statuses", () => {
    const statuses = ["running", "completed", "failed", "cancelled", "stopped"] as const

    for (const status of statuses) {
      const snapshot = buildDashboardSnapshot({
        sessionId: "parent-session-1",
        jobs: [
          {
            id: "runtime-1",
            backend: "codex",
            windowIndex: 1,
            status,
          },
        ],
      })

      expect(snapshot.jobs[0]?.status).toBe(status)
    }
  })

  it("includes a dashboard title", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [],
    })

    expect(snapshot.title).toBe("OMNI-OPENCODE DASHBOARD")
  })

  it("includes navigation hints", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [],
    })

    expect(snapshot.navigation).toBeDefined()
    expect(snapshot.navigation.length).toBeGreaterThan(0)
    expect(snapshot.navigation.some((hint: string) => hint.includes("Ctrl+b"))).toBe(true)
  })

  it("includes a version field for change detection", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [],
    })

    expect(typeof snapshot.version).toBe("number")
  })

  it("increments version across successive builds", () => {
    const first = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [],
    })
    const second = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [
        { id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" },
      ],
    })

    expect(second.version).toBeGreaterThan(first.version)
  })

  it("excludes jobs from other parent sessions by contract", () => {
    const sessionAJobs: DashboardSnapshotJob[] = [
      { id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" },
    ]
    const sessionBJobs: DashboardSnapshotJob[] = [
      { id: "runtime-5", backend: "claude-code", windowIndex: 1, status: "running" },
    ]

    const snapshotA = buildDashboardSnapshot({
      sessionId: "parent-session-A",
      jobs: sessionAJobs,
    })
    const snapshotB = buildDashboardSnapshot({
      sessionId: "parent-session-B",
      jobs: sessionBJobs,
    })

    expect(snapshotA.sessionId).toBe("parent-session-A")
    expect(snapshotA.jobs).toHaveLength(1)
    expect(snapshotA.jobs[0]?.id).toBe("runtime-1")

    expect(snapshotB.sessionId).toBe("parent-session-B")
    expect(snapshotB.jobs).toHaveLength(1)
    expect(snapshotB.jobs[0]?.id).toBe("runtime-5")
  })

  it("serializes to JSON for file-based consumption and round-trips cleanly", () => {
    const snapshot = buildDashboardSnapshot({
      sessionId: "parent-session-1",
      jobs: [
        { id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" },
      ],
    })

    const json = JSON.stringify(snapshot)
    const parsed = JSON.parse(json) as DashboardSnapshot

    expect(parsed.sessionId).toBe("parent-session-1")
    expect(parsed.jobs).toHaveLength(1)
    expect(parsed.title).toBe("OMNI-OPENCODE DASHBOARD")
  })
})

describe("Dashboard ANSI renderer", () => {
  function makeSnapshot(
    overrides: Partial<DashboardSnapshot> & { jobs?: DashboardSnapshotJob[] } = {},
  ): DashboardSnapshot {
    return {
      sessionId: "parent-session-1",
      title: "OMNI-OPENCODE DASHBOARD",
      jobs: [],
      navigation: [
        "Use Ctrl+b then n/p to cycle windows.",
        "Use Ctrl+b then 0 to return here.",
      ],
      version: 1,
      ...overrides,
    }
  }

  it("includes the dashboard title and session id in output", () => {
    const output = renderDashboard(makeSnapshot(), 0)

    expect(output).toContain("OMNI-OPENCODE DASHBOARD")
    expect(output).toContain("parent-session-1")
  })

  it("renders running jobs with an animated spinner frame token", () => {
    const output0 = renderDashboard(
      makeSnapshot({
        jobs: [{ id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" }],
      }),
      0,
    )
    const output1 = renderDashboard(
      makeSnapshot({
        jobs: [{ id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" }],
      }),
      1,
    )

    // Both frames should contain the job but have different spinner characters
    expect(output0).toContain("runtime-1")
    expect(output1).toContain("runtime-1")
    // At least one frame differs (spinner animation)
    expect(output0 !== output1).toBe(true)
  })

  it("renders completed jobs with a green check marker", () => {
    const output = renderDashboard(
      makeSnapshot({
        jobs: [{ id: "runtime-1", backend: "codex", windowIndex: 1, status: "completed" }],
      }),
      0,
    )

    // Should contain ANSI green color code
    expect(output).toMatch(/\x1b\[32m/)
    expect(output).toContain("runtime-1")
  })

  it("renders failed jobs with a red marker", () => {
    const output = renderDashboard(
      makeSnapshot({
        jobs: [{ id: "runtime-1", backend: "codex", windowIndex: 1, status: "failed" }],
      }),
      0,
    )

    // Should contain ANSI red color code
    expect(output).toMatch(/\x1b\[31m/)
    expect(output).toContain("runtime-1")
  })

  it("renders stopped and cancelled jobs with a dim/yellow marker", () => {
    for (const status of ["stopped", "cancelled"] as const) {
      const output = renderDashboard(
        makeSnapshot({
          jobs: [{ id: "runtime-1", backend: "codex", windowIndex: 1, status }],
        }),
        0,
      )

      // Should contain ANSI yellow (33) or dim (2) code
      expect(output).toMatch(/\x1b\[(?:33|2)m/)
      expect(output).toContain("runtime-1")
    }
  })

  it("uses ANSI colors and section structure", () => {
    const output = renderDashboard(
      makeSnapshot({
        jobs: [
          { id: "runtime-1", backend: "codex", windowIndex: 1, status: "running" },
          { id: "runtime-2", backend: "claude-code", windowIndex: 2, status: "completed" },
        ],
      }),
      0,
    )

    // Contains ANSI escape codes
    expect(output).toMatch(/\x1b\[/)
    // Contains section separators or structural elements
    expect(output).toContain("codex")
    expect(output).toContain("claude-code")
    expect(output).toContain("window 1")
    expect(output).toContain("window 2")
  })

  it("never includes a PowerShell prompt", () => {
    const output = renderDashboard(makeSnapshot(), 0)

    expect(output).not.toContain("PS ")
    expect(output).not.toContain("PS>")
    expect(output).not.toMatch(/PS [A-Z]:\\/)
  })

  it("renders a waiting state when there are no jobs", () => {
    const output = renderDashboard(makeSnapshot({ jobs: [] }), 0)

    expect(output).toContain("OMNI-OPENCODE DASHBOARD")
    // Should indicate no jobs or waiting
    expect(output.toLowerCase()).toMatch(/no.*job|waiting|none/)
  })

  it("includes navigation hints in the output", () => {
    const output = renderDashboard(makeSnapshot(), 0)

    expect(output).toContain("Ctrl+b")
  })

  it("shows the job label when present", () => {
    const output = renderDashboard(
      makeSnapshot({
        jobs: [
          { id: "runtime-1", backend: "codex", windowIndex: 1, status: "running", label: "fix auth bug" },
        ],
      }),
      0,
    )

    expect(output).toContain("fix auth bug")
  })
})

function createManagedInstallResult() {
  return {
    binaryPath: "psmux",
    manifestPath: "D:/Omni-Opencode/.omni-tools/psmux/manifest.json",
    installed: false,
  }
}

function createTwoPaneDashboardGeometry() {
  return [
    "%11 0 0 0 120 60",
    "%12 1 120 0 80 60",
  ].join("\n")
}

function createSnapshotTestQuery(sessionId: string, jobWindowOutputs: Record<string, string>) {
  return vi.fn(async (command: string) => {
    if (command.includes(`list-panes -t ${sessionId}:dashboard`)) {
      return createTwoPaneDashboardGeometry()
    }

    for (const [name, output] of Object.entries(jobWindowOutputs)) {
      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"') && command.includes(name)) {
        return output
      }
    }

    throw new Error(`Unexpected query: ${command}`)
  })
}

async function readSnapshotFile(path: string): Promise<DashboardSnapshot> {
  const raw = await readFile(path, "utf8")
  return JSON.parse(raw) as DashboardSnapshot
}

describe("Dashboard snapshot file writes", () => {
  it("writes a snapshot file when the shared session is created", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dashboard-snap-"))
    const runPsmuxCommand = vi.fn(async () => undefined)
    const runPsmuxQuery = createSnapshotTestQuery("parent-session-1", {
      "job-runtime-1": "1 %31",
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession: async () => false,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: (snapshotPath) => `node --dashboard "${snapshotPath}"`,
    })

    await runtime.start({
      backend: "codex",
      command: 'codex exec "hello"',
      monitorSessionId: "parent-session-1",
    })

    const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(join(cwd, ".omni-monitors"), "parent-session-1")
    const snapshot = await readSnapshotFile(snapshotPath)

    expect(snapshot.sessionId).toBe("parent-session-1")
    expect(snapshot.title).toBe("OMNI-OPENCODE DASHBOARD")
    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0]?.id).toBe("runtime-1")
    expect(snapshot.jobs[0]?.backend).toBe("codex")
    expect(snapshot.jobs[0]?.status).toBe("running")
    expect(snapshot.jobs[0]?.windowIndex).toBe(1)
  })

  it("updates the snapshot file when a new job starts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dashboard-snap-"))
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createSnapshotTestQuery("parent-session-1", {
      "job-runtime-1": "1 %31",
      "job-runtime-2": "2 %41",
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: (snapshotPath) => `node --dashboard "${snapshotPath}"`,
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

    const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(join(cwd, ".omni-monitors"), "parent-session-1")
    const snapshot = await readSnapshotFile(snapshotPath)

    expect(snapshot.jobs).toHaveLength(2)
    expect(snapshot.jobs[0]?.id).toBe("runtime-1")
    expect(snapshot.jobs[1]?.id).toBe("runtime-2")
    expect(snapshot.jobs[1]?.backend).toBe("claude-code")
    expect(snapshot.jobs[1]?.status).toBe("running")
  })

  it("updates the snapshot file when a job stops", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dashboard-snap-"))
    const runPsmuxCommand = vi.fn(async () => undefined)
    const hasSharedSession = vi.fn(async () => false)
    hasSharedSession.mockResolvedValueOnce(false)
    hasSharedSession.mockResolvedValueOnce(true)
    const runPsmuxQuery = createSnapshotTestQuery("parent-session-1", {
      "job-runtime-1": "1 %31",
      "job-runtime-2": "2 %41",
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd,
      ensureManagedPsmuxInstalled: async () => createManagedInstallResult(),
      hasSharedSession,
      runPsmuxCommand,
      runPsmuxQuery,
      buildDashboardProcessCommand: (snapshotPath) => `node --dashboard "${snapshotPath}"`,
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

    const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(join(cwd, ".omni-monitors"), "parent-session-1")
    const snapshot = await readSnapshotFile(snapshotPath)

    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0]?.id).toBe("runtime-1")
    expect(snapshot.jobs[0]?.status).toBe("running")
  })

  it("isolates snapshot files per parent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dashboard-snap-"))
    const logDir = join(cwd, ".omni-monitors")

    const pathA = buildWindowsPsmuxDashboardSnapshotPath(logDir, "parent-session-A")
    const pathB = buildWindowsPsmuxDashboardSnapshotPath(logDir, "parent-session-B")

    expect(pathA).not.toBe(pathB)
    expect(pathA).toContain("parent-session-A")
    expect(pathB).toContain("parent-session-B")
  })
})
