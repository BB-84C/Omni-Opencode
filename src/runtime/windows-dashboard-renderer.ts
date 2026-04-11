import type { DashboardSnapshot, DashboardSnapshotJob } from "./windows-dashboard-snapshot.js"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightWhite: "\x1b[97m",
  brightCyan: "\x1b[96m",
} as const

function statusMarker(status: DashboardSnapshotJob["status"], frame: number): string {
  switch (status) {
    case "running":
      return `${ANSI.cyan}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${ANSI.reset}`
    case "waiting-approval":
      return `${ANSI.yellow}!${ANSI.reset}`
    case "completed":
      return `${ANSI.green}✓${ANSI.reset}`
    case "failed":
      return `${ANSI.red}✗${ANSI.reset}`
    case "stopped":
    case "cancelled":
      return `${ANSI.yellow}■${ANSI.reset}`
  }
}

function statusColor(status: DashboardSnapshotJob["status"]): string {
  switch (status) {
    case "running":
      return ANSI.white
    case "waiting-approval":
      return ANSI.yellow
    case "completed":
      return ANSI.green
    case "failed":
      return ANSI.red
    case "stopped":
    case "cancelled":
      return ANSI.yellow
  }
}

function renderSeparator(): string {
  return `${ANSI.gray}${"─".repeat(40)}${ANSI.reset}`
}

function renderJobLine(job: DashboardSnapshotJob, frame: number): string {
  const marker = statusMarker(job.status, frame)
  const color = statusColor(job.status)
  const label = job.label ? ` ${ANSI.gray}(${job.label})${ANSI.reset}` : ""
  const windowLabel = `${ANSI.bold}${ANSI.brightWhite}[window ${job.windowIndex}]${ANSI.reset}`
  return `  ${marker} ${color}${job.id}${ANSI.reset} ${ANSI.dim}[${job.backend}]${ANSI.reset} -> ${windowLabel}${label}`
}

export function renderDashboard(snapshot: DashboardSnapshot, frame: number): string {
  const lines: string[] = []

  lines.push("")
  lines.push(`  ${ANSI.bold}${ANSI.cyan}${snapshot.title}${ANSI.reset}`)
  lines.push(`  ${ANSI.gray}Session: ${ANSI.white}${snapshot.sessionId}${ANSI.reset}`)
  lines.push("")
  lines.push(renderSeparator())

  if (snapshot.jobs.length === 0) {
    lines.push("")
    lines.push(`  ${ANSI.dim}No delegated jobs yet. Waiting for work...${ANSI.reset}`)
    lines.push("")
  } else {
    lines.push("")
    lines.push(`  ${ANSI.bold}Delegated Jobs${ANSI.reset}`)
    lines.push("")
    for (const job of snapshot.jobs) {
      lines.push(renderJobLine(job, frame))
    }
    lines.push("")
  }

  lines.push(renderSeparator())
  lines.push("")
  for (const hint of snapshot.navigation) {
    lines.push(`  ${ANSI.gray}${hint}${ANSI.reset}`)
  }
  lines.push("")

  return lines.join("\n")
}
