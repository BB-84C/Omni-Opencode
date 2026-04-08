import { tool, type PluginInput, type Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createJobStore } from "./core/store.js"
import type { Backend, JobRecord } from "./core/jobs.js"
import { extractFinalReport } from "./runtime/extract-report.js"
import { selectRuntime, type SelectRuntimeOptions, type SelectedRuntime } from "./runtime/select-runtime.js"
import { appendTranscriptChunk, createTranscript } from "./runtime/transcript.js"
import type { RuntimeJob, RuntimeMonitor, RuntimeMonitorLookup, RuntimeStartParams } from "./runtime/types.js"

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

function turnKey(parentSessionId: string, parentMessageId: string): string {
  return `${parentSessionId}:${parentMessageId}`
}

function delegatedBatchId(parentSessionId: string, parentMessageId: string): string {
  return turnKey(parentSessionId, parentMessageId)
}

function buildDelegationCommand(backend: Backend, prompt: string): string {
  const escapedPrompt = JSON.stringify(prompt)
  return backend === "claude-code"
    ? `claude --print ${escapedPrompt}`
    : `codex exec --color never ${escapedPrompt}`
}

export function createStoredJobRecord(
  batchId: string,
  parentSessionId: string,
  parentMessageId: string,
  runtimeKind: SelectedRuntime["kind"],
  job: RuntimeJob,
  monitor: RuntimeMonitor,
  status: JobRecord["status"],
  autoOpenAttempted: boolean,
  autoOpenSucceeded: boolean,
): StoredJobRecord {
  const jobId = delegatedJobId(parentSessionId, job.id)
  const monitorSessionId = monitor.sessionId ?? parentSessionId
  const transcriptCaptureTarget = job.monitor.transcriptCaptureTarget ?? monitor.transcriptCaptureTarget
  return {
    jobId,
    batchId,
    parentSessionId,
    parentMessageId,
    monitorSessionId,
    runtimeKind,
    runtimeType: runtimeTypeForSelection(runtimeKind),
    runtimeHandle: job.id,
    attachTarget: monitorNavigationTarget(monitor),
    attachCommand: monitorAttachCommand(monitor),
    logTailCommand: monitor.logTailCommand,
    terminalLogPath: transcriptCaptureTarget ?? monitorNavigationTarget(monitor),
    transcriptCaptureTarget,
    transcriptByteLength: 0,
    transcriptChunkCount: 0,
    backend: job.backend,
    backendThreadId: job.id,
    status,
    autoOpenAttempted,
    autoOpenSucceeded,
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
  batchId: string
  parentSessionId: string
  monitorSessionId: string
  backend: Backend
  status: "running"
  attachCommand: string
  monitorTarget: string
  autoOpenAttempted: boolean
  autoOpenSucceeded: boolean
  monitor: RuntimeMonitor
}

function monitorAttachCommand(monitor: RuntimeMonitor): string {
  return monitor.attachCommand ?? monitor.launch.command
}

function monitorNavigationTarget(monitor: RuntimeMonitor): string {
  return monitor.window?.target ?? monitor.attach.target
}

function monitorLookupForJob(job: StoredJobRecord): RuntimeMonitorLookup {
  if (job.status === "running") {
    return { type: "job", jobId: job.runtimeHandle }
  }

  return usesWindowsPsmuxSharedSession(job)
    ? { type: "shared-session", monitorSessionId: job.monitorSessionId ?? job.parentSessionId }
    : { type: "job", jobId: job.runtimeHandle }
}

function usesWindowsPsmuxSharedSession(job: StoredJobRecord): boolean {
  if (job.runtimeKind !== undefined) {
    return job.runtimeKind === "windows-psmux"
      && typeof job.monitorSessionId === "string"
      && job.monitorSessionId.length > 0
  }

  return job.runtimeType === "pty"
    && typeof job.monitorSessionId === "string"
    && job.monitorSessionId.length > 0
    && (job.attachCommand?.startsWith("psmux attach -t ") === true || job.attachTarget.endsWith(":dashboard"))
}

function didAutoOpenMonitorSucceed(params: {
  kind: SelectedRuntime["kind"]
  autoOpenMonitor: boolean
  startedMonitor: RuntimeMonitor | undefined
}): boolean {
  if (!params.autoOpenMonitor || !params.startedMonitor) {
    return false
  }

  if (params.kind === "windows-psmux") {
    return params.startedMonitor.autoOpenSucceeded === true
  }

  return true
}

function isTerminalJob(record: StoredJobRecord): boolean {
  return record.status !== "running"
}

type ParentSessionMessageClient = PluginInput["client"] & {
  session?: PluginInput["client"]["session"] & {
    promptAsync?(params: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      query?: { directory?: string }
    }): Promise<void>
  }
  message?: {
    create(params: {
      sessionId: string
      role: string
      content: string
    }): Promise<void>
  }
}

export const id = "omni-opencode"

export const OmniOpencodePlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const stateDir = `${directory}/.broker-state`
  const finalStateOverlayDir = join(stateDir, "final-state-overlay")
  const store = createJobStore(stateDir)
  const finalStateOverlay = await loadFinalStateOverlay(finalStateOverlayDir)
  const runtimeSelection = createPluginRuntimeSelection()
  const messageClient = client as ParentSessionMessageClient

  const canReportToParent =
    typeof messageClient.message?.create === "function" ||
    typeof messageClient.session?.promptAsync === "function"
  const delegationRequiredTurns = new Set<string>()
  const delegationLaunchedTurns = new Set<string>()
  const reportedBatchIds = new Set<string>()
  const reportingBatchIds = new Set<string>()
  const transcriptByJobId = new Map<string, string>()
  const transcriptReadOffsets = new Map<string, number>()

  async function listJobRecordsByBatch(batchId: string): Promise<StoredJobRecord[]> {
    return (await listJobRecords()).filter((job) => job.batchId === batchId)
  }

  function formatBatchCompletionUpdate(batchId: string, jobs: StoredJobRecord[]): string {
    const header = `Delegated batch ${batchId} finished. ${jobs.length} job(s) reached terminal status.`
    const details = jobs
      .map((job) => {
        const inspectionRefs = [
          `delegated_job_snapshot({\"jobId\":\"${job.jobId}\"})`,
          `delegated_job_read({\"jobId\":\"${job.jobId}\"})`,
          `delegated_job_attach({\"jobId\":\"${job.jobId}\"})`,
          job.attachCommand ? `attach: ${job.attachCommand}` : null,
          job.logTailCommand ? `log tail: ${job.logTailCommand}` : null,
        ].filter(Boolean).join(" | ")

        const autoOpen = job.autoOpenAttempted
          ? (job.autoOpenSucceeded ? "auto-opened" : "auto-open failed")
          : "auto-open not attempted"

        return [
          `- ${job.jobId} [${job.backend}] ${job.status}: ${job.summary ?? "No structured summary."}`,
          `  monitor=${autoOpen}`,
          `  inspect: ${inspectionRefs}`,
        ].join("\n")
      })
      .join("\n")

    return `${header}\n${details}`
  }

  async function markBatchReported(batchId: string, content: string): Promise<void> {
    const jobs = await listJobRecordsByBatch(batchId)

    await Promise.all(jobs.map((job) => saveFinalStateAfterParentUpdate({
      ...job,
      lastProjectedMessage: content,
    })))
  }

  async function maybeReportBatchCompletion(batchId: string | undefined): Promise<void> {
    if (!batchId || reportedBatchIds.has(batchId) || reportingBatchIds.has(batchId)) {
      return
    }

    const jobs = await listJobRecordsByBatch(batchId)
    if (jobs.length === 0 || jobs.some((job) => !isTerminalJob(job))) {
      return
    }

    reportingBatchIds.add(batchId)
    try {
      const completedJobs = await listJobRecordsByBatch(batchId)
      if (completedJobs.length === 0 || completedJobs.some((job) => !isTerminalJob(job))) {
        return
      }

      const content = formatBatchCompletionUpdate(batchId, completedJobs)
      if (!canReportToParent) {
        const failureContent = `Delegated batch ${batchId} finished, but the aggregate follow-up could not be injected: no parent session reporting api is available`
        reportedBatchIds.add(batchId)
        await markBatchReported(batchId, failureContent)
        return
      }

      await reportBatchToParentSession(completedJobs[0]!.parentSessionId, content)

      reportedBatchIds.add(batchId)
      await markBatchReported(batchId, content)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const content = `Delegated batch ${batchId} finished, but the aggregate follow-up could not be injected: ${detail}`
      reportedBatchIds.add(batchId)
      await markBatchReported(batchId, content)
    } finally {
      reportingBatchIds.delete(batchId)
    }
  }

  async function reportBatchToParentSession(parentSessionId: string, content: string): Promise<void> {
    if (typeof messageClient.message?.create === "function") {
      await messageClient.message.create({
        sessionId: parentSessionId,
        role: "user",
        content,
      })
      return
    }

    if (typeof messageClient.session?.promptAsync === "function") {
      await messageClient.session.promptAsync({
        path: { id: parentSessionId },
        body: {
          parts: [{ type: "text", text: content }],
        },
        query: { directory },
      })
    }
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
        transcriptByJobId.set(record.jobId, transcript.text)
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
        await saveFinalStateAfterParentUpdate(withCleanup({
          ...latest,
          status: "failed",
          summary,
        }, "failed"))
        await maybeReportBatchCompletion(latest.batchId)
        return
      }

      if (runtimeJob.status === "stopped") {
        const latest = await getJobRecord(record.jobId)
        if (!latest || latest.status !== "running") {
          return
        }
        const report = extractFinalReport(transcript)
        const summary = report.summary ?? "Runtime completed without a structured summary."
        const completedRecord = withCleanup({
          ...withTranscriptProgress(latest, transcript),
          status: "completed",
          summary,
          changedFiles: report.changedFiles,
        }, "completed")
        await saveFinalStateAfterParentUpdate(completedRecord)
        await maybeReportBatchCompletion(completedRecord.batchId)
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

    const failedRecord = withCleanup({
      ...current,
      status: "failed",
      summary,
      lastProjectedMessage: summary,
    }, "failed")

    await saveFinalStateAfterParentUpdate(failedRecord)
    await maybeReportBatchCompletion(failedRecord.batchId)
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

  async function readCompletedTranscript(job: StoredJobRecord): Promise<string | undefined> {
    const transcript = transcriptByJobId.get(job.jobId)
    if (transcript !== undefined) {
      const offset = transcriptReadOffsets.get(job.jobId) ?? 0
      const unread = transcript.slice(offset)
      transcriptReadOffsets.set(job.jobId, transcript.length)
      return unread
    }

    if (!job.transcriptCaptureTarget) {
      return undefined
    }

    try {
      const persistedTranscript = await readFile(job.transcriptCaptureTarget, "utf-8")
      const readableTranscript = stripPsmuxExitMarkers(persistedTranscript)
      const offset = transcriptReadOffsets.get(job.jobId) ?? 0
      const unread = readableTranscript.slice(offset)
      transcriptReadOffsets.set(job.jobId, readableTranscript.length)
      return unread
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined
      }

      throw error
    }
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
    parentMessageId: string,
    backend: Backend,
    prompt: string,
  ): Promise<string> {
    const started = await preparePluginRuntimeStart(runtimeSelection, {
      backend,
      command: buildDelegationCommand(backend, prompt),
      monitorSessionId: parentSessionId,
    })
    const monitor = started.monitor ?? started.job.monitor
    const autoOpenSucceeded = didAutoOpenMonitorSucceed({
      kind: started.kind,
      autoOpenMonitor: runtimeSelection.autoOpenMonitor,
      startedMonitor: started.monitor,
    })
    const record = createStoredJobRecord(
      delegatedBatchId(parentSessionId, parentMessageId),
      parentSessionId,
      parentMessageId,
      started.kind,
      started.job,
      monitor,
      "running",
      runtimeSelection.autoOpenMonitor,
      autoOpenSucceeded,
    )
    await store.save(record)

    const result: DelegationLaunchResult = {
      jobId: record.jobId,
      batchId: record.batchId ?? delegatedBatchId(parentSessionId, parentMessageId),
      parentSessionId,
      monitorSessionId: record.monitorSessionId ?? parentSessionId,
      backend,
      status: "running",
      attachCommand: monitorAttachCommand(monitor),
      monitorTarget: monitor.attach.target,
      autoOpenAttempted: runtimeSelection.autoOpenMonitor,
      autoOpenSucceeded,
      monitor,
    }

    void monitorDelegationCompletion(record).catch((error) => recordMonitorCrash(record, error))

    return JSON.stringify(result, null, 2)
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const latestUser = [...output.messages]
        .reverse()
        .find(message => message.info.role === "user")

      if (!latestUser) {
        return
      }

      const text = latestUser.parts
        .filter(part => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map(part => (part as { text: string }).text)
        .join("\n")
        .toLowerCase()

      const asksForClaude = text.includes("claude code") || text.includes("delegate_to_claude")
      const asksForCodex = text.includes("codex") || text.includes("delegate_to_codex")
      const asksForDelegation = text.includes("delegate") || text.includes("delegation")

      if (asksForDelegation && (asksForClaude || asksForCodex)) {
        delegationRequiredTurns.add(turnKey(latestUser.info.sessionID, latestUser.info.id))
      }
    },
    "permission.ask": async (input, output) => {
      const blockedDelegationSubstitutes = new Set([
        "task",
        "webfetch",
        "websearch",
        "codesearch",
        "read",
        "glob",
        "grep",
        "chrome-devtools_new_page",
        "chrome-devtools_take_snapshot",
        "chrome-devtools_click",
        "playwright_browser_navigate",
        "playwright_browser_snapshot",
        "playwright_browser_run_code",
      ])

      const blockedAfterLaunch = new Set([
        ...blockedDelegationSubstitutes,
        "bash",
        "delegated_jobs_list",
        "delegated_job_snapshot",
        "delegated_job_read",
        "delegated_job_attach",
      ])

      const currentTurn = turnKey(input.sessionID, input.messageID)
      if (delegationLaunchedTurns.has(currentTurn) && blockedAfterLaunch.has(input.title)) {
        output.status = "deny"
        return
      }

      if (delegationRequiredTurns.has(currentTurn) && blockedDelegationSubstitutes.has(input.title)) {
        output.status = "deny"
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        "When the user explicitly asks to delegate work to Codex or Claude Code, you MUST prefer the plugin tools `delegate_to_codex` and `delegate_to_claude`. " +
          "Do not use the built-in task tool, repository inspection, or browser/web research as a substitute for explicit Codex/Claude delegation unless those plugin tools fail. " +
          "After successful delegation launches, reply once with the launched job IDs, batch ID, and attach commands, then stop. Do not poll delegated job tools, sleep, or wait for completion in the same turn; the plugin will send a later aggregate user follow-up when the whole batch finishes.",
      )
    },
    "tool.definition": async (input, output) => {
      const deprioritized = new Set([
        "task",
        "webfetch",
        "read",
        "glob",
        "grep",
        "chrome-devtools_new_page",
        "chrome-devtools_take_snapshot",
        "chrome-devtools_click",
        "playwright_browser_navigate",
        "playwright_browser_snapshot",
        "playwright_browser_run_code",
      ])

      if (!deprioritized.has(input.toolID)) {
        return
      }

      output.description = `${output.description} Not for explicit Codex/Claude delegation requests; prefer delegate_to_codex and delegate_to_claude instead.`
    },
    tool: {
      delegate_to_claude: tool({
        description:
          "Delegate a coding or research task to Claude Code, auto-open a live monitor when available, and return monitor metadata immediately. Use this when the user explicitly asks for Claude Code delegation.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Claude Code"),
        },
        async execute({ prompt }, context) {
          const currentTurn = turnKey(context.sessionID, context.messageID)
          delegationRequiredTurns.delete(currentTurn)
          delegationLaunchedTurns.add(currentTurn)
          return launchDelegation(context.sessionID, context.messageID, "claude-code", prompt)
        },
      }),

      delegate_to_codex: tool({
        description:
          "Delegate a coding or research task to OpenAI Codex, auto-open a live monitor when available, and return monitor metadata immediately. Use this when the user explicitly asks for Codex delegation.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Codex"),
        },
        async execute({ prompt }, context) {
          const currentTurn = turnKey(context.sessionID, context.messageID)
          delegationRequiredTurns.delete(currentTurn)
          delegationLaunchedTurns.add(currentTurn)
          return launchDelegation(context.sessionID, context.messageID, "codex", prompt)
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
                j.batchId ? `batch=${j.batchId}` : null,
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

          if (job.status !== "running") {
            const transcript = await readCompletedTranscript(job)
            if (transcript !== undefined) {
              const unread = transcript
              return unread || `No new output for delegated job ${jobId}`
            }
          }

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

          const monitor = await runtimeSelection.runtime.openMonitor(monitorLookupForJob(job))
          const refreshedJob: StoredJobRecord = {
            ...job,
            monitorSessionId: monitor.sessionId ?? job.monitorSessionId,
            attachTarget: monitorNavigationTarget(monitor),
            attachCommand: monitorAttachCommand(monitor),
            logTailCommand: monitor.logTailCommand,
            terminalLogPath: monitor.transcriptCaptureTarget ?? job.transcriptCaptureTarget ?? monitorNavigationTarget(monitor),
            transcriptCaptureTarget: monitor.transcriptCaptureTarget ?? job.transcriptCaptureTarget,
          }

          await saveJobRecord(refreshedJob)

          return JSON.stringify({
            jobId: refreshedJob.jobId,
            runtimeType: refreshedJob.runtimeType,
            attach: monitor.attach,
            window: monitor.window,
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
          await maybeReportBatchCompletion(interruptedJob.batchId)
          return `Cancelled delegated job ${jobId}`
        },
      }),
    },
  }
}

export default {
  id,
  server: OmniOpencodePlugin,
}

export const server = OmniOpencodePlugin

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

function stripPsmuxExitMarkers(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("__OMNI_OPENCODE_PSMUX_EXIT__:"))
    .join("\n")
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
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
