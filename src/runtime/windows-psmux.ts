import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { spawn as spawnProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import type { EnsureManagedWindowsPsmuxInstalledOptions } from "./windows-psmux-managed.js"
import type { WindowsPtyClient, WindowsPtyRuntimeOptions } from "./windows-pty.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeMonitorLookup, RuntimeReadResult, RuntimeSnapshot, RuntimeStartParams } from "./types.js"
import { CodexStreamParser } from "./codex-stream-parser.js"
import { ClaudeStreamParser } from "./claude-stream-parser.js"
import type { DelegationStreamEvent } from "./delegation-stream-types.js"
import { normalizeClaudeSessionCorrelation } from "./claude-session-discovery.js"
import { discoverCodexSessionFromHistory } from "./codex-session-discovery.js"
import {
  WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
  WINDOWS_PSMUX_INSTALL_DOCS_URL,
  createWindowsPsmuxBootstrapReport,
  detectWindowsPsmux,
} from "./windows-psmux-shared.js"
import { dirname, isAbsolute, join } from "node:path"
import { ensureManagedWindowsPsmuxInstalled, resolveManagedWindowsPsmuxPaths } from "./windows-psmux-managed.js"
import { buildDashboardSnapshot } from "./windows-dashboard-snapshot.js"
import type { ClaudeCapabilityPolicy } from "../core/claude-policy.js"
import type { CodexCapabilityPolicy } from "../core/codex-policy.js"

export {
  WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
  WINDOWS_PSMUX_INSTALL_DOCS_URL,
  createWindowsPsmuxBootstrapReport,
  detectWindowsPsmux,
  ensureManagedWindowsPsmuxInstalled,
  resolveManagedWindowsPsmuxPaths,
}

export type WindowsPsmuxDetection = {
  available: boolean
  command: string
  reason?: "missing-on-path" | "version-check-failed"
  resolvedPath?: string
  version?: string
  error?: string
}

export type DetectWindowsPsmuxOptions = {
  platform?: NodeJS.Platform
  command?: string
  which?: (command: string) => Promise<string | undefined> | string | undefined
  runVersion?: (
    command: string,
    args: string[],
  ) =>
    | Promise<{ exitCode: number; stdout?: string; stderr?: string }>
    | { exitCode: number; stdout?: string; stderr?: string }
}

export type WindowsPsmuxRuntimeOptions = {
  shell?: string
  platform?: NodeJS.Platform
  arch?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  runPsmuxCommand?: (command: string) => Promise<void> | void
  runPsmuxQuery?: (command: string) => Promise<string> | string
  runPsmuxArgQuery?: (command: string, args: string[]) => Promise<string> | string
  runShellCommand?: (command: string) => Promise<void> | void
  runShellQuery?: (command: string) => Promise<string> | string
  hasSharedSession?: (sessionId: string) => Promise<boolean> | boolean
  open?: (params: {
    jobId: string
    target: string
    cwd?: string
    attachCommand: string
    logTailCommand?: string
  }) => Promise<void> | void
  launchSharedSessionClient?: (params: {
    sessionId: string
    jobId: string
    backend: RuntimeStartParams["backend"]
    shell: string
    command: string
    cwd?: string
    env?: NodeJS.ProcessEnv
    logDirectory: string
  }) => Promise<WindowsPtyClient> | WindowsPtyClient
  ensureManagedPsmuxInstalled?: (options?: {
    cwd?: string
    platform?: NodeJS.Platform
    arch?: string
  }) => Promise<{ binaryPath: string }>
  managedPsmuxInstallOptions?: Omit<EnsureManagedWindowsPsmuxInstalledOptions, "cwd" | "platform" | "arch">
  readTranscriptCaptureFile?: (
    target: string,
    offset: number,
  ) => Promise<WindowsPsmuxTranscriptChunk> | WindowsPsmuxTranscriptChunk
  buildDashboardProcessCommand?: (snapshotPath: string) => string
  readCodexHistoryJsonl?: () => Promise<string> | string
  waitForCodexHistoryPoll?: (delayMs: number) => Promise<void> | void
  codexHistoryPollAttempts?: number
  codexHistoryPollIntervalMs?: number
}

type WindowsPsmuxState = {
  job: RuntimeJob
  sessionId: string
  executionTarget: string
  executionWindowIndex?: number
  transcriptCaptureTarget: string
  transcriptOffset: number
  transcriptStatusOffset: number
  transcriptMode: "file" | "pane"
  structuredStreamCaptureTarget?: string
  structuredStreamOffset: number
  streamParser?: CodexStreamParser | ClaudeStreamParser
  dashboardStatus: "running" | "waiting-approval" | "completed" | "failed" | "cancelled" | "stopped"
  dashboardPhase?: string
}

type WindowsPsmuxExecutionWindow = {
  target: string
  paneTarget: string
  index: number
}

type WindowsPsmuxJobLaunchPlan = {
  commandArgs?: string[]
  command?: string
  firstPrompt?: string
  submitKey?: string
  transcriptMode: "file" | "pane"
  backendSessionId?: string
  backendResumeSessionId?: string
  outputMode?: "native" | "stream-json-renderer"
  streamProtocol?: "codex-json" | "claude-stream-json"
}

type WindowsPsmuxStructuredBackendLaunch = {
  scriptPath: string
  rendererNodeCommand?: string
}

type WindowsPsmuxCodexCapabilityPolicy = CodexCapabilityPolicy

type WindowsPsmuxCodexCommand =
  | { kind: "node-script"; nodeCommand: string; codexScriptPath: string }
  | { kind: "direct-executable"; backendCommand: string }

type WindowsPsmuxTranscriptChunk = {
  data: string
  nextOffset: number
}

const WINDOWS_PSMUX_EXIT_MARKER = "__OMNI_OPENCODE_PSMUX_EXIT__:"

function formatDelegatedTranscriptPromptHeader(prompt: string): string {
  return `[omni-opencode] prompt\n${prompt}\n------------------------------\n`
}

export type WindowsPsmuxDashboardLayout = {
  window: {
    name: "dashboard"
    target: string
  }
  panes: {
    dashboard: {
      id: "dashboard"
      target: string
    }
    shell: {
      id: "shell"
      target: string
    }
  }
  metadata: {
    highlightedJobIds: string[]
  }
  jobIds: string[]
}

type WindowsPsmuxPaneGeometry = {
  target: string
  index: number
  left: number
  top: number
  width: number
  height: number
}

type SharedPsmuxSession = {
  sessionId: string
  psmuxCommand: string
  attachCommand: string
  target: string
  dashboard: WindowsPsmuxDashboardLayout
  jobIds: Set<string>
  opened: boolean
  snapshotPath: string
}

export function createWindowsPsmuxDashboardLayout(sessionId: string): WindowsPsmuxDashboardLayout {
  const windowTarget = `${sessionId}:dashboard`

  return {
    window: {
      name: "dashboard",
      target: windowTarget,
    },
    panes: {
      dashboard: {
        id: "dashboard",
        target: windowTarget,
      },
      shell: {
        id: "shell",
        target: windowTarget,
      },
    },
    metadata: {
      highlightedJobIds: [],
    },
    jobIds: [],
  }
}

function getWindowsPsmuxDashboardHighlightedJobIds(jobIds: string[]): string[] {
  return jobIds.slice(-2)
}

export function discoverWindowsPsmuxDashboardLayout(
  sessionId: string,
  listPanesOutput: string,
): WindowsPsmuxDashboardLayout {
  const panes = parseWindowsPsmuxPaneGeometries(listPanesOutput)
  if (panes.length < 2) {
    throw new Error(`Expected dashboard '${sessionId}:dashboard' to have at least 2 panes, found ${panes.length}`)
  }

  // Pick the leftmost pane as the dashboard, the next one as the shell.
  // Extra panes (from prior layout changes) are ignored.
  const sorted = [...panes].sort((left, right) => left.left - right.left || left.index - right.index)
  const dashboardPane = sorted[0]!
  const shellPane = sorted[1]!

  return {
    ...createWindowsPsmuxDashboardLayout(sessionId),
    panes: {
      dashboard: {
        id: "dashboard",
        target: dashboardPane.target,
      },
      shell: {
        id: "shell",
        target: shellPane.target,
      },
    },
  }
}

export function registerWindowsPsmuxDashboardJob(
  dashboard: WindowsPsmuxDashboardLayout,
  jobId: string,
): WindowsPsmuxDashboardLayout {
  const jobIds = [...dashboard.jobIds.filter((id) => id !== jobId), jobId]

  return {
    ...dashboard,
    jobIds,
    metadata: {
      highlightedJobIds: getWindowsPsmuxDashboardHighlightedJobIds(jobIds),
    },
  }
}

export function unregisterWindowsPsmuxDashboardJob(
  dashboard: WindowsPsmuxDashboardLayout,
  jobId: string,
): WindowsPsmuxDashboardLayout {
  const jobIds = dashboard.jobIds.filter((id) => id !== jobId)

  return {
    ...dashboard,
    jobIds,
    metadata: {
      highlightedJobIds: getWindowsPsmuxDashboardHighlightedJobIds(jobIds),
    },
  }
}

export function getWindowsPsmuxBootstrapHooks(): {
  scriptName: typeof WINDOWS_PSMUX_BOOTSTRAP_SCRIPT
  installDocsUrl: typeof WINDOWS_PSMUX_INSTALL_DOCS_URL
} {
  return {
    scriptName: WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
    installDocsUrl: WINDOWS_PSMUX_INSTALL_DOCS_URL,
  }
}

export function createMissingWindowsPsmuxError(command = "psmux"): Error {
  return new Error(
    `Windows psmux runtime requires the managed psmux binary at '${command}'. Run 'npm run ${WINDOWS_PSMUX_BOOTSTRAP_SCRIPT}' to provision the plugin-managed cache before launching delegated jobs.`,
  )
}

export function createWindowsPsmuxRuntime(options: WindowsPsmuxRuntimeOptions = {}): Runtime {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const shell = options.shell ?? "powershell.exe"
  const cwd = options.cwd
  const env = options.env
  const runShellCommand = options.runShellCommand ?? ((command: string) => runWindowsPsmuxShellCommand(command, { shell, cwd, env }))
  const runShellQuery = options.runShellQuery ?? ((command: string) => runWindowsPsmuxShellQuery(command, { shell, cwd, env }))
  const runPsmuxCommand = options.runPsmuxCommand ?? runShellCommand
  const runPsmuxQuery = options.runPsmuxQuery ?? runShellQuery
  const runPsmuxArgQuery = options.runPsmuxArgQuery ?? ((command: string, args: string[]) => runWindowsPsmuxArgQuery(command, args, { cwd, env }))
  const open = options.open ?? openWindowsPsmuxMonitor
  const logDirectory = join(cwd ?? process.cwd(), ".omni-monitors")
  const managedPsmuxPaths = resolveManagedWindowsPsmuxPaths({ cwd, platform, arch })
  const readTranscriptCaptureFile = options.readTranscriptCaptureFile ?? readWindowsPsmuxTranscriptChunk
  const buildDashboardCommand = options.buildDashboardProcessCommand ?? buildDefaultDashboardProcessCommand
  const waitForCodexHistoryPoll = options.waitForCodexHistoryPoll ?? defaultWaitForCodexHistoryPoll
  const sharedJobs = new Map<string, WindowsPsmuxState>()
  const sharedSessions = new Map<string, SharedPsmuxSession>()
  let runtimePromise: Promise<Runtime> | undefined
  let managedPsmuxCommand: Promise<string> | undefined
  let nextId = 1
  const ownedSnapshotSessions = new Set<string>()
  const ensureSharedSessionLocks = new Map<string, Promise<SharedPsmuxSession>>()

  async function ensurePsmuxAvailable(): Promise<string> {
    if (platform !== "win32") {
      return "psmux"
    }

    managedPsmuxCommand ??= (options.ensureManagedPsmuxInstalled ?? ensureManagedWindowsPsmuxInstalled)({
      ...options.managedPsmuxInstallOptions,
      cwd,
      platform,
      arch,
    }).then((result) => result.binaryPath)

    try {
      return await managedPsmuxCommand
    } catch {
      throw createMissingWindowsPsmuxError(managedPsmuxPaths.binaryPath)
    }
  }

  return {
    async start(params): Promise<RuntimeJob> {
      const psmuxCommand = await ensurePsmuxAvailable()

      if (params.monitorSessionId) {
        return startSharedSessionJob({
          ...params,
          monitorSessionId: params.monitorSessionId,
        }, psmuxCommand)
      }

      const runtime = await getRuntime()
      return runtime.start(params)
    },
    async read(jobId): Promise<RuntimeReadResult> {
      const state = sharedJobs.get(jobId)
      if (state) {
        return readSharedJobTranscript(state)
      }

      const runtime = await getRuntime()
      return runtime.read(jobId)
    },
    async stop(jobId): Promise<void> {
      const state = sharedJobs.get(jobId)
      if (state) {
        const session = sharedSessions.get(state.sessionId)
        if (session && state.job.status !== "stopped") {
          await runPsmuxCommand(buildWindowsPsmuxKillWindowCommand(session.psmuxCommand, state.sessionId, jobId))
        }

        state.job = { ...state.job, status: "stopped" }
        state.dashboardStatus = "cancelled"
        state.dashboardPhase = "--> cancelled"
        session?.jobIds.delete(jobId)

        if (session) {
          session.dashboard = unregisterWindowsPsmuxDashboardJob(session.dashboard, jobId)
          await renderSharedSessionDashboard(session)
        }

        if (session && session.jobIds.size === 0) {
          await runPsmuxCommand(`${session.psmuxCommand} kill-session -t ${state.sessionId}`)
          sharedSessions.delete(state.sessionId)
        }

        return
      }

      const runtime = await getRuntime()
      return runtime.stop(jobId)
    },
    async snapshot(): Promise<RuntimeSnapshot> {
      await refreshSharedJobStatuses()
      const runtime = await getRuntime()
      const snapshot = await runtime.snapshot()

      return {
        jobs: [...snapshot.jobs, ...[...sharedJobs.values()].map((state) => state.job)],
      }
    },
    async openMonitor(lookup: RuntimeMonitorLookup): Promise<RuntimeMonitor> {
      if (lookup.type === "shared-session") {
        const psmuxCommand = await ensurePsmuxAvailable()
        return openDetachedSharedSessionMonitor(lookup.monitorSessionId, psmuxCommand)
      }

      const jobId = lookup.jobId
      const state = sharedJobs.get(jobId)
      if (state) {
        const session = sharedSessions.get(state.sessionId)
        if (session && !session.opened) {
          await open({
            jobId,
            target: state.job.monitor.attach.target,
            cwd: state.job.monitor.launch.cwd,
            attachCommand: state.job.monitor.attachCommand ?? state.job.monitor.launch.command,
            logTailCommand: state.job.monitor.logTailCommand,
          })
          session.opened = true

          return {
            ...state.job.monitor,
            autoOpenSucceeded: true,
          }
        }

        return {
          ...state.job.monitor,
          autoOpenSucceeded: false,
        }
      }

      try {
        const runtime = await getRuntime()
        return await runtime.openMonitor({ type: "job", jobId })
      } catch (error) {
        if (!isUnknownRuntimeJobError(error)) {
          throw error
        }

        throw error
      }
    },
  }

  async function openDetachedSharedSessionMonitor(sessionId: string, psmuxCommand: string): Promise<RuntimeMonitor> {
    const session = await ensureSharedSession({
      monitorSessionId: sessionId,
      backend: "codex",
      command: `${shell} -NoLogo -NoProfile`,
    }, sessionId, psmuxCommand)

    const monitor: RuntimeMonitor = {
      id: `monitor-${sessionId}`,
      sessionId,
      attach: {
        mode: "pty",
        target: session.target,
        windowIndex: 0,
      },
      window: {
        target: session.target,
        index: 0,
      },
      attachCommand: session.attachCommand,
      launch: {
        command: session.attachCommand,
        cwd,
        outputMode: "native",
      },
    }

    if (!session.opened) {
      await open({
        jobId: sessionId,
        target: monitor.attach.target,
        cwd: monitor.launch.cwd,
        attachCommand: monitor.attachCommand ?? monitor.launch.command,
        logTailCommand: monitor.logTailCommand,
      })
      session.opened = true

      return {
        ...monitor,
        autoOpenSucceeded: true,
      }
    }

    return {
      ...monitor,
      autoOpenSucceeded: false,
    }
  }

  async function startSharedSessionJob(
    params: RuntimeStartParams & { monitorSessionId: string },
    psmuxCommand: string,
  ): Promise<RuntimeJob> {
    const sessionId = params.monitorSessionId
    const jobCwd = params.cwd ?? cwd

    // On the first job for a given session, read the snapshot to ensure nextId
    // doesn't collide with prior jobs (e.g. from before an OpenCode restart).
    // After the first read, this plugin instance owns the snapshot and nextId
    // is kept in sync by incrementing on each new job.
    if (!ownedSnapshotSessions.has(sessionId)) {
      ownedSnapshotSessions.add(sessionId)
      // Synchronous read so concurrent calls can't interleave between
      // checking and bumping nextId.
      try {
        const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(logDirectory, sessionId)
        const raw = readFileSync(snapshotPath, "utf8")
        const prior = JSON.parse(raw) as { jobs?: Array<{ id?: string }> }
        if (Array.isArray(prior.jobs)) {
          for (const job of prior.jobs) {
            const match = typeof job.id === "string" ? job.id.match(/^runtime-(\d+)$/) : undefined
            if (match) {
              nextId = Math.max(nextId, Number(match[1]) + 1)
            }
          }
        }
      } catch {
        // No snapshot yet — nextId stays as-is.
      }
    }

    const id = `runtime-${nextId++}`
    // Serialize session creation per sessionId so concurrent starts don't
    // race to create/discover the same psmux session.
    while (ensureSharedSessionLocks.has(sessionId)) {
      await ensureSharedSessionLocks.get(sessionId)!.catch(() => undefined)
    }
    const sessionPromise = ensureSharedSession(params, id, psmuxCommand)
    ensureSharedSessionLocks.set(sessionId, sessionPromise)
    let sharedSession: SharedPsmuxSession
    try {
      sharedSession = await sessionPromise
    } finally {
      if (ensureSharedSessionLocks.get(sessionId) === sessionPromise) {
        ensureSharedSessionLocks.delete(sessionId)
      }
    }
    const transcriptLogPath = buildWindowsPsmuxTranscriptLogPath(logDirectory, params.monitorSessionId, id)
    const structuredStreamLogPath = requiresStructuredStreamLog(params)
      ? buildWindowsPsmuxStructuredStreamLogPath(logDirectory, params.monitorSessionId, id)
      : undefined
    await writeFile(transcriptLogPath, "", "utf8")
    if (structuredStreamLogPath) {
      await writeFile(structuredStreamLogPath, "", "utf8")
    }
    const launchPlan = await createWindowsPsmuxJobLaunchPlan(
      params,
      id,
      jobCwd,
      runShellCommand,
      runShellQuery,
      options.readCodexHistoryJsonl,
      waitForCodexHistoryPoll,
      options.codexHistoryPollAttempts ?? 120,
      options.codexHistoryPollIntervalMs ?? 250,
      logDirectory,
      transcriptLogPath,
      structuredStreamLogPath,
    )
    const executionWindow = await createWindowsPsmuxJobExecutionTarget(
      params.monitorSessionId,
      id,
      params.command,
      launchPlan,
      params.cwd,
      transcriptLogPath,
      psmuxCommand,
      runPsmuxQuery,
      runPsmuxArgQuery,
      runPsmuxCommand,
    )
    const monitor: RuntimeMonitor = {
      id: `monitor-${params.monitorSessionId}`,
      sessionId: params.monitorSessionId,
      attach: {
        mode: "pty",
        target: sharedSession.target,
        windowIndex: 0,
      },
      window: {
        target: executionWindow.target,
        index: executionWindow.index,
      },
      attachCommand: sharedSession.attachCommand,
      transcriptCaptureTarget: transcriptLogPath,
      structuredStreamCaptureTarget: structuredStreamLogPath,
      launch: {
        command: sharedSession.attachCommand,
        cwd: jobCwd,
        outputMode: launchPlan.outputMode ?? "native",
      },
    }
    const backendSession = await discoverBackendSession(params, id, launchPlan)
    const job: RuntimeJob = {
      id,
      backend: params.backend,
      command: params.command,
      status: "running",
      monitor,
      backendSessionId: backendSession.backendSessionId,
      backendResumeSessionId: backendSession.backendResumeSessionId,
    }

    sharedJobs.set(id, {
      job,
      sessionId: params.monitorSessionId,
      executionTarget: executionWindow.paneTarget,
      executionWindowIndex: executionWindow.index,
      transcriptCaptureTarget: transcriptLogPath,
      transcriptOffset: 0,
      transcriptStatusOffset: 0,
      transcriptMode: launchPlan.transcriptMode,
      structuredStreamCaptureTarget: structuredStreamLogPath,
      structuredStreamOffset: 0,
      streamParser: createWindowsPsmuxStreamParser(launchPlan.streamProtocol),
      dashboardStatus: "running",
    })
    sharedSession.jobIds.add(id)
    sharedSession.dashboard = registerWindowsPsmuxDashboardJob(sharedSession.dashboard, id)
    await renderSharedSessionDashboard(sharedSession)

    return job
  }

  async function ensureSharedSession(
    params: RuntimeStartParams & { monitorSessionId: string },
    jobId: string,
    psmuxCommand: string,
  ): Promise<SharedPsmuxSession> {
    const sessionId = params.monitorSessionId

    // 1. If we have a cached session, reuse it. Only probe the psmux server
    //    when there are no active jobs (the session might have been closed).
    const existing = sharedSessions.get(sessionId)
    if (existing) {
      if (hasActiveSharedJobs(existing.jobIds)) {
        // Jobs are still running — the psmux session must be alive.
        return existing
      }

      const alive = options.hasSharedSession
        ? await options.hasSharedSession(sessionId)
        : await hasWindowsPsmuxSession(sessionId, psmuxCommand, runPsmuxCommand)

      if (alive) {
        // Psmux session still running, no active jobs — reuse it.
        // Check if the attach terminal window is still open via PID file.
        existing.opened = await hasWindowsPsmuxAttachedClient(logDirectory, sessionId)
        return existing
      }

      // Psmux session was killed by the user — drop the stale cache.
      sharedSessions.delete(sessionId)
    }

    // 2. Check if the psmux session exists on the server (e.g. from a prior
    //    plugin instance or after a plugin reload).
    const psmuxSessionExists = options.hasSharedSession
      ? await options.hasSharedSession(sessionId)
      : await hasWindowsPsmuxSession(sessionId, psmuxCommand, runPsmuxCommand)

    const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(logDirectory, sessionId)
    await ensureDashboardProcessScript(logDirectory)
    const dashboardCommand = buildDashboardCommand(snapshotPath)

    // 3. Create a fresh psmux session if none exists.
    const createdFreshSession = !psmuxSessionExists
    if (createdFreshSession) {
      await runPsmuxCommand(`${psmuxCommand} start-server`)
      await runPsmuxCommand(buildWindowsPsmuxNewSessionCommand(psmuxCommand, sessionId, dashboardCommand))
    }

    const sharedSession: SharedPsmuxSession = {
      sessionId,
      psmuxCommand,
      attachCommand: buildWindowsPsmuxAttachCommand(psmuxCommand, sessionId),
      target: `${sessionId}:dashboard`,
      dashboard: createWindowsPsmuxDashboardLayout(sessionId),
      jobIds: new Set<string>(),
      // Check if an attach terminal is still open via PID file. For fresh
      // sessions, no PID file exists → opened = false → auto-open triggers.
      // For reconnections, check if the old terminal is still alive.
      opened: psmuxSessionExists && await hasWindowsPsmuxAttachedClient(logDirectory, sessionId),
      snapshotPath,
    }

    if (!psmuxSessionExists) {
      sharedSession.dashboard = await createWindowsPsmuxDashboard(
        sessionId,
        psmuxCommand,
        shell,
        runPsmuxCommand,
        runPsmuxQuery,
      )
    } else {
      // 4. Psmux session exists but we have no cached state — re-discover the
      //    dashboard layout and respawn the dashboard process in window 0.
      try {
        sharedSession.dashboard = await discoverWindowsPsmuxDashboard(
          sessionId,
          psmuxCommand,
          runPsmuxQuery,
        )
        const dashboardPaneTarget = sharedSession.dashboard.panes.dashboard.target
        await runPsmuxCommand(`${psmuxCommand} respawn-pane -k -t ${dashboardPaneTarget}`)
        await runPsmuxCommand(buildWindowsPsmuxSendTextCommand(
          psmuxCommand,
          dashboardPaneTarget,
          dashboardCommand,
        ))
        await runPsmuxCommand(buildWindowsPsmuxSendKeyCommand(
          psmuxCommand,
          dashboardPaneTarget,
          "Enter",
        ))
      } catch (error) {
        if (!isWindowsPsmuxDashboardContractMismatch(error, sessionId)) {
          throw error
        }

        // Dashboard pane layout is broken (e.g. only 1 pane) — add the
        // missing split in the existing session rather than killing it,
        // so old job windows are preserved.
        sharedSession.dashboard = await createWindowsPsmuxDashboard(
          sessionId,
          psmuxCommand,
          shell,
          runPsmuxCommand,
          runPsmuxQuery,
        )
      }
    }

    // 5. Render the dashboard with all jobs (completed + new).
    await renderSharedSessionDashboard(sharedSession)

    sharedSessions.set(sessionId, sharedSession)
    return sharedSession
  }

  function hasActiveSharedJobs(jobIds: Set<string>): boolean {
    for (const jobId of jobIds) {
      const state = sharedJobs.get(jobId)
      if (state?.job.status === "running") {
        return true
      }
    }

    return false
  }

  async function discoverBackendSession(
    params: RuntimeStartParams,
    jobId: string,
    launchPlan: WindowsPsmuxJobLaunchPlan,
  ): Promise<Pick<RuntimeJob, "backendSessionId" | "backendResumeSessionId">> {
    const launchMetadata = params.launchMetadata
    if (!launchMetadata) {
      return {}
    }

    if (params.backend === "claude-code") {
      const correlation = normalizeClaudeSessionCorrelation({
        jobId,
        sessionId: launchPlan.backendSessionId,
        resumeSessionId: launchPlan.backendResumeSessionId,
      })

      return {
        backendSessionId: correlation.sessionId,
        backendResumeSessionId: correlation.resumeSessionId,
      }
    }

    if (params.backend !== "codex") {
      return {}
    }

    if (launchPlan.outputMode === "stream-json-renderer") {
      return {}
    }

    if (launchPlan.backendSessionId) {
      return {
        backendSessionId: launchPlan.backendSessionId,
        backendResumeSessionId: launchPlan.backendResumeSessionId,
      }
    }

    const discovered = await pollForCodexBackendSession(
      launchMetadata.correlationMarker,
      options.readCodexHistoryJsonl,
      waitForCodexHistoryPoll,
      options.codexHistoryPollAttempts ?? 120,
      options.codexHistoryPollIntervalMs ?? 250,
    )

    return {
      backendSessionId: discovered?.sessionId,
      backendResumeSessionId: discovered?.sessionId,
    }
  }

  async function getRuntime(): Promise<Runtime> {
    runtimePromise ??= loadWindowsPtyRuntime({
      shell,
      platform,
      cwd,
      env,
      open: options.open,
      launchSharedSessionClient: options.launchSharedSessionClient,
    })

    return runtimePromise
  }

  async function refreshSharedJobStatuses(): Promise<void> {
    for (const state of sharedJobs.values()) {
      await updateSharedJobStatus(state)
    }
  }

  async function readSharedJobTranscript(state: WindowsPsmuxState): Promise<RuntimeReadResult> {
    const transcript = await readSharedJobTranscriptDelta(state, "transcript")
    const structuredStatus = await readStructuredStreamStatusDelta(state)
    if (transcript.completed || structuredStatus.completed) {
      await markSharedJobCompleted(state, transcript.exitCode)
    } else if (structuredStatus.changed) {
      const session = sharedSessions.get(state.sessionId)
      if (session) {
        await renderSharedSessionDashboard(session)
      }
    }
    return { data: transcript.output }
  }

  async function updateSharedJobStatus(state: WindowsPsmuxState): Promise<void> {
    const transcript = await readSharedJobTranscriptDelta(state, "status")
    const structuredStatus = await readStructuredStreamStatusDelta(state)
    if (transcript.completed || structuredStatus.completed) {
      await markSharedJobCompleted(state, transcript.exitCode)
      if (structuredStatus.changed) {
        const session = sharedSessions.get(state.sessionId)
        if (session) {
          await renderSharedSessionDashboard(session)
        }
      }
      return
    }

    if (structuredStatus.changed) {
      const session = sharedSessions.get(state.sessionId)
      if (session) {
        await renderSharedSessionDashboard(session)
      }
    }
  }

  async function markSharedJobCompleted(state: WindowsPsmuxState, exitCode?: number): Promise<void> {
    if (state.job.status === "stopped") {
      return
    }

    state.job = { ...state.job, status: "stopped" }
    if (state.dashboardStatus === "running" || state.dashboardStatus === "waiting-approval") {
      if (typeof exitCode === "number" && exitCode !== 0) {
        state.dashboardStatus = "failed"
        state.dashboardPhase = `--> renderer exited with code ${exitCode}`
      } else {
        state.dashboardStatus = "completed"
        state.dashboardPhase ??= "--> completed"
      }
    }

    const session = sharedSessions.get(state.sessionId)
    session?.jobIds.delete(state.job.id)

    if (session) {
      session.dashboard = unregisterWindowsPsmuxDashboardJob(session.dashboard, state.job.id)
      await renderSharedSessionDashboard(session)
    }
  }

  async function renderSharedSessionDashboard(session: SharedPsmuxSession): Promise<void> {
    // In-memory jobs from this plugin instance.
    const inMemoryJobs = [...sharedJobs.values()]
      .filter((state) => state.sessionId === session.sessionId)
      .filter((state): state is WindowsPsmuxState => state !== undefined)
      .map((state) => ({
        id: state.job.id,
        backend: state.job.backend as "codex" | "claude-code",
        windowIndex: state.executionWindowIndex ?? 0,
        status: state.dashboardStatus,
        phase: state.dashboardPhase,
      }))

    // Merge with jobs from the on-disk snapshot (from a previous plugin instance)
    // so that completed jobs from earlier sessions survive a restart.
    const inMemoryIds = new Set(inMemoryJobs.map((j) => j.id))
    let priorJobs: typeof inMemoryJobs = []
    try {
      const raw = await readFile(session.snapshotPath, "utf8")
      const prior = JSON.parse(raw) as { jobs?: typeof inMemoryJobs }
      if (Array.isArray(prior.jobs)) {
        priorJobs = prior.jobs.filter((j) => !inMemoryIds.has(j.id))
      }
    } catch {
      // No prior snapshot or parse error — that's fine.
    }

    const jobs = [...priorJobs, ...inMemoryJobs]

    const snapshot = buildDashboardSnapshot({
      sessionId: session.sessionId,
      jobs,
    })

    await mkdir(join(logDirectory), { recursive: true })
    await writeFile(session.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
  }

  async function readSharedJobTranscriptDelta(
    state: WindowsPsmuxState,
    mode: "transcript" | "status",
  ): Promise<{ output: string; completed: boolean; exitCode?: number }> {
    if (state.transcriptMode === "pane") {
      return readSharedJobPaneDelta(state, mode)
    }

    const offset = mode === "transcript" ? state.transcriptOffset : state.transcriptStatusOffset
    const chunk = await readTranscriptCaptureChunk(readTranscriptCaptureFile, state.transcriptCaptureTarget, offset)

    if (mode === "transcript") {
      state.transcriptOffset = chunk.nextOffset
      state.transcriptStatusOffset = Math.max(state.transcriptStatusOffset, chunk.nextOffset)
    } else {
      state.transcriptStatusOffset = chunk.nextOffset
    }

    const { output, completed, exitCode } = stripWindowsPsmuxExitMarkers(chunk.data)
    return { output, completed, exitCode }
  }

  async function readStructuredStreamStatusDelta(
    state: WindowsPsmuxState,
  ): Promise<{ completed: boolean; changed: boolean }> {
    if (!state.structuredStreamCaptureTarget || !state.streamParser) {
      return { completed: false, changed: false }
    }

    const chunk = await readTranscriptCaptureChunk(
      readTranscriptCaptureFile,
      state.structuredStreamCaptureTarget,
      state.structuredStreamOffset,
    )
    state.structuredStreamOffset = chunk.nextOffset
    const events = state.streamParser.push(chunk.data)
    const changed = applyWindowsPsmuxDashboardEvents(state, events)

    return {
      completed: isTerminalWindowsPsmuxDashboardStatus(state.dashboardStatus),
      changed,
    }
  }

  async function readSharedJobPaneDelta(
    state: WindowsPsmuxState,
    mode: "transcript" | "status",
  ): Promise<{ output: string; completed: boolean; exitCode?: number }> {
    const captured = await runPsmuxQuery(buildWindowsPsmuxCapturePaneCommand(psmuxCommandForState(state), state.executionTarget))
    const normalized = normalizeWindowsPsmuxCapturedPane(captured)
    const offset = mode === "transcript" ? state.transcriptOffset : state.transcriptStatusOffset
    const output = normalized.slice(offset)

    if (mode === "transcript") {
      state.transcriptOffset = normalized.length
      if (output.length > 0) {
        await appendFile(state.transcriptCaptureTarget, output, "utf8")
      }
    }

    state.transcriptStatusOffset = normalized.length

    const dead = await runPsmuxQuery(buildWindowsPsmuxPaneDeadQuery(psmuxCommandForState(state), state.executionTarget))
    return { output, completed: dead.trim() === "1" }
  }

  function psmuxCommandForState(state: WindowsPsmuxState): string {
    return sharedSessions.get(state.sessionId)?.psmuxCommand ?? "psmux"
  }
}

function applyWindowsPsmuxDashboardEvents(
  state: WindowsPsmuxState,
  events: DelegationStreamEvent[],
): boolean {
  let changed = false

  for (const event of events) {
    if (!isWindowsPsmuxLifecycleEvent(event)) {
      continue
    }

    const nextStatus = classifyWindowsPsmuxDashboardStatus(event)
    const nextPhase = `--> ${event.eventType}`
    const shouldReplacePhase = shouldReplaceWindowsPsmuxDashboardPhase(state.dashboardPhase, nextPhase, nextStatus)
    if (state.dashboardStatus !== nextStatus || (shouldReplacePhase && state.dashboardPhase !== nextPhase)) {
      state.dashboardStatus = nextStatus
      if (shouldReplacePhase) {
        state.dashboardPhase = nextPhase
      }
      changed = true
    }
  }

  return changed
}

function shouldReplaceWindowsPsmuxDashboardPhase(
  currentPhase: string | undefined,
  _nextPhase: string,
  nextStatus: WindowsPsmuxState["dashboardStatus"],
): boolean {
  if (!currentPhase) {
    return true
  }

  // Terminal states always replace
  if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" || nextStatus === "waiting-approval") {
    return true
  }

  // While running, always show the latest event so the user sees live progression
  return true
}

function isWindowsPsmuxLifecycleEvent(event: DelegationStreamEvent): boolean {
  const eventType = event.eventType.trim()
  if (!eventType) {
    return false
  }

  return event.kind === "completion"
    || event.kind === "status"
    || event.kind === "message"
    || eventType.toLowerCase().includes("approval")
    || eventType.toLowerCase().includes("fail")
    || eventType.toLowerCase().includes("error")
    || eventType.toLowerCase().includes("cancel")
    || eventType.toLowerCase().includes("abort")
    || eventType.toLowerCase().includes("interrupt")
}

function classifyWindowsPsmuxDashboardStatus(
  event: DelegationStreamEvent,
): WindowsPsmuxState["dashboardStatus"] {
  const eventType = event.eventType.toLowerCase()
  const message = typeof event.raw.message === "string" ? event.raw.message.toLowerCase() : ""

  if (event.kind === "completion") {
    return "completed"
  }

  if (eventType === "result.success") {
    return "completed"
  }

  if (eventType.includes("approval") || message.includes("allow once") || message.includes("allow for this session")) {
    return "waiting-approval"
  }

  if (eventType === "error" || eventType.includes("fail")) {
    return "failed"
  }

  if (eventType.includes("cancel") || eventType.includes("abort") || eventType.includes("interrupt")) {
    return "cancelled"
  }

  return "running"
}

function isTerminalWindowsPsmuxDashboardStatus(
  status: WindowsPsmuxState["dashboardStatus"],
): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "stopped"
}

function isUnknownRuntimeJobError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unknown runtime job:")
}

function buildWindowsPsmuxDashboardControlCenterCommand(
  session: SharedPsmuxSession,
  jobs: WindowsPsmuxState[],
): string {
  const lines = [
    "OMNI-OPENCODE DASHBOARD",
    "",
    `Session: ${session.sessionId}`,
    "Window 0: dashboard",
    "Use Ctrl+b then n/p to cycle windows.",
    "Use Ctrl+b then 0 to return here.",
    "Do not run psmux attach inside this shared session.",
    "",
    "Delegated jobs:",
  ]

  if (jobs.length === 0) {
    lines.push("  none yet")
  } else {
    for (const job of jobs) {
      const marker = session.dashboard.metadata.highlightedJobIds.includes(job.job.id) ? "*" : "-"
      lines.push(`${marker} ${job.job.id} [${job.job.backend}] -> window ${job.executionWindowIndex ?? "?"}`)
    }
  }

  return buildWindowsPsmuxPaneRenderCommand(lines)
}

function buildWindowsPsmuxDashboardHighlightCommand(
  session: SharedPsmuxSession,
  job: WindowsPsmuxState | undefined,
  slot: number,
): string {
  if (!job) {
    return buildWindowsPsmuxPaneRenderCommand([
      `Highlighted Job ${slot}`,
      "",
      "Waiting for delegated job.",
    ])
  }

  return buildWindowsPsmuxPaneRenderCommand([
    `Highlighted Job ${slot}`,
    "",
    `Job: ${job.job.id}`,
    `Backend: ${job.job.backend}`,
    `Window: ${job.executionWindowIndex ?? "?"}`,
    `Target: ${session.sessionId}:${job.executionWindowIndex ?? "?"}`,
    `Attach: Ctrl+b then ${job.executionWindowIndex ?? "?"}`,
  ])
}

function buildWindowsPsmuxPaneRenderCommand(lines: string[]): string {
  return [
    "Clear-Host",
    ...lines.map((line) => `Write-Output '${escapeWindowsPsmuxPowerShellString(line)}'`),
  ].join("; ")
}

async function hasWindowsPsmuxSession(
  sessionId: string,
  psmuxCommand: string,
  runPsmuxCommand: (command: string) => Promise<void> | void,
): Promise<boolean> {
  try {
    await runPsmuxCommand(`${psmuxCommand} has-session -t ${sessionId}`)
    return true
  } catch {
    return false
  }
}

async function createWindowsPsmuxDashboard(
  sessionId: string,
  psmuxCommand: string,
  shell: string,
  runPsmuxCommand: (command: string) => Promise<void> | void,
  runPsmuxQuery: (command: string) => Promise<string> | string,
): Promise<WindowsPsmuxDashboardLayout> {
  const windowTarget = `${sessionId}:dashboard`
  await runPsmuxCommand(buildWindowsPsmuxDashboardShellSplitCommand(psmuxCommand, windowTarget, shell))

  return discoverWindowsPsmuxDashboard(sessionId, psmuxCommand, runPsmuxQuery)
}

async function discoverWindowsPsmuxDashboard(
  sessionId: string,
  psmuxCommand: string,
  runPsmuxQuery: (command: string) => Promise<string> | string,
): Promise<WindowsPsmuxDashboardLayout> {
  return discoverWindowsPsmuxDashboardLayout(
    sessionId,
    await runPsmuxQuery(buildWindowsPsmuxListPanesCommand(psmuxCommand, `${sessionId}:dashboard`)),
  )
}

function isWindowsPsmuxDashboardContractMismatch(error: unknown, sessionId: string): boolean {
  return error instanceof Error
    && error.message.startsWith(`Expected dashboard '${sessionId}:dashboard' `)
}

async function createWindowsPsmuxJobExecutionTarget(
  sessionId: string,
  jobId: string,
  command: string,
  launchPlan: WindowsPsmuxJobLaunchPlan,
  cwd: string | undefined,
  transcriptLogPath: string,
  psmuxCommand: string,
  runPsmuxQuery: (command: string) => Promise<string> | string,
  runPsmuxArgQuery: (command: string, args: string[]) => Promise<string> | string,
  runPsmuxCommand: (command: string) => Promise<void> | void,
): Promise<WindowsPsmuxExecutionWindow> {
  const executionWindows = parseWindowsPsmuxExecutionWindows(
    launchPlan.commandArgs
      ? await runPsmuxArgQuery(psmuxCommand, buildWindowsPsmuxNewWindowJobArgs(sessionId, jobId, launchPlan.commandArgs, cwd))
      : await runPsmuxQuery(buildWindowsPsmuxNewWindowJobCommand(
        psmuxCommand,
        sessionId,
        jobId,
        cwd,
        await writeJobScript(transcriptLogPath, jobId, launchPlan.command ?? command, launchPlan.outputMode),
      )),
  )

  if (executionWindows.length !== 1) {
    throw new Error(`Expected execution window '${sessionId}:job-${jobId}' to report exactly 1 pane, found ${executionWindows.length}`)
  }

  const executionWindow = executionWindows[0]!
  const windowTarget = `${sessionId}:${executionWindow.index}`
  await runPsmuxCommand(`${psmuxCommand} set-option -t ${windowTarget} remain-on-exit on`)
  if (launchPlan.firstPrompt) {
    await runPsmuxCommand(buildWindowsPsmuxSendTextCommand(psmuxCommand, executionWindow.paneTarget, launchPlan.firstPrompt))
  }
  if (launchPlan.submitKey) {
    await runPsmuxCommand(buildWindowsPsmuxSendKeyCommand(psmuxCommand, executionWindow.paneTarget, launchPlan.submitKey))
  }
  return {
    ...executionWindow,
    target: windowTarget,
  }
}

async function createWindowsPsmuxJobLaunchPlan(
  params: RuntimeStartParams,
  jobId: string,
  cwd: string | undefined,
  runShellCommand: (command: string) => Promise<void> | void,
  runShellQuery: (command: string) => Promise<string> | string,
  readCodexHistoryJsonlReader: (() => Promise<string> | string) | undefined,
  waitForCodexHistoryPoll: (delayMs: number) => Promise<void> | void,
  codexHistoryPollAttempts: number,
  codexHistoryPollIntervalMs: number,
  logDirectory: string,
  transcriptLogPath: string,
  structuredStreamLogPath: string | undefined,
): Promise<WindowsPsmuxJobLaunchPlan> {
  const launchMetadata = params.launchMetadata
  if (launchMetadata) {
    const monitorSessionId = params.monitorSessionId ?? "runtime-session"
    const promptText = buildWindowsPsmuxDelegatedPromptText(launchMetadata.prompt, launchMetadata.correlationMarker)
    const rendererScriptPath = await ensureDelegationRendererScript(logDirectory)
    const backendLaunch = await buildWindowsPsmuxStructuredBackendCommand(
      params,
      promptText,
      runShellQuery,
      logDirectory,
      monitorSessionId,
      jobId,
    )
    const resolvedStructuredStreamLogPath = structuredStreamLogPath ?? buildWindowsPsmuxStructuredStreamLogPath(logDirectory, monitorSessionId, jobId)
    return {
      command: buildWindowsPsmuxDelegatedRendererCommand(
        rendererScriptPath,
        params.backend,
        transcriptLogPath,
        resolvedStructuredStreamLogPath,
        backendLaunch,
        formatDelegatedTranscriptPromptHeader(launchMetadata.prompt),
      ),
      transcriptMode: "file",
      outputMode: "stream-json-renderer",
      streamProtocol: params.backend === "codex" ? "codex-json" : "claude-stream-json",
    }
  }

  return {
    transcriptMode: "file",
  }
}

function buildWindowsPsmuxInteractiveCommandArgs(
  params: RuntimeStartParams,
  launchMetadata: RuntimeStartParams["launchMetadata"] & { prompt: string; correlationMarker: string },
): string[] {
  if (params.backend === "codex") {
    return ["codex", buildWindowsPsmuxDelegatedPromptText(launchMetadata.prompt, launchMetadata.correlationMarker)]
  }

  if (params.backend === "claude-code") {
    return ["claude", "--session-id", buildWindowsPsmuxClaudeSessionId()]
  }

  return []
}

function buildWindowsPsmuxDelegatedFirstPrompt(prompt: string, correlationMarker: string, backend: RuntimeStartParams["backend"]): string | undefined {
  return backend === "codex" ? undefined : buildWindowsPsmuxDelegatedPromptText(prompt, correlationMarker)
}

function buildWindowsPsmuxDelegatedPromptText(prompt: string, correlationMarker: string): string {
  return `${prompt} [marker: ${correlationMarker}]`
}

function requiresStructuredStreamLog(params: RuntimeStartParams): boolean {
  return params.launchMetadata !== undefined
}

function createWindowsPsmuxStreamParser(
  protocol: WindowsPsmuxJobLaunchPlan["streamProtocol"],
): CodexStreamParser | ClaudeStreamParser | undefined {
  if (protocol === "codex-json") {
    return new CodexStreamParser()
  }

  if (protocol === "claude-stream-json") {
    return new ClaudeStreamParser()
  }

  return undefined
}

async function buildWindowsPsmuxStructuredBackendCommand(
  params: RuntimeStartParams,
  promptText: string,
  runShellQuery: (command: string) => Promise<string> | string,
  logDirectory: string,
  monitorSessionId: string,
  jobId: string,
): Promise<WindowsPsmuxStructuredBackendLaunch> {
  const backendScriptKey = `${monitorSessionId}-${jobId}`

  if (params.backend === "codex") {
    const codexCommand = await resolveWindowsPsmuxCodexCommand(params, runShellQuery)
    const codexPolicy = params.launchMetadata?.codexPolicy
    const codexConfigPath = codexPolicy
      ? await writeWindowsPsmuxCodexConfig(logDirectory, backendScriptKey, codexPolicy)
      : undefined
    return {
      scriptPath: await writeWindowsPsmuxDelegatedBackendScript(
        logDirectory,
        backendScriptKey,
        buildWindowsPsmuxCodexBackendScript(
          codexCommand,
          promptText,
          codexConfigPath,
        ),
      ),
      rendererNodeCommand: codexCommand.kind === "node-script" ? codexCommand.nodeCommand : undefined,
    }
  }

  const nodeCommand = await resolveWindowsPsmuxExecutable("node", runShellQuery)
  const backendCommand = await resolveWindowsPsmuxBackendExecutable(params, runShellQuery)
  const claudePolicy = params.launchMetadata?.claudePolicy
  return {
    scriptPath: await writeWindowsPsmuxDelegatedBackendScript(
      logDirectory,
      backendScriptKey,
      buildWindowsPsmuxClaudeBackendScript(backendCommand, promptText, claudePolicy),
    ),
    rendererNodeCommand: nodeCommand,
  }
}

async function resolveWindowsPsmuxBackendExecutable(
  params: RuntimeStartParams,
  runShellQuery: (command: string) => Promise<string> | string,
): Promise<string> {
  const configuredCommand = params.commandArgs?.[0] ?? (params.backend === "codex" ? "codex" : "claude")
  return resolveWindowsPsmuxExecutable(configuredCommand, runShellQuery)
}

async function resolveWindowsPsmuxExecutable(
  configuredCommand: string,
  runShellQuery: (command: string) => Promise<string> | string,
): Promise<string> {
  if (isAbsolute(configuredCommand) || configuredCommand.includes("/") || configuredCommand.includes("\\")) {
    return normalizeWindowsPsmuxPath(configuredCommand)
  }

  const resolvedCommand = normalizeWindowsPsmuxPath((await runShellQuery(
    buildWindowsPsmuxResolveExecutableCommand(configuredCommand),
  )).trim())
  if (!resolvedCommand) {
    throw new Error(`Failed to resolve backend executable '${configuredCommand}' for delegated renderer launch`)
  }

  return resolvedCommand
}

async function resolveWindowsPsmuxCodexScriptPath(
  codexCommandPath: string,
  runShellQuery: (command: string) => Promise<string> | string,
): Promise<string> {
  if (codexCommandPath.endsWith(".js")) {
    return normalizeWindowsPsmuxPath(codexCommandPath)
  }

  const resolvedScriptPath = normalizeWindowsPsmuxPath((await runShellQuery(
    buildWindowsPsmuxResolveCodexScriptCommand(codexCommandPath),
  )).trim())

  if (!resolvedScriptPath) {
    throw new Error(`Failed to resolve codex.js from '${codexCommandPath}' for delegated renderer launch`)
  }

  return resolvedScriptPath
}

function buildWindowsPsmuxResolveCodexScriptCommand(codexCommandPath: string): string {
  return [
    `$commandPath = '${escapeWindowsPsmuxPowerShellString(codexCommandPath)}'`,
    "$commandDir = Split-Path $commandPath -Parent",
    "$candidate = Join-Path $commandDir 'node_modules/@openai/codex/bin/codex.js'",
    "if (Test-Path $candidate) { $candidate } else { throw \"Failed to resolve codex.js\" }",
  ].join('; ')
}

function buildWindowsPsmuxResolveExecutableCommand(command: string): string {
  return `(Get-Command '${escapeWindowsPsmuxPowerShellString(command)}' -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)`
}

function buildWindowsPsmuxDelegatedRendererCommand(
  rendererScriptPath: string,
  backend: RuntimeStartParams["backend"],
  transcriptLogPath: string,
  structuredStreamLogPath: string,
  backendLaunch: WindowsPsmuxStructuredBackendLaunch,
  promptHeader?: string,
): string {
  const rendererNodeCommand = backendLaunch.rendererNodeCommand ?? "node"
  const encodedPromptHeader = promptHeader ? Buffer.from(promptHeader, "utf8").toString("base64") : ""
  return `& '${escapeWindowsPsmuxPowerShellString(rendererNodeCommand)}' '${escapeWindowsPsmuxPowerShellString(rendererScriptPath)}' '${backend}' '${escapeWindowsPsmuxPowerShellString(transcriptLogPath)}' '${escapeWindowsPsmuxPowerShellString(structuredStreamLogPath)}' '${escapeWindowsPsmuxPowerShellString(backendLaunch.scriptPath)}' '${escapeWindowsPsmuxPowerShellString(encodedPromptHeader)}'`
}

async function resolveWindowsPsmuxCodexCommand(
  params: RuntimeStartParams,
  runShellQuery: (command: string) => Promise<string> | string,
): Promise<WindowsPsmuxCodexCommand> {
  const codexCommandPath = await resolveWindowsPsmuxExecutable(params.commandArgs?.[0] ?? "codex.cmd", runShellQuery)

  if (codexCommandPath.endsWith(".js")) {
    const nodeCommand = await resolveWindowsPsmuxExecutable("node", runShellQuery)
    return {
      kind: "node-script",
      nodeCommand,
      codexScriptPath: codexCommandPath,
    }
  }

  try {
    const codexScriptPath = await resolveWindowsPsmuxCodexScriptPath(codexCommandPath, runShellQuery)
    const nodeCommand = await resolveWindowsPsmuxExecutable("node", runShellQuery)
    return {
      kind: "node-script",
      nodeCommand,
      codexScriptPath,
    }
  } catch {
    return {
      kind: "direct-executable",
      backendCommand: codexCommandPath,
    }
  }
}

function buildWindowsPsmuxCodexBackendScript(
  command: WindowsPsmuxCodexCommand,
  promptText: string,
  configPath?: string,
): string {
  const invocation = command.kind === "node-script"
    ? `& "${escapeWindowsPsmuxDoubleQuotedString(command.nodeCommand)}" "${escapeWindowsPsmuxDoubleQuotedString(command.codexScriptPath)}"`
    : `& "${escapeWindowsPsmuxDoubleQuotedString(command.backendCommand)}"`

  if (!configPath) {
    return `${invocation} exec --json "${escapeWindowsPsmuxDoubleQuotedString(promptText)}"\n`
  }

  return [
    `$omniCodexPolicy = Get-Content -Raw '${escapeWindowsPsmuxPowerShellString(configPath)}' | ConvertFrom-Json`,
    "$omniCodexArgs = @('exec', '--json')",
    "$omniCodexArgs += '-c'",
    "$omniCodexArgs += ('sandbox_mode=\"' + [string]$omniCodexPolicy.sandboxMode + '\"')",
    "$omniCodexArgs += '-c'",
    "$omniCodexArgs += ('approval_policy=\"' + [string]$omniCodexPolicy.approvalPolicy + '\"')",
    "if ($omniCodexPolicy.sandboxMode -eq 'workspace-write') {",
    "  $omniCodexArgs += '-c'",
    "  $omniCodexArgs += ('sandbox_workspace_write.network_access=' + ($(if ($omniCodexPolicy.networkAccess) { 'true' } else { 'false' })))",
    "  $omniWritableRoots = @($omniCodexPolicy.writableRoots)",
    "  foreach ($omniRoot in $omniWritableRoots) {",
    "    $omniCodexArgs += '--add-dir'",
    "    $omniCodexArgs += [string]$omniRoot",
    "  }",
    "  if ($omniWritableRoots.Count -gt 0) {",
    "    $omniTomlRoots = @($omniWritableRoots | ForEach-Object { '\"' + ([string]$_).Replace('\\', '/') + '\"' }) -join ','",
    "    $omniCodexArgs += '-c'",
    "    $omniCodexArgs += ('sandbox_workspace_write.writable_roots=[' + $omniTomlRoots + ']')",
    "  }",
    "}",
    `$omniCodexArgs += '${escapeWindowsPsmuxPowerShellString(promptText)}'`,
    `${invocation} @omniCodexArgs`,
    "",
  ].join("\n")
}

export function buildWindowsPsmuxClaudeBackendScript(
  backendCommand: string,
  promptText: string,
  policy?: ClaudeCapabilityPolicy,
): string {
  const permissionFlags = [
    policy?.permissionMode
      ? ` --permission-mode ${escapeWindowsPsmuxCliArgument(policy.permissionMode)}`
      : "",
    policy && policy.allowedTools.length > 0
      ? ` --allowedTools ${escapeWindowsPsmuxCliArgument(policy.allowedTools.join(","))}`
      : "",
    policy && policy.disallowedTools.length > 0
      ? ` --disallowedTools ${escapeWindowsPsmuxCliArgument(policy.disallowedTools.join(","))}`
      : "",
  ].join("")

  return `& "${escapeWindowsPsmuxDoubleQuotedString(backendCommand)}" -p "${escapeWindowsPsmuxDoubleQuotedString(promptText)}" --output-format stream-json --verbose --include-partial-messages${permissionFlags}\n`
}

function escapeWindowsPsmuxCliArgument(value: string): string {
  return value.replace(/(["`$])/g, "`$1")
}

function buildWindowsPsmuxCodexBootstrapCommand(promptText: string, cwd?: string): string {
  const workingDirectory = cwd ? ` -WorkingDirectory '${escapeWindowsPsmuxPowerShellString(cwd)}'` : ""
  return `Start-Process -FilePath powershell.exe${workingDirectory} -ArgumentList '-NoExit','-Command','codex ''${escapeWindowsPsmuxPowerShellString(promptText)}'''`
}

function buildWindowsPsmuxInteractiveSubmitKey(backend: RuntimeStartParams["backend"]): string | undefined {
  return backend === "claude-code" ? "Enter" : undefined
}

function buildWindowsPsmuxClaudeSessionId(): string {
  const bytes = createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function pollForCodexBackendSession(
  correlationMarker: string,
  reader: (() => Promise<string> | string) | undefined,
  waitForCodexHistoryPoll: (delayMs: number) => Promise<void> | void,
  attempts: number,
  delayMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const historyJsonl = await readCodexHistoryJsonl(reader)
    const discovered = discoverCodexSessionFromHistory(historyJsonl, correlationMarker)
    if (discovered) {
      return discovered
    }

    if (attempt < attempts - 1) {
      await waitForCodexHistoryPoll(delayMs)
    }
  }

  return undefined
}

async function readCodexHistoryJsonl(
  reader: (() => Promise<string> | string) | undefined,
): Promise<string> {
  if (reader) {
    return await reader()
  }

  try {
    return await readFile(join(homedir(), ".codex", "history.jsonl"), "utf8")
  } catch (error) {
    if (isMissingTranscriptFileError(error)) {
      return ""
    }

    throw error
  }
}

function defaultWaitForCodexHistoryPoll(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function writeJobScript(
  transcriptLogPath: string,
  jobId: string,
  command: string,
  outputMode: WindowsPsmuxJobLaunchPlan["outputMode"] = "native",
): Promise<string> {
  const logDir = dirname(transcriptLogPath)
  await mkdir(logDir, { recursive: true })
  const scriptPath = normalizeWindowsPsmuxPath(join(logDir, `${jobId}.ps1`))
  const escapedTranscriptLogPath = escapeWindowsPsmuxPowerShellString(transcriptLogPath)
  const appendExitMarkerCommand = buildWindowsPsmuxAppendExitMarkerCommand(escapedTranscriptLogPath)
  const script = outputMode === "stream-json-renderer"
    ? `& {\n${command}\n}\n$omniExit = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n${appendExitMarkerCommand}\nexit $omniExit\n`
    : `& {\n${command}\n} 2>&1 | Tee-Object -FilePath '${escapedTranscriptLogPath}'\n$omniExit = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n${appendExitMarkerCommand}\nexit $omniExit\n`
  await writeFile(scriptPath, script, "utf8")
  return scriptPath
}

function buildWindowsPsmuxNewWindowJobCommand(
  psmuxCommand: string,
  sessionId: string,
  jobId: string,
  cwd: string | undefined,
  jobScriptPath: string,
): string {
  const workingDirectory = cwd ? ` -c ${normalizeWindowsPsmuxPath(cwd)}` : ""
  return `${psmuxCommand} new-window -P -F "#{window_index} #{pane_id}" -t ${sessionId} -n job-${jobId}${workingDirectory} -d -- powershell.exe -NoLogo -NoProfile -File "${jobScriptPath}"`
}

function buildWindowsPsmuxNewWindowJobArgs(sessionId: string, jobId: string, commandArgs: string[], cwd: string | undefined): string[] {
  const args = [
    "new-window",
    "-P",
    "-F",
    "#{window_index} #{pane_id}",
    "-t",
    sessionId,
    "-n",
    `job-${jobId}`,
  ]

  if (cwd) {
    args.push("-c", normalizeWindowsPsmuxPath(cwd))
  }

  args.push("-d", "--", ...commandArgs)
  return args
}

function buildWindowsPsmuxTranscriptLogPath(logDirectory: string, sessionId: string, jobId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${sessionId}-${jobId}.log`))
}

function buildWindowsPsmuxSendTextCommand(psmuxCommand: string, target: string, text: string): string {
  return `${psmuxCommand} send-keys -t ${target} '${escapeWindowsPsmuxPowerShellString(text)}'`
}

function buildWindowsPsmuxSendKeyCommand(psmuxCommand: string, target: string, key: string): string {
  return `${psmuxCommand} send-keys -t ${target} ${key}`
}


function buildWindowsPsmuxNewSessionCommand(psmuxCommand: string, sessionId: string, dashboardCommand: string): string {
  return `${psmuxCommand} new-session -d -s ${sessionId} -n dashboard -- ${dashboardCommand}`
}

function buildWindowsPsmuxRespawnDashboardCommand(psmuxCommand: string, paneTarget: string, dashboardCommand: string): string {
  return `${psmuxCommand} respawn-pane -k -t ${paneTarget} -- ${dashboardCommand}`
}

const DASHBOARD_PROCESS_SCRIPT = `const fs = require('fs');
const P = 500;
const S = ['\\u280b','\\u2819','\\u2839','\\u2838','\\u283c','\\u2834','\\u2826','\\u2827','\\u2807','\\u280f'];
const A = {r:'\\x1b[0m',b:'\\x1b[1m',d:'\\x1b[2m',c:'\\x1b[36m',g:'\\x1b[32m',e:'\\x1b[31m',y:'\\x1b[33m',l:'\\x1b[34m',w:'\\x1b[37m',x:'\\x1b[90m',bw:'\\x1b[97m'};
let lv = -1, f = 0, ls = null;
function sm(s, f) {
  if (s === 'running') return A.c + S[f % S.length] + A.r;
  if (s === 'waiting-approval') return A.y + '!' + A.r;
  if (s === 'completed') return A.g + '\\u2713' + A.r;
  if (s === 'failed') return A.e + '\\u2717' + A.r;
  return A.y + '\\u25a0' + A.r;
}
function sc(s) {
  if (s === 'running') return A.w;
  if (s === 'waiting-approval') return A.y;
  if (s === 'completed') return A.g;
  if (s === 'failed') return A.e;
  return A.y;
}
function sep() { return A.x + '\\u2500'.repeat(40) + A.r; }
function render(sn, f) {
  const l = ['', '  ' + A.b + A.c + sn.title + A.r, '  ' + A.x + 'Session: ' + A.w + sn.sessionId + A.r, '', sep()];
  if (!sn.jobs || sn.jobs.length === 0) {
    l.push('', '  ' + A.d + 'No delegated jobs yet. Waiting for work...' + A.r, '');
  } else {
    l.push('', '  ' + A.b + 'Delegated Jobs' + A.r, '');
    for (const j of sn.jobs) {
      const lb = j.label ? ' ' + A.x + '(' + j.label + ')' + A.r : '';
      const ph = j.phase ? ' ' + A.x + j.phase + A.r : '';
      l.push('  ' + sm(j.status, f) + ' ' + sc(j.status) + j.id + A.r + ' ' + A.d + '[' + j.backend + ']' + A.r + ' -> ' + A.b + A.bw + '[window ' + j.windowIndex + ']' + A.r + ph + lb);
    }
    l.push('');
  }
  l.push(sep(), '');
  if (sn.navigation) for (const h of sn.navigation) l.push('  ' + A.x + h + A.r);
  l.push('');
  process.stdout.write('\\x1b[2J\\x1b[H' + l.join('\\n'));
}
function tick() {
  f++;
  try {
    const raw = fs.readFileSync(process.argv[2], 'utf8');
    const sn = JSON.parse(raw);
    ls = sn;
    const hr = sn.jobs && sn.jobs.some(function(j) { return j.status === 'running'; });
    if (sn.version !== lv || hr) { render(sn, f); lv = sn.version; }
  } catch (e) {
    if (ls) { render(ls, f); }
    else { process.stdout.write('\\x1b[2J\\x1b[H\\n  ' + A.d + 'Waiting for dashboard data...' + A.r + '\\n'); }
  }
}
tick();
setInterval(tick, P);
`

const DELEGATION_RENDERER_PROCESS_SCRIPT = `const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const backend = process.argv[2];
const transcriptPath = process.argv[3];
const streamPath = process.argv[4];
const backendScriptPath = process.argv[5];
const promptHeaderBase64 = process.argv[6];
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
fs.mkdirSync(path.dirname(streamPath), { recursive: true });
let buffer = '';
let stderrBuffer = '';
let warnedAboutPlainStructuredOutput = false;
let claudeTextDeltaBuffer = '';
let claudeSawTextDelta = false;
let claudeLastRenderedText = '';
let claudePendingFinalMarker = false;
let wrotePromptHeader = false;
function writePromptHeaderOnce() {
  if (wrotePromptHeader || !promptHeaderBase64) return;
  const promptHeader = Buffer.from(promptHeaderBase64, 'base64').toString('utf8');
  process.stdout.write(promptHeader);
  fs.appendFileSync(transcriptPath, promptHeader, 'utf8');
  wrotePromptHeader = true;
}
function normalize(text) {
  return text.replace(/\\r\\n?/g, '\\n');
}
function formatInline(text) {
  return text.replace(/\`([^\`]+)\`/g, '\\x1b[36m$1\\x1b[0m');
}
function renderMarkdownLikeText(text) {
  const lines = normalize(text).split('\\n');
  const rendered = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith('\`\`\`')) {
      inCodeBlock = !inCodeBlock;
      rendered.push('\\x1b[2m' + line + '\\x1b[0m');
      continue;
    }
    if (inCodeBlock) {
      rendered.push(line);
      continue;
    }
    const heading = line.match(/^#{1,6}\\s+(.*)$/);
    if (heading) {
      rendered.push('\\x1b[1m\\x1b[36m' + formatInline(heading[1]) + '\\x1b[0m');
      continue;
    }
    const bullet = line.match(/^[-*]\\s+(.*)$/);
    if (bullet) {
      rendered.push('  • ' + formatInline(bullet[1]));
      continue;
    }
    const ordered = line.match(/^\\d+\\.\\s+(.*)$/);
    if (ordered) {
      rendered.push('  ' + formatInline(line));
      continue;
    }
    rendered.push(formatInline(line));
  }
  return rendered.join('\\n');
}
function format(text) {
  const normalized = renderMarkdownLikeText(text);
  return normalized.endsWith('\\n') ? normalized : normalized + '\\n';
}
function writeTranscript(text) {
  writePromptHeaderOnce();
  const formatted = format(text);
  process.stdout.write(formatted);
  fs.appendFileSync(transcriptPath, formatted, 'utf8');
}
function writeClaudeTranscriptText(text) {
  if (!text || text === claudeLastRenderedText) return;
  writeTranscript(text);
  claudeLastRenderedText = text;
}
function flushClaudeTextDeltaBuffer() {
  if (!claudeTextDeltaBuffer) return;
  writeClaudeTranscriptText(claudeTextDeltaBuffer);
  claudeTextDeltaBuffer = '';
}
function summarizeClaudeToolEvent(payload, type) {
  if (backend !== 'claude-code') return undefined;
  if (type === 'tool_use') {
    const toolName = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;
    return toolName ? '[claude] tool_use: ' + toolName + '\\n' : '[claude] tool_use\\n';
  }
  if (type === 'tool_result') {
    return payload && payload.is_error === true
      ? '[claude] tool_result: error\\n'
      : '[claude] tool_result: ok\\n';
  }
  const message = payload && typeof payload.message === 'object' && payload.message ? payload.message : undefined;
  const firstContent = message && Array.isArray(message.content) ? message.content[0] : undefined;
  if (type === 'assistant' && firstContent && typeof firstContent === 'object' && firstContent.type === 'tool_use') {
    const toolName = typeof firstContent.name === 'string' && firstContent.name.length > 0 ? firstContent.name : undefined;
    return toolName ? '[claude] tool_use: ' + toolName + '\\n' : '[claude] tool_use\\n';
  }
  if (type === 'user') {
    const content = payload && Array.isArray(payload.content) ? payload.content[0] : undefined;
    if (content && typeof content === 'object' && content.type === 'tool_result') {
      return content.is_error === true
        ? '[claude] tool_result: error\\n'
        : '[claude] tool_result: ok\\n';
    }
  }
  return undefined;
}
function render(record) {
  const payload = record && typeof record.event === 'object' && record.event ? record.event : record;
  const type = typeof payload.type === 'string' ? payload.type : 'status';
  if (backend === 'codex' && type === 'turn.completed' && typeof payload.text !== 'string') return undefined;
  const claudeToolSummary = summarizeClaudeToolEvent(payload, type);
  if (claudeToolSummary) return claudeToolSummary;
  const delta = payload && typeof payload.delta === 'object' && payload.delta ? payload.delta : undefined;
  if (backend === 'claude-code' && type === 'message_start') {
    claudeTextDeltaBuffer = '';
    claudeSawTextDelta = false;
    claudeLastRenderedText = '';
    claudePendingFinalMarker = false;
    return undefined;
  }
  if (backend === 'claude-code' && delta && typeof delta.stop_reason === 'string' && delta.stop_reason === 'end_turn') {
    if (claudeTextDeltaBuffer) {
      flushClaudeTextDeltaBuffer();
      claudeSawTextDelta = false;
      return undefined;
    }
    if (claudeLastRenderedText) {
      claudeSawTextDelta = false;
      return undefined;
    }
    claudePendingFinalMarker = true;
    return undefined;
  }
  const item = payload && typeof payload.item === 'object' && payload.item ? payload.item : undefined;
  const message = payload && typeof payload.message === 'object' && payload.message ? payload.message : undefined;
  const firstContent = message && Array.isArray(message.content) ? message.content[0] : undefined;
  if (backend === 'claude-code' && delta && typeof delta.type === 'string' && delta.type === 'text_delta' && typeof delta.text === 'string') {
    claudeSawTextDelta = true;
    claudeTextDeltaBuffer += delta.text;
    return undefined;
  }
  if (backend === 'claude-code' && claudeSawTextDelta && firstContent && typeof firstContent.text === 'string') {
    return undefined;
  }
  const text = typeof payload.delta === 'string'
    ? payload.delta
    : delta && typeof delta.text === 'string'
      ? delta.text
      : typeof payload.text === 'string'
        ? payload.text
        : typeof payload.result === 'string'
          ? payload.result
        : item && typeof item.text === 'string'
          ? item.text
        : firstContent && typeof firstContent.text === 'string'
          ? firstContent.text
        : undefined;
  if (backend === 'claude-code' && typeof text === 'string' && text.length > 0) {
    if (claudeSawTextDelta || text === claudeTextDeltaBuffer || text === claudeLastRenderedText) {
      return undefined;
    }
    claudeLastRenderedText = text;
    if (claudePendingFinalMarker) {
      claudePendingFinalMarker = false;
      return format(text);
    }
    if (type === 'result' && payload && payload.subtype === 'success') {
      return format(text);
    }
  }
  if (backend === 'claude-code' && type === 'result' && payload && payload.subtype === 'success') {
    claudePendingFinalMarker = false;
    return '[claude] final result\\n';
  }
  if (typeof text === 'string' && text.length > 0) return format(text);
  return undefined;
}
function handleStructuredChunk(chunk) {
  const text = chunk.toString('utf8');
  fs.appendFileSync(streamPath, text, 'utf8');
  buffer += text;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      const rendered = render(record);
      if (!rendered) continue;
      writeTranscript(rendered);
    } catch {
      if (!warnedAboutPlainStructuredOutput) {
        writeTranscript('[renderer] expected structured stream JSON but received plain text; rendering raw output below');
        warnedAboutPlainStructuredOutput = true;
      }
      writeTranscript(trimmed);
    }
  }
}
function flushStructuredRemainder() {
  const trimmed = buffer.trim();
  buffer = '';
  if (!trimmed) return;
  try {
    const record = JSON.parse(trimmed);
    const rendered = render(record);
    if (!rendered) return;
    writeTranscript(rendered);
  } catch {
    if (!warnedAboutPlainStructuredOutput) {
      writeTranscript('[renderer] expected structured stream JSON but received plain text; rendering raw output below');
      warnedAboutPlainStructuredOutput = true;
    }
    writeTranscript(trimmed);
  }
}
function handlePlainTextChunk(chunk) {
  stderrBuffer += chunk.toString('utf8');
  const lines = stderrBuffer.split(/\\r?\\n/);
  stderrBuffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    writeTranscript('[' + backend + '] progress: ' + trimmed);
  }
}
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', handleStructuredChunk);
child.stderr.on('data', (chunk) => handlePlainTextChunk(chunk));
child.on('error', (error) => {
  const message = '[renderer] error: ' + error.message + '\\n';
  process.stdout.write(message);
  fs.appendFileSync(transcriptPath, message, 'utf8');
  process.exit(1);
});
child.on('close', (code) => {
  flushStructuredRemainder();
  if (claudePendingFinalMarker) {
    claudePendingFinalMarker = false;
    writeTranscript('[claude] final result');
  }
  const trailingStderr = stderrBuffer.trim();
  if (trailingStderr) {
    writeTranscript('[' + backend + '] progress: ' + trailingStderr);
  }
  process.exit(typeof code === 'number' ? code : 1);
});
`

async function ensureDashboardProcessScript(logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true })
  const scriptPath = buildWindowsPsmuxDashboardScriptPath(logDir)
  await writeFile(scriptPath, DASHBOARD_PROCESS_SCRIPT, "utf8")
}

async function ensureDelegationRendererScript(logDir: string): Promise<string> {
  await mkdir(logDir, { recursive: true })
  const scriptPath = buildWindowsPsmuxDelegationRendererScriptPath(logDir)
  await writeFile(scriptPath, DELEGATION_RENDERER_PROCESS_SCRIPT, "utf8")
  return scriptPath
}

async function writeWindowsPsmuxDelegatedBackendScript(logDir: string, jobKey: string, content: string): Promise<string> {
  await mkdir(logDir, { recursive: true })
  const scriptPath = normalizeWindowsPsmuxPath(join(logDir, `${jobKey}.backend.ps1`))
  await writeFile(scriptPath, content, "utf8")
  return scriptPath
}

async function writeWindowsPsmuxCodexConfig(
  logDir: string,
  jobKey: string,
  policy: WindowsPsmuxCodexCapabilityPolicy,
): Promise<string> {
  await mkdir(logDir, { recursive: true })
  const configPath = normalizeWindowsPsmuxPath(join(logDir, `${jobKey}.codex-config.json`))
  await writeFile(configPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8")
  return configPath
}

function buildWindowsPsmuxDashboardShellSplitCommand(psmuxCommand: string, target: string, shell: string): string {
  return `${psmuxCommand} split-window -t ${target} -h -p 35 -d -- ${shell} -NoLogo -NoProfile`
}

function buildWindowsPsmuxWrappedCommand(command: string): string {
  const wrappedCommand = `${command}; $omniExit = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }; [Console]::Out.WriteLine("${WINDOWS_PSMUX_EXIT_MARKER}$omniExit"); exit $omniExit`
  return `powershell.exe -NoLogo -NoProfile -Command '${escapeWindowsPsmuxPowerShellString(wrappedCommand)}'`
}

function buildWindowsPsmuxAppendExitMarkerCommand(escapedTranscriptLogPath: string): string {
  return `[System.IO.File]::AppendAllText('${escapedTranscriptLogPath}', "${WINDOWS_PSMUX_EXIT_MARKER}$omniExit\`r\`n", [System.Text.UTF8Encoding]::new($false))`
}

async function readTranscriptCaptureChunk(
  readTranscriptCaptureFile: (
    target: string,
    offset: number,
  ) => Promise<WindowsPsmuxTranscriptChunk> | WindowsPsmuxTranscriptChunk,
  target: string,
  offset: number,
): Promise<WindowsPsmuxTranscriptChunk> {
  try {
    return await readTranscriptCaptureFile(target, offset)
  } catch (error) {
    if (isMissingTranscriptFileError(error)) {
      return { data: "", nextOffset: offset }
    }

    throw error
  }
}

async function readWindowsPsmuxTranscriptChunk(target: string, offset: number): Promise<WindowsPsmuxTranscriptChunk> {
  const content = await readFile(target)
  return {
    data: content.subarray(offset).toString("utf8"),
    nextOffset: content.length,
  }
}

function escapeWindowsPsmuxPowerShellString(value: string): string {
  return value.replace(/'/g, "''")
}

function escapeWindowsPsmuxDoubleQuotedString(value: string): string {
  return value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')
}

function escapeWindowsPsmuxCommandText(value: string): string {
  return value.replace(/"/g, '\\"')
}

function normalizeWindowsPsmuxPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function normalizeWindowsPsmuxCapturedPane(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function stripWindowsPsmuxExitMarkers(value: string): { output: string; completed: boolean; exitCode?: number } {
  let completed = false
  let exitCode: number | undefined
  const lines = value.split(/\r?\n/)
  const output = lines
    .map((line) => {
      const normalizedLine = normalizeWindowsPsmuxExitMarkerLine(line)
      const exitMarkerIndex = normalizedLine.indexOf(WINDOWS_PSMUX_EXIT_MARKER)
      if (exitMarkerIndex !== -1) {
        completed = true
        const parsedExitCode = Number.parseInt(normalizedLine.slice(exitMarkerIndex + WINDOWS_PSMUX_EXIT_MARKER.length), 10)
        if (!Number.isNaN(parsedExitCode)) {
          exitCode = parsedExitCode
        }

        return exitMarkerIndex === 0 ? null : normalizedLine.slice(0, exitMarkerIndex)
      }

      return normalizedLine
    })
    .filter((line): line is string => line !== null)
    .join("\n")

  return { output, completed, exitCode }
}

function normalizeWindowsPsmuxExitMarkerLine(value: string): string {
  return value.replace(/\0/g, "")
}

function isMissingTranscriptFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function parseWindowsPsmuxPaneGeometries(value: string): WindowsPsmuxPaneGeometry[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [target, index, left, top, width, height] = line.split(/\s+/)
      if (!target || !index || !left || !top || !width || !height) {
        throw new Error(`Invalid psmux pane geometry: '${line}'`)
      }

      const indexValue = Number.parseInt(index, 10)
      const leftValue = Number.parseInt(left, 10)
      const topValue = Number.parseInt(top, 10)
      const widthValue = Number.parseInt(width, 10)
      const heightValue = Number.parseInt(height, 10)

      if ([indexValue, leftValue, topValue, widthValue, heightValue].some((number) => Number.isNaN(number))) {
        throw new Error(`Invalid psmux pane geometry: '${line}'`)
      }

      return {
        target,
        index: indexValue,
        left: leftValue,
        top: topValue,
        width: widthValue,
        height: heightValue,
      }
    })
}

function parseWindowsPsmuxExecutionWindows(value: string): Array<{ paneTarget: string; index: number }> {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [index, paneTarget] = line.split(/\s+/)
      if (!index || !paneTarget) {
        throw new Error(`Invalid psmux execution window: '${line}'`)
      }

      const parsedIndex = Number.parseInt(index, 10)
      if (Number.isNaN(parsedIndex)) {
        throw new Error(`Invalid psmux execution window: '${line}'`)
      }

      return {
        index: parsedIndex,
        paneTarget,
      }
    })
}

function buildWindowsPsmuxListPanesCommand(psmuxCommand: string, target: string): string {
  return `${psmuxCommand} list-panes -t ${target} -F "#{pane_id} #{pane_index} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"`
}


function buildWindowsPsmuxAttachCommand(psmuxCommand: string, sessionId: string): string {
  return `${psmuxCommand} attach -t ${sessionId}`
}

function buildWindowsPsmuxCapturePaneCommand(psmuxCommand: string, target: string): string {
  return `${psmuxCommand} capture-pane -t ${target} -p`
}

function buildWindowsPsmuxPaneDeadQuery(psmuxCommand: string, target: string): string {
  return `${psmuxCommand} list-panes -t ${target} -F "#{pane_dead}"`
}

function buildWindowsPsmuxKillWindowCommand(psmuxCommand: string, sessionId: string, jobId: string): string {
  return `${psmuxCommand} kill-window -t ${sessionId}:job-${jobId}`
}

function runWindowsPsmuxShellCommand(
  command: string,
  options: {
    shell: string
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(options.shell, ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""

    child.stdout?.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve()
        return
      }

      const details = output.trim()
      reject(new Error(details ? `psmux command failed: ${command}\n${details}` : `psmux command failed: ${command}`))
    })
  })
}

function runWindowsPsmuxShellQuery(
  command: string,
  options: {
    shell: string
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(options.shell, ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim())
        return
      }

      const details = `${stdout}${stderr}`.trim()
      reject(new Error(details ? `psmux command failed: ${command}\n${details}` : `psmux command failed: ${command}`))
    })
  })
}

function runWindowsPsmuxArgQuery(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim())
        return
      }

      const details = `${stdout}${stderr}`.trim()
      const rendered = [command, ...args].join(" ")
      reject(new Error(details ? `psmux command failed: ${rendered}\n${details}` : `psmux command failed: ${rendered}`))
    })
  })
}

function openWindowsPsmuxMonitor(params: {
  jobId: string
  target: string
  cwd?: string
  attachCommand: string
  logTailCommand?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const logDir = join(params.cwd ?? process.cwd(), ".omni-monitors")
    const sessionId = params.target.split(":")[0] ?? params.jobId
    const pidPath = buildWindowsPsmuxAttachPidPath(logDir, sessionId)
    // Launch via Start-Process -PassThru so we get the PID of the terminal
    // window, then write it to a file for later liveness checks.
    const startCmd = buildWindowsPsmuxAutoOpenPassThruCommand(params.attachCommand, params.cwd, pidPath)
    const child = spawnProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", startCmd], {
      cwd: params.cwd,
      windowsHide: true,
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("spawn", () => resolve())
  })
}

function buildWindowsPsmuxAutoOpenPassThruCommand(attachCommand: string, cwd: string | undefined, pidPath: string): string {
  const workingDirectory = cwd ? ` -WorkingDirectory '${escapeWindowsPsmuxPowerShellString(cwd)}'` : ""
  return `$p = Start-Process -PassThru -FilePath powershell.exe${workingDirectory} -ArgumentList '-NoExit','-Command','${escapeWindowsPsmuxPowerShellString(attachCommand)}'; Set-Content -Path '${escapeWindowsPsmuxPowerShellString(pidPath)}' -Value $p.Id`
}

function buildWindowsPsmuxAttachPidPath(logDirectory: string, sessionId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${sessionId}-attach.pid`))
}

async function hasWindowsPsmuxAttachedClient(logDirectory: string, sessionId: string): Promise<boolean> {
  try {
    const pidPath = buildWindowsPsmuxAttachPidPath(logDirectory, sessionId)
    const raw = await readFile(pidPath, "utf8")
    const pid = parseInt(raw.trim(), 10)
    if (isNaN(pid)) return false
    // Check if the process is still alive (signal 0 = existence check)
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function buildWindowsPsmuxAutoOpenCommand(attachCommand: string, cwd?: string): string {
  const workingDirectory = cwd ? ` -WorkingDirectory '${escapeWindowsPsmuxPowerShellString(cwd)}'` : ""
  return `Start-Process -FilePath powershell.exe${workingDirectory} -ArgumentList '-NoExit','-Command','${escapeWindowsPsmuxPowerShellString(attachCommand)}'`
}


export function buildWindowsPsmuxDashboardSnapshotPath(logDirectory: string, sessionId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${sessionId}-dashboard.json`))
}

export function buildWindowsPsmuxDashboardScriptPath(logDirectory: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, "dashboard-process.cjs"))
}

export function buildWindowsPsmuxDelegationRendererScriptPath(logDirectory: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, "delegation-renderer.cjs"))
}

export function buildWindowsPsmuxStructuredStreamLogPath(logDirectory: string, sessionId: string, jobId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${sessionId}-${jobId}.stream.jsonl`))
}

function buildDefaultDashboardProcessCommand(snapshotPath: string): string {
  const scriptDir = snapshotPath.replace(/\/[^/]+$/, "")
  const scriptPath = normalizeWindowsPsmuxPath(join(scriptDir, "dashboard-process.cjs"))
  return `node "${scriptPath}" "${snapshotPath}"`
}

async function loadWindowsPtyRuntime(options: WindowsPtyRuntimeOptions): Promise<Runtime> {
  const { createWindowsPtyRuntime } = await import("./windows-pty.js")
  return createWindowsPtyRuntime(options)
}
