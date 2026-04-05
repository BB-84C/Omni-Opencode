export type RuntimeType = "pty" | "tmux"
export type JobStatus = "running" | "interrupted" | "completed" | "failed"
export type Backend = "claude-code" | "codex"

export type JobRecord = {
  jobId: string
  parentSessionId: string
  runtimeType: RuntimeType
  runtimeHandle: string
  attachTarget: string
  terminalLogPath: string
  transcriptByteLength?: number
  transcriptChunkCount?: number
  status: JobStatus
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
}
