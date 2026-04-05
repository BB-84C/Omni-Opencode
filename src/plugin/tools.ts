import type { JobStore } from "../core/store.js"
import type { BackendAdapter, JobHandle } from "../adapters/types.js"
import type { SessionManager } from "./session-manager.js"
import type { InterruptCheckpoint } from "./resume.js"

export type ToolContext = {
  store: JobStore
  adapter: BackendAdapter
  sessionManager: SessionManager
}

export type DelegatedJobsListResult = {
  jobs: Array<{ childSessionId: string; backend: string; status: string; resumable: boolean }>
}

export type DelegatedJobSnapshotResult = {
  childSessionId: string
  status: string
  changedFiles: string[]
  lastEventSeq: number
  resumable: boolean
}

export async function delegatedJobsList(ctx: ToolContext): Promise<DelegatedJobsListResult> {
  const records = await ctx.store.list()
  return {
    jobs: records.map((job) => ({
      childSessionId: job.childSessionId ?? job.jobId,
      backend: job.backend ?? "unknown",
      status: job.status,
      resumable: job.resumable ?? false,
    })),
  }
}

export async function delegatedJobSnapshot(
  ctx: ToolContext,
  childSessionId: string,
): Promise<DelegatedJobSnapshotResult> {
  const job = await ctx.store.get(childSessionId)
  if (!job) {
    throw new Error(`Job not found in store: ${childSessionId}`)
  }

  const snapshotId = job.backendThreadId ?? childSessionId
  const snapshot = await ctx.adapter.getSnapshot(snapshotId)

  return {
    childSessionId,
    status: snapshot.status,
    changedFiles: snapshot.changedFiles,
    lastEventSeq: snapshot.lastEventSeq,
    resumable: job.resumable ?? false,
  }
}

export type ResumeOptions = {
  instruction?: string
  checkpoint?: InterruptCheckpoint
}

export async function delegatedJobResume(
  ctx: ToolContext,
  childSessionId: string,
  opts?: ResumeOptions,
): Promise<JobHandle> {
  const job = await ctx.store.get(childSessionId)
  if (!job) {
    throw new Error(`Job not found in store: ${childSessionId}`)
  }

  const resumeId = job.backendThreadId ?? childSessionId
  const handle = await ctx.adapter.resumeJob(resumeId, opts?.instruction)
  await ctx.store.save({ ...job, status: "running" })

  return handle
}

export async function delegatedJobCancel(
  ctx: ToolContext,
  childSessionId: string,
): Promise<{ cancelled: boolean }> {
  const job = await ctx.store.get(childSessionId)
  if (!job) {
    throw new Error(`Job not found in store: ${childSessionId}`)
  }

  const cancelId = job.backendThreadId ?? childSessionId
  await ctx.adapter.cancelJob(cancelId)
  await ctx.store.save({ ...job, status: "interrupted" })

  return { cancelled: true }
}
