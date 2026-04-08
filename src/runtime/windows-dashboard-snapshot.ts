export type DashboardSnapshotJobStatus = "running" | "completed" | "failed" | "cancelled" | "stopped"

export type DashboardSnapshotJob = {
  id: string
  backend: "codex" | "claude-code"
  windowIndex: number
  status: DashboardSnapshotJobStatus
  label?: string
}

export type DashboardSnapshot = {
  sessionId: string
  title: string
  jobs: DashboardSnapshotJob[]
  navigation: string[]
  version: number
}

export type BuildDashboardSnapshotInput = {
  sessionId: string
  jobs: DashboardSnapshotJob[]
}

let snapshotVersion = 0

export function buildDashboardSnapshot(input: BuildDashboardSnapshotInput): DashboardSnapshot {
  return {
    sessionId: input.sessionId,
    title: "OMNI-OPENCODE DASHBOARD",
    jobs: input.jobs.map((job) => ({
      id: job.id,
      backend: job.backend,
      windowIndex: job.windowIndex,
      status: job.status,
      label: job.label,
    })),
    navigation: [
      "Use Ctrl+b then n/p to cycle windows.",
      "Use Ctrl+b then 0 to return here.",
    ],
    version: ++snapshotVersion,
  }
}
