import type { DelegatedEvent } from "../core/events.js"
import type { BackendAdapter, JobHandle, JobSnapshot, JobStartParams } from "./types.js"
import type { ClaudeClient, ClaudeSDKMessage } from "./claude-client.js"

// ---------------------------------------------------------------------------
// Message → canonical event mapping
// ---------------------------------------------------------------------------

export function mapClaudeMessage(
  msg: ClaudeSDKMessage,
  sessionId: string,
): DelegatedEvent | null {
  switch (msg.type) {
    case "assistant": {
      // Return the first mappable content block
      for (const block of msg.message.content) {
        if (block.type === "text") {
          return { type: "assistant.delta", sessionId, text: block.text }
        }
        if (block.type === "tool_use") {
          return {
            type: "tool.start",
            sessionId,
            toolName: block.name,
            input: block.input,
          }
        }
      }
      return null
    }

    case "tool_result": {
      return {
        type: "tool.end",
        sessionId,
        toolName: "unknown",
      }
    }

    case "result": {
      if (msg.subtype === "success") {
        return {
          type: "result.final",
          sessionId,
          summary: msg.result ?? "completed",
        }
      }
      // subtype === "error"
      return {
        type: "error",
        sessionId,
        message: msg.result ?? "unknown error",
      }
    }

    case "system": {
      return {
        type: "status.update",
        sessionId,
        message: `system: ${msg.subtype}`,
      }
    }

    default: {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory job state
// ---------------------------------------------------------------------------

type JobState = {
  id: string
  childSessionId: string
  prompt: string
  cwd?: string
  policy?: JobStartParams["policy"]
  status: "running" | "interrupted" | "completed" | "failed"
  changedFiles: string[]
  lastEventSeq: number
}

let jobCounter = 0

function generateJobId(): string {
  return `claude-job-${++jobCounter}-${Date.now()}`
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createClaudeAdapter(client: ClaudeClient): BackendAdapter {
  const jobs = new Map<string, JobState>()

  return {
    async startJob(params: JobStartParams): Promise<JobHandle> {
      const id = generateJobId()
      const state: JobState = {
        id,
        childSessionId: params.childSessionId,
        prompt: params.prompt,
        cwd: params.cwd,
        policy: params.policy,
        status: "running",
        changedFiles: [],
        lastEventSeq: 0,
      }
      jobs.set(id, state)
      return { id, childSessionId: params.childSessionId }
    },

    async resumeJob(jobId: string, instruction?: string): Promise<JobHandle> {
      const existing = jobs.get(jobId)
      if (!existing) {
        throw new Error(`Job not found: ${jobId}`)
      }
      const newId = generateJobId()
      const state: JobState = {
        id: newId,
        childSessionId: existing.childSessionId,
        prompt: instruction ?? existing.prompt,
        cwd: existing.cwd,
        policy: existing.policy,
        status: "running",
        changedFiles: [],
        lastEventSeq: 0,
      }
      jobs.set(newId, state)
      return { id: newId, childSessionId: existing.childSessionId }
    },

    async cancelJob(jobId: string): Promise<void> {
      const state = jobs.get(jobId)
      if (!state) {
        throw new Error(`Job not found: ${jobId}`)
      }
      state.status = "interrupted"
      client.abort()
    },

    async *subscribeEvents(jobId: string): AsyncIterable<DelegatedEvent> {
      const state = jobs.get(jobId)
      if (!state) {
        throw new Error(`Job not found: ${jobId}`)
      }

      const sessionId = state.childSessionId

      try {
        for await (const msg of client.run({
          prompt: state.prompt,
          cwd: state.cwd,
          policy: state.policy,
        })) {
          if (state.status === "interrupted") {
            return
          }

          const event = mapClaudeMessage(msg, sessionId)
          if (event !== null) {
            state.lastEventSeq += 1
            yield event
          }
        }

        if (state.status !== "interrupted") {
          state.status = "completed"
        }
      } catch (err) {
        state.status = "failed"
        const message = err instanceof Error ? err.message : String(err)
        yield { type: "error", sessionId, message }
      }
    },

    async getSnapshot(jobId: string): Promise<JobSnapshot> {
      const state = jobs.get(jobId)
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
    },
  }
}
