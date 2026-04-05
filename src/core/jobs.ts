export type Backend = "codex" | "claude-code"
export type JobStatus = "running" | "interrupted" | "completed" | "failed"

export type JobRecord = {
  childSessionId: string
  backend: Backend
  brokerJobId?: string
  backendThreadId?: string
  resumeToken?: string
  status: JobStatus
  resumable?: boolean
  changedFiles?: string[]
  lastCheckpointAt?: number  // epoch ms
  lastEventSeq?: number
  activeCommand?: string
  activeTool?: string
  lastProjectedMessage?: string  // last text written to child session
  summary?: string               // final result summary from result.final event
}
