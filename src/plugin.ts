import { tool, type PluginInput, type Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createJobStore } from "./core/store.js"
import type { Backend, JobRecord } from "./core/jobs.js"
import { extractFinalReport } from "./runtime/extract-report.js"
import { selectRuntime, type SelectRuntimeOptions, type SelectedRuntime } from "./runtime/select-runtime.js"
import { appendTranscriptChunk, createTranscript } from "./runtime/transcript.js"
import type { RuntimeJob, RuntimeMonitor, RuntimeStartParams } from "./runtime/types.js"

type CleanupState = "completed"
type CleanupReason = "cancelled" | "completed" | "failed"
type StoredJobRecord = JobRecord & {
  cleanupState?: CleanupState
  cleanupReason?: CleanupReason
  cleanupUpdatedAt?: number
}

export function createPluginRuntimeSelection(options: SelectRuntimeOptions = {}): SelectedRuntime {
  return selectRuntime(options)
}

export async function preparePluginRuntimeStart(
  selection: SelectedRuntime,
  params: RuntimeStartParams,
): Promise<{
  kind: SelectedRuntime["kind"]
  autoOpenMonitor: boolean
  job: Awaited<ReturnType<SelectedRuntime["runtime"]["start"]>>
  monitor?: Awaited<ReturnType<SelectedRuntime["runtime"]["openMonitor"]>>
}> {
  const started = await selection.start(params)
  return {
    kind: selection.kind,
    autoOpenMonitor: selection.autoOpenMonitor,
    job: started.job,
    monitor: started.monitor,
  }
}

function runtimeTypeForSelection(kind: SelectedRuntime["kind"]): JobRecord["runtimeType"] {
  return kind === "tmux" ? "tmux" : "pty"
}

function delegatedJobId(parentSessionId: string, runtimeJobId: string): string {
  return `${parentSessionId}:${runtimeJobId}`
}

function buildDelegationCommand(backend: Backend, prompt: string): string {
  const escapedPrompt = JSON.stringify(prompt)
  return backend === "claude-code"
    ? `claude --print ${escapedPrompt}`
    : `codex ${escapedPrompt}`
}

function createStoredJobRecord(
  parentSessionId: string,
  runtimeKind: SelectedRuntime["kind"],
  job: RuntimeJob,
  monitor: RuntimeMonitor,
  status: JobRecord["status"],
): StoredJobRecord {
  const jobId = delegatedJobId(parentSessionId, job.id)
  return {
    jobId,
    parentSessionId,
    runtimeType: runtimeTypeForSelection(runtimeKind),
    runtimeHandle: job.id,
    attachTarget: monitor.attach.target,
    terminalLogPath: monitor.attach.target,
    transcriptByteLength: 0,
    transcriptChunkCount: 0,
    backend: job.backend,
    backendThreadId: job.id,
    status,
  }
}

function withTranscriptProgress(record: StoredJobRecord, transcript: ReturnType<typeof createTranscript>): StoredJobRecord {
  return {
    ...record,
    transcriptByteLength: transcript.text.length,
    transcriptChunkCount: transcript.chunks.length,
  }
}

function withCleanup(record: StoredJobRecord, reason: CleanupReason): StoredJobRecord {
  return {
    ...record,
    cleanupState: "completed",
    cleanupReason: reason,
    cleanupUpdatedAt: Date.now(),
  }
}

type DelegationLaunchResult = {
  jobId: string
  parentSessionId: string
  backend: Backend
  status: "running"
  monitor: RuntimeMonitor
}

type ParentSessionMessageClient = PluginInput["client"] & {
  message: {
    create(params: {
      sessionId: string
      role: string
      content: string
    }): Promise<void>
  }
}

export const OmniOpencodePlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const stateDir = `${directory}/.broker-state`
  const finalStateOverlayDir = join(stateDir, "final-state-overlay")
  const store = createJobStore(stateDir)
  const finalStateOverlay = await loadFinalStateOverlay(finalStateOverlayDir)
  const runtimeSelection = createPluginRuntimeSelection()
  const messageClient = client as ParentSessionMessageClient

  if (typeof messageClient.message?.create !== "function") {
    throw new Error("Parent session message.create is required for completion reporting")
  }

  async function monitorDelegationCompletion(record: StoredJobRecord): Promise<void> {
    const transcript = createTranscript()

    while (true) {
      const current = await getJobRecord(record.jobId)
      if (!current || current.status !== "running") {
        return
      }

      const output = await runtimeSelection.runtime.read(record.runtimeHandle)
      if (output.data) {
        appendTranscriptChunk(transcript, output.data)
        const latest = await getJobRecord(record.jobId)
        if (!latest || latest.status !== "running") {
          return
        }

        await saveJobRecord(withTranscriptProgress(latest, transcript))
      }

      const snapshot = await runtimeSelection.runtime.snapshot()
      const runtimeJob = snapshot.jobs.find((job) => job.id === record.runtimeHandle)

      if (!runtimeJob) {
        const latest = await getJobRecord(record.jobId)
        if (!latest || latest.status !== "running") {
          return
        }
        const summary = `Runtime job ${record.runtimeHandle} disappeared before completion could be confirmed.`
        const content = formatCompletionUpdate({
          backend: record.backend ?? "codex",
          jobId: record.jobId,
          status: "failed",
          summary,
        })
        await messageClient.message.create({
          sessionId: record.parentSessionId,
          role: "assistant",
          content,
        })
        await saveFinalStateAfterParentUpdate(withCleanup({
          ...latest,
          status: "failed",
          summary,
          lastProjectedMessage: content,
        }, "failed"))
        return
      }

      if (runtimeJob.status === "stopped") {
        const latest = await getJobRecord(record.jobId)
        if (!latest || latest.status !== "running") {
          return
        }
        const report = extractFinalReport(transcript)
        const summary = report.summary ?? "Runtime completed without a structured summary."
        const content = formatCompletionUpdate({
          backend: record.backend ?? "codex",
          jobId: record.jobId,
          status: "completed",
          summary,
        })
        const completedRecord = withCleanup({
          ...withTranscriptProgress(latest, transcript),
          status: "completed",
          summary,
          changedFiles: report.changedFiles,
          lastProjectedMessage: content,
        }, "completed")

        await messageClient.message.create({
          sessionId: record.parentSessionId,
          role: "assistant",
          content,
        })
        await saveFinalStateAfterParentUpdate(completedRecord)
        return
      }

      await delay(50)
    }
  }

  async function recordMonitorCrash(record: StoredJobRecord, error: unknown): Promise<void> {
    const current = await getJobRecord(record.jobId)

    if (!current || current.status !== "running") {
      return
    }

    const detail = error instanceof Error ? error.message : String(error)
    const summary = `Background completion monitor crashed: ${detail}`

    await store.save(withCleanup({
      ...current,
      status: "failed",
      summary,
      lastProjectedMessage: summary,
    }, "failed"))
    finalStateOverlay.delete(record.jobId)
    await deleteOverlayRecord(finalStateOverlayDir, record.jobId)
  }

  async function saveFinalStateAfterParentUpdate(record: StoredJobRecord): Promise<void> {
    try {
      await store.save(record)
      finalStateOverlay.delete(record.jobId)
      await deleteOverlayRecord(finalStateOverlayDir, record.jobId)
    } catch {
      // The parent session already received the update; keep reads consistent in-process and across restart.
      finalStateOverlay.set(record.jobId, record)
      await writeOverlayRecord(finalStateOverlayDir, record)
    }
  }

  async function saveJobRecord(record: StoredJobRecord): Promise<void> {
    const overlaid = finalStateOverlay.get(record.jobId)
    if (overlaid && overlaid.status !== "running" && record.status === "running") {
      return
    }

    await store.save(record)

    if (finalStateOverlay.has(record.jobId)) {
      finalStateOverlay.set(record.jobId, record)
      await writeOverlayRecord(finalStateOverlayDir, record)
    }
  }

  async function getJobRecord(jobId: string): Promise<StoredJobRecord | undefined> {
    return (finalStateOverlay.get(jobId) ?? await store.get(jobId)) as StoredJobRecord | undefined
  }

  async function listJobRecords(): Promise<StoredJobRecord[]> {
    const jobs = await store.list()
    const merged = new Map(jobs.map(job => [job.jobId, job]))

    for (const [jobId, job] of finalStateOverlay) {
      merged.set(jobId, job)
    }

    return Array.from(merged.values()) as StoredJobRecord[]
  }

  async function launchDelegation(
    parentSessionId: string,
    backend: Backend,
    prompt: string,
  ): Promise<string> {
    const started = await preparePluginRuntimeStart(runtimeSelection, {
      backend,
      command: buildDelegationCommand(backend, prompt),
    })
    const monitor = started.monitor ?? started.job.monitor
    const record = createStoredJobRecord(parentSessionId, started.kind, started.job, monitor, "running")
    await store.save(record)

    const result: DelegationLaunchResult = {
      jobId: record.jobId,
      parentSessionId,
      backend,
      status: "running",
      monitor,
    }

    void monitorDelegationCompletion(record).catch((error) => recordMonitorCrash(record, error))

    return JSON.stringify(result, null, 2)
  }

  return {
    tool: {
      delegate_to_claude: tool({
        description:
          "Delegate a coding or research task to Claude Code and return monitor metadata immediately.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Claude Code"),
        },
        async execute({ prompt }, context) {
          return launchDelegation(context.sessionID, "claude-code", prompt)
        },
      }),

      delegate_to_codex: tool({
        description:
          "Delegate a coding task to OpenAI Codex and return monitor metadata immediately.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Codex"),
        },
        async execute({ prompt }, context) {
          return launchDelegation(context.sessionID, "codex", prompt)
        },
      }),

      delegated_jobs_list: tool({
        description: "List all delegated jobs and their current status.",
        args: {},
        async execute() {
          const jobs = await listJobRecords()
          if (jobs.length === 0) return "No delegated jobs found."
          return jobs
            .map(j => {
              const parts = [
                `- ${j.jobId} [${j.backend}] status=${j.status}`,
                j.cleanupState && j.cleanupReason
                  ? `cleanup=${j.cleanupState}/${j.cleanupReason}`
                  : null,
                j.lastProjectedMessage
                  ? `last="${j.lastProjectedMessage.slice(0, 60)}"`
                  : null,
              ]
              return parts.filter(Boolean).join(" ")
            })
            .join("\n")
        },
      }),

      delegated_job_snapshot: tool({
        description:
          "Get full telemetry for a delegated job: status, last projected message, " +
          "final summary, changed files, active tool/command, and event count.",
        args: {
          jobId: tool.schema
            .string()
            .describe("The delegated job ID"),
        },
        async execute({ jobId }) {
          const job = await getJobRecord(jobId)
          if (!job) return `No delegated job found for ID ${jobId}`
          return JSON.stringify(job, null, 2)
        },
      }),

      delegated_job_read: tool({
        description: "Read newly captured output for a delegated job.",
        args: {
          jobId: tool.schema
            .string()
            .describe("The delegated job ID"),
        },
        async execute({ jobId }) {
          const job = await getJobRecord(jobId)
          if (!job) return `No delegated job found for ID ${jobId}`
          const output = await runtimeSelection.runtime.read(job.runtimeHandle)
          return output.data || `No new output for delegated job ${jobId}`
        },
      }),

      delegated_job_attach: tool({
        description: "Return attach metadata for a delegated job monitor.",
        args: {
          jobId: tool.schema
            .string()
            .describe("The delegated job ID"),
        },
        async execute({ jobId }) {
          const job = await getJobRecord(jobId)
          if (!job) return `No delegated job found for ID ${jobId}`

          const monitor = await runtimeSelection.runtime.openMonitor(job.runtimeHandle)
          const refreshedJob: StoredJobRecord = {
            ...job,
            attachTarget: monitor.attach.target,
            terminalLogPath: monitor.attach.target,
          }

          await saveJobRecord(refreshedJob)

          return JSON.stringify({
            jobId: refreshedJob.jobId,
            runtimeType: refreshedJob.runtimeType,
            attach: monitor.attach,
            launch: monitor.launch,
          }, null, 2)
        },
      }),

      delegated_job_cancel: tool({
        description: "Cancel a running delegated job.",
        args: {
          jobId: tool.schema
            .string()
            .describe("The delegated job ID to cancel"),
        },
        async execute({ jobId }) {
          const job = await getJobRecord(jobId)
          if (!job) return `No delegated job found for ID ${jobId}`
          if (job.status !== "running")
            return `Delegated job ${jobId} is not running (status: ${job.status})`
          await runtimeSelection.runtime.stop(job.runtimeHandle)
          const interruptedJob = withCleanup({ ...job, status: "interrupted" }, "cancelled")
          finalStateOverlay.set(jobId, interruptedJob)
          await writeOverlayRecord(finalStateOverlayDir, interruptedJob)
          await saveJobRecord(interruptedJob)
          return `Cancelled delegated job ${jobId}`
        },
      }),
    },
  }
}

function formatCompletionUpdate(params: {
  backend: Backend
  jobId: string
  status: JobRecord["status"]
  summary: string
}): string {
  return `Delegated job ${params.jobId} [${params.backend}] ${params.status}. Summary: ${params.summary} Full report available via delegated_job_snapshot.`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadFinalStateOverlay(directory: string): Promise<Map<string, JobRecord>> {
  const overlay = new Map<string, JobRecord>()

  try {
    const entries = await readdir(directory)

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue

      try {
        const content = await readFile(join(directory, entry), "utf-8")
        const record = JSON.parse(content) as JobRecord
        overlay.set(record.jobId, record)
      } catch {
        // Ignore unreadable overlay entries.
      }
    }
  } catch {
    // Overlay directory is optional until first fallback write.
  }

  return overlay
}

async function writeOverlayRecord(directory: string, record: JobRecord): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(overlayPath(directory, record.jobId), JSON.stringify(record, null, 2), "utf-8")
}

async function deleteOverlayRecord(directory: string, jobId: string): Promise<void> {
  try {
    await unlink(overlayPath(directory, jobId))
  } catch {
    // Ignore missing overlay files.
  }
}

function overlayPath(directory: string, jobId: string): string {
  return join(directory, `${encodeURIComponent(jobId)}.json`)
}
