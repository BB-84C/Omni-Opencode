import type { ClaudeCapabilityPolicy } from "../core/claude-policy.js"
import type { CodexCapabilityPolicy } from "../core/codex-policy.js"

export type RuntimeBackend = "claude-code" | "codex"

export type RuntimeKind = "windows-psmux" | "windows-pty" | "tmux"

export const ARCHIVED_RUNTIME_KINDS = ["windows-pty"] as const

export type ArchivedRuntimeKind = (typeof ARCHIVED_RUNTIME_KINDS)[number]

export type PrimaryRuntimeKind = Exclude<RuntimeKind, ArchivedRuntimeKind>

export type RuntimeStartParams = {
  backend: RuntimeBackend
  command: string
  cwd?: string
  commandArgs?: string[]
  launchMetadata?: RuntimeStartLaunchMetadata
  monitorSessionId?: string
}

export type RuntimeStartLaunchMetadata = {
  prompt: string
  promptFingerprint: string
  correlationMarker: string
  claudePolicy?: ClaudeCapabilityPolicy
  codexPolicy?: CodexCapabilityPolicy
}

export type RuntimeLaunchMetadata = {
  command: string
  cwd?: string
  outputMode?: "native" | "stream-json-renderer"
}

export type RuntimeAttachMetadata = {
  mode: "pty" | "tmux"
  target: string
  windowIndex?: number
}

export type RuntimeWindowMetadata = {
  target: string
  index?: number
}

export type RuntimeMonitor = {
  id: string
  sessionId?: string
  attach: RuntimeAttachMetadata
  window?: RuntimeWindowMetadata
  launch: RuntimeLaunchMetadata
  autoOpenSucceeded?: boolean
  attachCommand?: string
  logTailCommand?: string
  transcriptCaptureTarget?: string
  structuredStreamCaptureTarget?: string
}

export type RuntimeJob = {
  id: string
  backend: RuntimeBackend
  command: string
  status: "running" | "stopped"
  monitor: RuntimeMonitor
  backendSessionId?: string
  backendResumeSessionId?: string
}

export type RuntimeReadResult = {
  data: string
}

export type RuntimeSnapshot = {
  jobs: RuntimeJob[]
}

export type RuntimeMonitorLookup =
  | { type: "job"; jobId: string }
  | { type: "shared-session"; monitorSessionId: string }

export interface Runtime {
  start(params: RuntimeStartParams): Promise<RuntimeJob>
  read(jobId: string): Promise<RuntimeReadResult>
  stop(jobId: string): Promise<void>
  snapshot(): Promise<RuntimeSnapshot>
  openMonitor(lookup: RuntimeMonitorLookup): Promise<RuntimeMonitor>
}
