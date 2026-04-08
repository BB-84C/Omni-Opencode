import { describe, expect, it } from "vitest"
import {
  buildDashboardSnapshot,
  type DashboardSnapshot,
  type DashboardSnapshotJob,
} from "../src/runtime/windows-dashboard-snapshot.js"

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

  it("serializes to JSON for file-based consumption", () => {
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
