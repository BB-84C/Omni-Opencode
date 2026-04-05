import type { JobStore } from "../core/store.js"
import type { BackendAdapter } from "../adapters/types.js"
import type { SessionManager } from "./session-manager.js"

export type RecoveryResult = {
  childSessionId: string
  action: "reconnected" | "marked-interrupted" | "skipped"
  reason?: string
}

export type RecoveryContext = {
  store: JobStore
  adapter: BackendAdapter
  sessionManager: SessionManager
}

export async function recoverJobs(ctx?: RecoveryContext): Promise<RecoveryResult[]> {
  if (ctx === undefined) {
    return []
  }

  const jobs = await ctx.store.list()
  const results: RecoveryResult[] = []

  for (const job of jobs) {
    const childSessionId = job.childSessionId ?? job.jobId

    if (job.status === "running") {
      const snapshotId = job.backendThreadId ?? childSessionId
      let snapshotStatus: "running" | "interrupted" | "completed" | "failed"

      try {
        const snapshot = await ctx.adapter.getSnapshot(snapshotId)
        snapshotStatus = snapshot.status
      } catch {
        snapshotStatus = "interrupted"
      }

      if (snapshotStatus === "running") {
        results.push({ childSessionId, action: "reconnected" })
      } else {
        const newStatus =
          snapshotStatus === "completed" || snapshotStatus === "failed"
            ? snapshotStatus
            : "interrupted"

        await ctx.store.save({ ...job, status: newStatus })

        const phase = job.activeCommand ?? job.activeTool ?? "unknown"
        const message = `\u26a0 Recovery: job status updated to ${newStatus} after restart. Last known phase: ${phase}.`
        await ctx.sessionManager.postMessage(childSessionId, message)

        results.push({ childSessionId, action: "marked-interrupted" })
      }
    } else {
      // interrupted (resumable or not), completed, failed — all skipped
      results.push({ childSessionId, action: "skipped" })
    }
  }

  return results
}
