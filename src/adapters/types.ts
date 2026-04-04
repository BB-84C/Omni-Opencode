import type { DelegatedEvent } from "../core/events.js"

export type JobStartParams = {
  childSessionId: string
  prompt: string
  cwd?: string
  env?: Record<string, string>
}

export type JobHandle = {
  id: string           // broker job ID
  childSessionId: string
}

export type JobSnapshot = {
  id: string
  childSessionId: string
  status: "running" | "interrupted" | "completed" | "failed"
  changedFiles: string[]
  lastEventSeq: number
}

export interface BackendAdapter {
  startJob(params: JobStartParams): Promise<JobHandle>
  resumeJob(jobId: string, instruction?: string): Promise<JobHandle>
  cancelJob(jobId: string): Promise<void>
  subscribeEvents(jobId: string): AsyncIterable<DelegatedEvent>
  getSnapshot(jobId: string): Promise<JobSnapshot>
}
