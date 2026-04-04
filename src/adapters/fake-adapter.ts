import type { DelegatedEvent } from "../core/events.js"
import type { BackendAdapter, JobHandle, JobSnapshot, JobStartParams } from "./types.js"

type JobState = {
  id: string
  childSessionId: string
  status: "running" | "interrupted" | "completed" | "failed"
  changedFiles: string[]
  lastEventSeq: number
  cancelled: boolean
}

let jobCounter = 0

function generateJobId(): string {
  return `fake-job-${++jobCounter}-${Date.now()}`
}

export class FakeAdapter implements BackendAdapter {
  private readonly jobs = new Map<string, JobState>()

  async startJob(params: JobStartParams): Promise<JobHandle> {
    const id = generateJobId()
    const state: JobState = {
      id,
      childSessionId: params.childSessionId,
      status: "running",
      changedFiles: [],
      lastEventSeq: 0,
      cancelled: false,
    }
    this.jobs.set(id, state)
    return { id, childSessionId: params.childSessionId }
  }

  async resumeJob(jobId: string, _instruction?: string): Promise<JobHandle> {
    const existing = this.jobs.get(jobId)
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`)
    }

    // Create a new job entry sharing the same childSessionId
    const newId = generateJobId()
    const state: JobState = {
      id: newId,
      childSessionId: existing.childSessionId,
      status: "running",
      changedFiles: [],
      lastEventSeq: 0,
      cancelled: false,
    }
    this.jobs.set(newId, state)
    return { id: newId, childSessionId: existing.childSessionId }
  }

  async cancelJob(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId)
    if (!state) {
      throw new Error(`Job not found: ${jobId}`)
    }
    state.cancelled = true
    state.status = "interrupted"
  }

  async *subscribeEvents(jobId: string): AsyncIterable<DelegatedEvent> {
    const state = this.jobs.get(jobId)
    if (!state) {
      throw new Error(`Job not found: ${jobId}`)
    }

    const sessionId = state.childSessionId

    const sequence: DelegatedEvent[] = [
      { type: "status.update", sessionId, message: "starting" },
      { type: "tool.start", sessionId, toolName: "read_file" },
      { type: "tool.end", sessionId, toolName: "read_file" },
      { type: "command.start", sessionId, command: "npm test" },
      { type: "command.stdout.delta", sessionId, text: "all tests passed" },
      { type: "assistant.delta", sessionId, text: "Done." },
      { type: "result.final", sessionId, summary: "completed", changedFiles: ["src/index.ts"] },
    ]

    for (const event of sequence) {
      if (state.cancelled) {
        return
      }

      state.lastEventSeq += 1
      yield event

      // Small yield to make the async generator realistic without slowing tests
      await new Promise<void>((r) => setTimeout(r, 0))
    }

    // Update final state after emitting all events
    if (!state.cancelled) {
      state.status = "completed"
      state.changedFiles = ["src/index.ts"]
    }
  }

  async getSnapshot(jobId: string): Promise<JobSnapshot> {
    const state = this.jobs.get(jobId)
    if (!state) {
      throw new Error(`Job not found: ${jobId}`)
    }

    return {
      id: state.id,
      childSessionId: state.childSessionId,
      status: state.status,
      changedFiles: [...state.changedFiles],
      lastEventSeq: state.lastEventSeq,
    }
  }
}
