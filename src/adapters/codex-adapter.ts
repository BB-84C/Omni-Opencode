import type { DelegatedEvent } from "../core/events.js"
import type { BackendAdapter, JobHandle, JobStartParams, JobSnapshot } from "./types.js"
import type { CodexClient, CodexNotification } from "./codex-client.js"

// ---------------------------------------------------------------------------
// Codex v2 notification → canonical DelegatedEvent mapping
// ---------------------------------------------------------------------------

export function mapCodexEvent(notification: CodexNotification, sessionId: string): DelegatedEvent {
  switch (notification.method) {
    case "turn/started":
      return {
        type: "status.update",
        sessionId,
        message: "Turn started",
      }

    case "item/agentMessage/delta":
      return {
        type: "assistant.delta",
        sessionId,
        text: notification.params.delta,
      }

    case "turn/completed": {
      const { turn } = notification.params
      if (turn.status === "failed") {
        return {
          type: "error",
          sessionId,
          message: "Turn failed",
        }
      }
      return {
        type: "result.final",
        sessionId,
        summary: "Turn completed",
      }
    }

    case "item/commandExecution/outputDelta":
      return {
        type: "command.stdout.delta",
        sessionId,
        text: notification.params.delta,
      }

    case "item/fileChange/outputDelta":
      return {
        type: "status.update",
        sessionId,
        message: notification.params.delta,
      }

    case "error":
      return {
        type: "error",
        sessionId,
        message: notification.params.message,
      }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type JobRecord = {
  id: string
  childSessionId: string
  threadId: string
  status: "running" | "interrupted" | "completed" | "failed"
  changedFiles: string[]
  lastEventSeq: number
}

export function createCodexAdapter(client: CodexClient): BackendAdapter {
  const jobs = new Map<string, JobRecord>()
  let jobCounter = 0

  return {
    async startJob(params: JobStartParams): Promise<JobHandle> {
      const { threadId } = await client.startThread({
        prompt: params.prompt,
        cwd: params.cwd,
      })
      const id = `codex-job-${++jobCounter}`
      const record: JobRecord = {
        id,
        childSessionId: params.childSessionId,
        threadId,
        status: "running",
        changedFiles: [],
        lastEventSeq: 0,
      }
      jobs.set(id, record)
      return { id, childSessionId: params.childSessionId }
    },

    async resumeJob(jobId: string, _instruction?: string): Promise<JobHandle> {
      const record = jobs.get(jobId)
      if (!record) throw new Error(`Unknown job: ${jobId}`)
      record.status = "running"
      return { id: record.id, childSessionId: record.childSessionId }
    },

    async cancelJob(jobId: string): Promise<void> {
      const record = jobs.get(jobId)
      if (!record) throw new Error(`Unknown job: ${jobId}`)
      await client.cancelThread(record.threadId)
      record.status = "interrupted"
    },

    async *subscribeEvents(jobId: string): AsyncIterable<DelegatedEvent> {
      const record = jobs.get(jobId)
      if (!record) throw new Error(`Unknown job: ${jobId}`)

      for await (const notification of client.subscribeNotifications(record.threadId)) {
        record.lastEventSeq++
        const event = mapCodexEvent(notification, record.childSessionId)
        if (event.type === "result.final") {
          record.status = "completed"
        } else if (event.type === "error") {
          record.status = "failed"
        }
        yield event
      }
    },

    async getSnapshot(jobId: string): Promise<JobSnapshot> {
      const record = jobs.get(jobId)
      if (!record) throw new Error(`Unknown job: ${jobId}`)
      return {
        id: record.id,
        childSessionId: record.childSessionId,
        status: record.status,
        changedFiles: record.changedFiles,
        lastEventSeq: record.lastEventSeq,
      }
    },
  }
}
