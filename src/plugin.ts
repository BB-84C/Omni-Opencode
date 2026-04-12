import { tool, type PluginInput, type Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createJobStore } from "./core/store.js"
import type { ApprovalMode, Backend, DelegationTaskClass, JobRecord, PermissionProfile } from "./core/jobs.js"
import {
  normalizeDelegationApprovalChoice,
} from "./core/session-approval-state.js"
import {
  createDelegationGrantStore,
  findMatchingDelegationGrant,
  type DelegatedSessionCapability,
} from "./core/delegation-grants.js"
import {
  deriveDelegationCapabilities,
  fingerprintDelegationCapabilities,
  type DelegationCapabilities,
} from "./core/delegation-permissions.js"
import type { DelegatedCapabilityDecision } from "./core/delegation-permissions.js"
import { readDelegationLaunchContext } from "./core/delegation-launch-context.js"
import { toClaudeCapabilityPolicy } from "./adapters/policy-mappers.js"
import { toCodexCapabilityPolicy } from "./adapters/policy-mappers.js"
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

function buildDelegationCommandArgs(backend: Backend, prompt: string): string[] {
  return backend === "claude-code"
    ? ["claude", "--print", prompt]
    : ["codex", "exec", "--color", "never", prompt]
}

function buildPromptFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex")
}

function buildCorrelationMarker(parentSessionId: string, parentMessageId: string, backend: Backend): string {
  return `omni-opencode:${parentSessionId}:${parentMessageId}:${backend}`
}

export function createStoredJobRecord(
  batchId: string,
  parentSessionId: string,
  parentMessageId: string,
  runtimeKind: SelectedRuntime["kind"],
  job: RuntimeJob,
  monitor: RuntimeMonitor,
  launchMetadata: RuntimeStartParams["launchMetadata"],
  delegationMetadata: {
    taskClass: DelegationTaskClass
    permissionProfile: PermissionProfile
    approvalMode: ApprovalMode
  },
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
    promptFingerprint: launchMetadata?.promptFingerprint,
    correlationMarker: launchMetadata?.correlationMarker,
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
    ...extractRuntimeBackendSession(job),
    taskClass: delegationMetadata.taskClass,
    permissionProfile: delegationMetadata.permissionProfile,
    approvalMode: delegationMetadata.approvalMode,
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

type DelegationExecutionContext = {
  sessionID: string
  messageID: string
  agent?: string
  permissions?: unknown
  authoritativeDelegationPermissions?: unknown
  externalDirectories?: unknown
  directory?: string
  worktree?: string
  ask?: unknown
}

const DELEGATED_CAPABILITY_ORDER: DelegatedSessionCapability[] = [
  "workspaceWrite",
  "shell",
  "network",
  "subagentLaunch",
]

const DELEGATED_CAPABILITY_LABELS: Record<DelegatedSessionCapability, string> = {
  workspaceWrite: "file edits",
  shell: "shell commands",
  network: "network access",
  subagentLaunch: "subagent launches",
}

function askCapabilities(capabilities: DelegationCapabilities): DelegatedSessionCapability[] {
  return DELEGATED_CAPABILITY_ORDER.filter(capability => capabilities[capability] === "ask")
}

function formatCapabilityNames(capabilities: readonly DelegatedSessionCapability[]): string {
  const names = capabilities.map(capability => DELEGATED_CAPABILITY_LABELS[capability])

  if (names.length <= 1) {
    return names[0] ?? "delegated capabilities"
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`
  }

  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
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

function extractRuntimeBackendSession(job: RuntimeJob): Pick<JobRecord, "backendSessionId" | "backendResumeSessionId"> {
  const candidate = job as RuntimeJob & {
    backendSessionId?: unknown
    backendResumeSessionId?: unknown
    backendSession?: {
      sessionId?: unknown
      resumeSessionId?: unknown
    }
  }

  return {
    backendSessionId: normalizeOptionalString(candidate.backendSessionId)
      ?? normalizeOptionalString(candidate.backendSession?.sessionId),
    backendResumeSessionId: normalizeOptionalString(candidate.backendResumeSessionId)
      ?? normalizeOptionalString(candidate.backendSession?.resumeSessionId),
  }
}

function mergeRuntimeBackendSession(record: StoredJobRecord, job: RuntimeJob): StoredJobRecord {
  const backendSession = extractRuntimeBackendSession(job)

  return {
    ...record,
    backendSessionId: backendSession.backendSessionId ?? record.backendSessionId,
    backendResumeSessionId: backendSession.backendResumeSessionId ?? record.backendResumeSessionId,
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

export const id = "omni-opencode"

export const OmniOpencodePlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const stateDir = `${directory}/.broker-state`
  const finalStateOverlayDir = join(stateDir, "final-state-overlay")
  const store = createJobStore(stateDir)
  const delegationGrantStore = createDelegationGrantStore(join(stateDir, "delegation-grants"))
  const finalStateOverlay = await loadFinalStateOverlay(finalStateOverlayDir)
  const runtimeSelection = createPluginRuntimeSelection()
  const messageClient = client as ParentSessionMessageClient
  const authorityClient = typeof (client as { app?: { agents?: unknown } }).app?.agents === "function"
    ? client
    : undefined

  const canReportToParent =
    typeof messageClient.message?.create === "function" ||
    typeof messageClient.session?.promptAsync === "function"
  const delegationRequiredTurns = new Set<string>()
  const delegationLaunchedTurns = new Set<string>()
  const reportedBatchIds = new Set<string>()
  const reportingBatchIds = new Set<string>()
  const pendingSessionRetries = new Set<string>()
  const scheduledSessionRetries = new Map<string, NodeJS.Timeout>()
  const reportedJobIds = new Set<string>()
  const activeBatchLaunches = new Map<string, number>()
  const transcriptByJobId = new Map<string, string>()
  const transcriptReadOffsets = new Map<string, number>()

  async function listJobRecordsByBatch(batchId: string): Promise<StoredJobRecord[]> {
    return (await listJobRecords()).filter((job) => job.batchId === batchId)
  }

  async function listJobRecordsBySession(sessionId: string): Promise<StoredJobRecord[]> {
    return (await listJobRecords()).filter((job) => job.parentSessionId === sessionId)
  }

  function formatParentFacingJobStatus(job: StoredJobRecord): string {
    return job.cleanupReason === "cancelled" || job.status === "interrupted"
      ? "cancelled"
      : job.status
  }

  function formatSessionCompletionUpdate(sessionId: string, jobs: StoredJobRecord[]): string {
    const newJobs = jobs.filter((job) => !reportedJobIds.has(job.jobId))
    if (newJobs.length === 0) {
      return `All delegated jobs in session ${sessionId} finished (no new jobs to report).`
    }
    const header = `${newJobs.length} delegated job(s) finished.`
    const details = newJobs
      .map((job) => {
        const status = formatParentFacingJobStatus(job)
        return `- ${job.jobId} [${job.backend}] ${status} | snapshot: delegated_job_snapshot({\"jobId\":\"${job.jobId}\"}) | transcript: delegated_job_read({\"jobId\":\"${job.jobId}\"}) | monitor: delegated_job_attach({\"jobId\":\"${job.jobId}\"})`
      })
      .join("\n")

    return `${header}\n${details}`
  }

  async function markSessionReported(sessionId: string, content: string): Promise<void> {
    const jobs = await listJobRecordsBySession(sessionId)

    for (const job of jobs) {
      reportedJobIds.add(job.jobId)
    }

    await Promise.all(jobs.map((job) => saveFinalStateAfterParentUpdate({
      ...job,
      lastProjectedMessage: content,
    })))
  }

  function decrementSessionLaunches(sessionId: string): void {
    const remaining = (activeBatchLaunches.get(sessionId) ?? 1) - 1
    if (remaining <= 0) {
      activeBatchLaunches.delete(sessionId)
      // Re-check session completion now that all launches have settled —
      // a monitor may have tried to report while launches were still in-flight.
      void maybeReportSessionCompletion(sessionId)
    } else {
      activeBatchLaunches.set(sessionId, remaining)
    }
  }

  function scheduleSessionCompletionRetry(sessionId: string | undefined): void {
    if (!sessionId || reportedBatchIds.has(sessionId) || scheduledSessionRetries.has(sessionId)) {
      return
    }

    const timer = setTimeout(() => {
      scheduledSessionRetries.delete(sessionId)
      void maybeReportSessionCompletion(sessionId)
    }, 150)
    scheduledSessionRetries.set(sessionId, timer)
  }

  async function maybeReportSessionCompletion(sessionId: string | undefined): Promise<void> {
    if (!sessionId || reportedBatchIds.has(sessionId)) {
      return
    }

    // Don't report if there are still in-flight launches for this session —
    // other jobs may not have been created/saved yet.
    const inFlight = activeBatchLaunches.get(sessionId) ?? 0
    if (inFlight > 0) {
      scheduleSessionCompletionRetry(sessionId)
      return
    }

    // If another check is already in progress, queue a retry after it finishes
    // rather than silently bailing — the in-progress check might not see our
    // job's terminal state yet.
    if (reportingBatchIds.has(sessionId)) {
      pendingSessionRetries.add(sessionId)
      return
    }

    reportingBatchIds.add(sessionId)

    try {
      const jobs = await listJobRecordsBySession(sessionId)
      if (jobs.length === 0 || jobs.some((job) => !isTerminalJob(job))) {
        scheduleSessionCompletionRetry(sessionId)
        return
      }

      const completedJobs = await listJobRecordsBySession(sessionId)
      if (completedJobs.length === 0 || completedJobs.some((job) => !isTerminalJob(job))) {
        scheduleSessionCompletionRetry(sessionId)
        return
      }

      // Seed reportedJobIds from jobs that were already reported in a prior
      // plugin instance (they have lastProjectedMessage set in the store).
      for (const job of completedJobs) {
        if (job.lastProjectedMessage) {
          reportedJobIds.add(job.jobId)
        }
      }

      const newJobs = completedJobs.filter((job) => !reportedJobIds.has(job.jobId))
      if (newJobs.length === 0) {
        // All jobs were already reported in a previous batch — nothing new to inject.
        reportedBatchIds.add(sessionId)
        await markSessionReported(sessionId, "")
        return
      }

      const content = formatSessionCompletionUpdate(sessionId, completedJobs)
      if (!canReportToParent) {
        const failureContent = `All delegated jobs in session ${sessionId} finished, but the aggregate follow-up could not be injected: no parent session reporting api is available`
        reportedBatchIds.add(sessionId)
        await markSessionReported(sessionId, failureContent)
        return
      }

      await reportBatchToParentSession(sessionId, content)

      reportedBatchIds.add(sessionId)
      const scheduledRetry = scheduledSessionRetries.get(sessionId)
      if (scheduledRetry) {
        clearTimeout(scheduledRetry)
        scheduledSessionRetries.delete(sessionId)
      }
      await markSessionReported(sessionId, content)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const content = `All delegated jobs in session ${sessionId} finished, but the aggregate follow-up could not be injected: ${detail}`
      reportedBatchIds.add(sessionId)
      const scheduledRetry = scheduledSessionRetries.get(sessionId)
      if (scheduledRetry) {
        clearTimeout(scheduledRetry)
        scheduledSessionRetries.delete(sessionId)
      }
      await markSessionReported(sessionId, content)
    } finally {
      reportingBatchIds.delete(sessionId)
      // If another monitor requested a retry while we were checking, run it now.
      if (pendingSessionRetries.has(sessionId)) {
        pendingSessionRetries.delete(sessionId)
        scheduleSessionCompletionRetry(sessionId)
      }
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
        await maybeReportSessionCompletion(latest.parentSessionId)
        return
      }

      const latest = await getJobRecord(record.jobId)
      if (!latest || latest.status !== "running") {
        return
      }

      const correlatedJob = mergeRuntimeBackendSession(latest, runtimeJob)

      if (runtimeJob.status === "stopped") {
        const report = extractFinalReport(transcript)
        const summary = report.summary ?? "Runtime completed without a structured summary."
        const completedRecord = withCleanup({
          ...withTranscriptProgress(correlatedJob, transcript),
          status: "completed",
          summary,
          changedFiles: report.changedFiles,
        }, "completed")
        await saveFinalStateAfterParentUpdate(completedRecord)
        await maybeReportSessionCompletion(completedRecord.parentSessionId)
        return
      }

      await saveJobRecord(correlatedJob)

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
    await maybeReportSessionCompletion(failedRecord.parentSessionId)
  }

  async function saveFinalStateAfterParentUpdate(record: StoredJobRecord): Promise<void> {
    const existing = (finalStateOverlay.get(record.jobId) ?? await store.get(record.jobId)) as StoredJobRecord | undefined
    const effectiveRecord = existing && existing.status !== "running" && (
      existing.status !== record.status || existing.cleanupReason !== record.cleanupReason
    )
      ? {
          ...existing,
          lastProjectedMessage: record.lastProjectedMessage ?? existing.lastProjectedMessage,
          backendSessionId: record.backendSessionId ?? existing.backendSessionId,
          backendResumeSessionId: record.backendResumeSessionId ?? existing.backendResumeSessionId,
        }
      : record

    try {
      await store.save(effectiveRecord)
      finalStateOverlay.delete(effectiveRecord.jobId)
      await deleteOverlayRecord(finalStateOverlayDir, effectiveRecord.jobId)
    } catch {
      // The parent session already received the update; keep reads consistent in-process and across restart.
      finalStateOverlay.set(effectiveRecord.jobId, effectiveRecord)
      await writeOverlayRecord(finalStateOverlayDir, effectiveRecord)
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

  async function resolveApprovalMode(
    context: DelegationExecutionContext,
    backend: Backend,
    prompt: string,
    launchContext?: Awaited<ReturnType<typeof readDelegationLaunchContext>>,
    capabilities?: DelegationCapabilities,
  ): Promise<{ approvalMode: ApprovalMode; effectiveCapabilities: DelegationCapabilities }> {
    const resolvedLaunchContext = launchContext ?? await readDelegationLaunchContext(context, authorityClient)
    const resolvedCapabilities = capabilities ?? deriveDelegationCapabilities(resolvedLaunchContext.permissionInput)
    const permissionEnvelopeFingerprint = fingerprintDelegationCapabilities(resolvedCapabilities)
    const grantedCapabilities = await delegationGrantStore.get(context.sessionID)
    const grantedAskCapabilities = askCapabilities(resolvedCapabilities).filter(capability => findMatchingDelegationGrant({
      grants: grantedCapabilities,
      parentSessionId: context.sessionID,
      backend,
      agentKey: resolvedLaunchContext.agentKey,
      permissionEnvelopeFingerprint,
      capability,
      workspaceRoot: resolvedLaunchContext.workspaceRoot,
      scope: "session",
    }))
    const unresolvedCapabilities = askCapabilities(resolvedCapabilities).filter(capability => !grantedAskCapabilities.includes(capability))

    if (unresolvedCapabilities.length === 0) {
      return {
        approvalMode: askCapabilities(resolvedCapabilities).length > 0 ? "session" : "not-required",
        effectiveCapabilities: applyDelegationCapabilityDecisions(resolvedCapabilities, grantedAskCapabilities, "allow"),
      }
    }

    const response = typeof context.ask === "function"
      ? await (context.ask as (input: unknown) => Promise<unknown>)({
        title: "Delegated capability approval required",
        description: `This delegated task requires approval for ${formatCapabilityNames(unresolvedCapabilities)}. Prompt: ${prompt}`,
        options: ["allow-once", "allow-session", "deny"],
      })
      : undefined
    const choice = normalizeDelegationApprovalChoice(response)

    if (choice === "session") {
      await Promise.all(unresolvedCapabilities.map(capability => delegationGrantStore.save({
        parentSessionId: context.sessionID,
        backend,
        agentKey: resolvedLaunchContext.agentKey,
        permissionEnvelopeFingerprint,
        capability,
        workspaceRoot: resolvedLaunchContext.workspaceRoot,
        scope: "session",
        approvedAt: Date.now(),
      })))
    }

    if (choice === "deny") {
      throw new Error("Delegated capabilities were not approved")
    }

    return {
      approvalMode: choice,
      effectiveCapabilities: applyDelegationCapabilityDecisions(
        resolvedCapabilities,
        [...grantedAskCapabilities, ...unresolvedCapabilities],
        "allow",
      ),
    }
  }

  function applyDelegationCapabilityDecisions(
    capabilities: DelegationCapabilities,
    capabilityKeys: readonly DelegatedSessionCapability[],
    decision: DelegatedCapabilityDecision,
  ): DelegationCapabilities {
    if (capabilityKeys.length === 0) {
      return capabilities
    }

    const effectiveCapabilities = { ...capabilities }

    for (const capability of capabilityKeys) {
      effectiveCapabilities[capability] = decision
    }

    return effectiveCapabilities
  }

  function deriveDelegationMetadataFromCapabilities(capabilities: DelegationCapabilities): {
    taskClass: DelegationTaskClass
    permissionProfile: PermissionProfile
  } {
    const hasWorkspaceWrite = capabilities.workspaceWrite === "allow"
    const hasShell = capabilities.shell === "allow"
    const hasNetwork = capabilities.network === "allow"
    const hasExternalDirectories = capabilities.allowedRoots.length > 0

    if (hasWorkspaceWrite || hasShell || hasNetwork || hasExternalDirectories) {
      return {
        taskClass: "workspace-write",
        permissionProfile: "dangerous",
      }
    }

    return {
      taskClass: "review",
      permissionProfile: "safe",
    }
  }

  async function launchDelegation(
    context: DelegationExecutionContext,
    backend: Backend,
    prompt: string,
  ): Promise<string> {
    const parentSessionId = context.sessionID
    const parentMessageId = context.messageID
    const currentLaunchContext = await readDelegationLaunchContext(context, authorityClient)
    const capabilities = deriveDelegationCapabilities(currentLaunchContext.permissionInput)
    const { approvalMode, effectiveCapabilities } = await resolveApprovalMode(context, backend, prompt, currentLaunchContext, capabilities)
    const delegationMetadata = deriveDelegationMetadataFromCapabilities(effectiveCapabilities)
    const promptFingerprint = buildPromptFingerprint(prompt)
    const correlationMarker = buildCorrelationMarker(parentSessionId, parentMessageId, backend)
    const launchMetadata = {
      prompt,
      promptFingerprint,
      correlationMarker,
      ...(backend === "claude-code" ? { claudePolicy: toClaudeCapabilityPolicy(effectiveCapabilities) } : {}),
      ...(backend === "codex" ? { codexPolicy: toCodexCapabilityPolicy(effectiveCapabilities) } : {}),
    }
    const started = await preparePluginRuntimeStart(runtimeSelection, {
      backend,
      command: buildDelegationCommand(backend, prompt),
      cwd: currentLaunchContext.runtimeCwd,
      commandArgs: buildDelegationCommandArgs(backend, prompt),
      launchMetadata,
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
      launchMetadata,
      {
        ...delegationMetadata,
        approvalMode,
      },
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
          const sessionId = context.sessionID
          reportedBatchIds.delete(sessionId)
          activeBatchLaunches.set(sessionId, (activeBatchLaunches.get(sessionId) ?? 0) + 1)
          scheduleSessionCompletionRetry(sessionId)
          try {
            return await launchDelegation(context, "claude-code", prompt)
          } finally {
            decrementSessionLaunches(sessionId)
          }
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
          const sessionId = context.sessionID
          reportedBatchIds.delete(sessionId)
          activeBatchLaunches.set(sessionId, (activeBatchLaunches.get(sessionId) ?? 0) + 1)
          scheduleSessionCompletionRetry(sessionId)
          try {
            return await launchDelegation(context, "codex", prompt)
          } finally {
            decrementSessionLaunches(sessionId)
          }
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
          const interruptedJob = withCleanup({ ...job, status: "interrupted" }, "cancelled")
          finalStateOverlay.set(jobId, interruptedJob)
          try {
            await writeOverlayRecord(finalStateOverlayDir, interruptedJob)
            await runtimeSelection.runtime.stop(job.runtimeHandle)
          } catch (error) {
            finalStateOverlay.delete(jobId)
            await deleteOverlayRecord(finalStateOverlayDir, jobId)
            throw error
          }
          await saveJobRecord(interruptedJob)
          await maybeReportSessionCompletion(interruptedJob.parentSessionId)
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
