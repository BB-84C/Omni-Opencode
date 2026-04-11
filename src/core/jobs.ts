export type RuntimeType = "pty" | "tmux"
export type JobStatus = "running" | "interrupted" | "completed" | "failed"
export type Backend = "claude-code" | "codex"
export type DelegationTaskClass = "review" | "workspace-write"
export type PermissionProfile = "safe" | "dangerous"
export type ApprovalMode = "not-required" | "once" | "session"

export type JobRecord = {
  jobId: string
  batchId?: string
  parentSessionId: string
  parentMessageId?: string
  promptFingerprint?: string
  correlationMarker?: string
  monitorSessionId?: string
  runtimeKind?: "windows-psmux" | "windows-pty" | "tmux"
  runtimeType: RuntimeType
  runtimeHandle: string
  attachTarget: string
  attachCommand?: string
  logTailCommand?: string
  terminalLogPath: string
  transcriptCaptureTarget?: string
  transcriptByteLength?: number
  transcriptChunkCount?: number
  status: JobStatus
  autoOpenAttempted?: boolean
  autoOpenSucceeded?: boolean
  resumable?: boolean
  changedFiles?: string[]
  lastCheckpointAt?: number  // epoch ms
  lastEventSeq?: number
  activeCommand?: string
  activeTool?: string
  lastProjectedMessage?: string  // last text written to child session
  summary?: string               // final result summary from result.final event
  childSessionId?: string
  backend?: Backend
  backendThreadId?: string
  backendSessionId?: string
  backendResumeSessionId?: string
  taskClass?: DelegationTaskClass
  permissionProfile?: PermissionProfile
  approvalMode?: ApprovalMode
}
