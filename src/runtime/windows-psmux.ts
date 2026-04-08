import { mkdir, readFile, writeFile } from "node:fs/promises"
import { spawn as spawnProcess } from "node:child_process"
import type { EnsureManagedWindowsPsmuxInstalledOptions } from "./windows-psmux-managed.js"
import type { WindowsPtyClient, WindowsPtyRuntimeOptions } from "./windows-pty.js"
import type { Runtime, RuntimeJob, RuntimeMonitor, RuntimeMonitorLookup, RuntimeReadResult, RuntimeSnapshot, RuntimeStartParams } from "./types.js"
import {
  WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
  WINDOWS_PSMUX_INSTALL_DOCS_URL,
  createWindowsPsmuxBootstrapReport,
  detectWindowsPsmux,
} from "./windows-psmux-shared.js"
import { join } from "node:path"
import { ensureManagedWindowsPsmuxInstalled, resolveManagedWindowsPsmuxPaths } from "./windows-psmux-managed.js"
import { buildDashboardSnapshot } from "./windows-dashboard-snapshot.js"

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
  runShellCommand?: (command: string) => Promise<void> | void
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
}

type WindowsPsmuxState = {
  job: RuntimeJob
  sessionId: string
  executionTarget: string
  executionWindowIndex?: number
  transcriptCaptureTarget: string
  transcriptOffset: number
  transcriptStatusOffset: number
}

type WindowsPsmuxExecutionWindow = {
  target: string
  paneTarget: string
  index: number
}

type WindowsPsmuxTranscriptChunk = {
  data: string
  nextOffset: number
}

const WINDOWS_PSMUX_EXIT_MARKER = "__OMNI_OPENCODE_PSMUX_EXIT__:"

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
  if (panes.length !== 2) {
    throw new Error(`Expected dashboard '${sessionId}:dashboard' to have exactly 2 panes, found ${panes.length}`)
  }

  const [firstPane, secondPane] = [...panes].sort((left, right) => left.index - right.index)
  const hasHorizontalSplit = firstPane?.index === 0
    && secondPane?.index === 1
    && firstPane.left === 0
    && firstPane.top === secondPane.top
    && firstPane.height === secondPane.height
    && firstPane.left < secondPane.left
  if (!hasHorizontalSplit) {
    throw new Error(`Expected dashboard '${sessionId}:dashboard' to use a left/right split in window 0`)
  }

  const dashboardPane = panes.reduce((best, pane) => {
    if (!best) {
      return pane
    }

    if (pane.left !== best.left) {
      return pane.left < best.left ? pane : best
    }

    return pane.width > best.width ? pane : best
  })
  const shellPane = panes.find((pane) => pane.target !== dashboardPane.target)
  if (!shellPane) {
    throw new Error(`Expected dashboard '${sessionId}:dashboard' to have a shell pane`)
  }

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
  const runPsmuxCommand = options.runPsmuxCommand ?? runShellCommand
  const runPsmuxQuery = options.runPsmuxQuery ?? ((command: string) => runWindowsPsmuxShellQuery(command, { shell, cwd, env }))
  const open = options.open ?? openWindowsPsmuxMonitor
  const logDirectory = join(cwd ?? process.cwd(), ".omni-monitors")
  const managedPsmuxPaths = resolveManagedWindowsPsmuxPaths({ cwd, platform, arch })
  const readTranscriptCaptureFile = options.readTranscriptCaptureFile ?? readWindowsPsmuxTranscriptChunk
  const buildDashboardCommand = options.buildDashboardProcessCommand ?? buildDefaultDashboardProcessCommand
  const sharedJobs = new Map<string, WindowsPsmuxState>()
  const sharedSessions = new Map<string, SharedPsmuxSession>()
  let runtimePromise: Promise<Runtime> | undefined
  let managedPsmuxCommand: Promise<string> | undefined
  let nextId = 1

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
    const id = `runtime-${nextId++}`
    const sharedSession = await ensureSharedSession(params, id, psmuxCommand)
    const transcriptLogPath = buildWindowsPsmuxTranscriptLogPath(logDirectory, id)
    const executionWindow = await createWindowsPsmuxJobExecutionTarget(
      params.monitorSessionId,
      id,
      params.command,
      psmuxCommand,
      runPsmuxQuery,
    )
    await configureWindowsPsmuxPipePaneBookkeeping(logDirectory, executionWindow.paneTarget, transcriptLogPath, psmuxCommand, runPsmuxCommand)
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
      launch: {
        command: sharedSession.attachCommand,
        cwd,
      },
    }
    const job: RuntimeJob = {
      id,
      backend: params.backend,
      command: params.command,
      status: "running",
      monitor,
    }

    sharedJobs.set(id, {
      job,
      sessionId: params.monitorSessionId,
      executionTarget: executionWindow.paneTarget,
      executionWindowIndex: executionWindow.index,
      transcriptCaptureTarget: transcriptLogPath,
      transcriptOffset: 0,
      transcriptStatusOffset: 0,
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
    const existing = sharedSessions.get(params.monitorSessionId)
    if (existing) {
      if (hasActiveSharedJobs(existing.jobIds)) {
        return existing
      }

      const sharedSessionExists = options.hasSharedSession
        ? await options.hasSharedSession(params.monitorSessionId)
        : await hasWindowsPsmuxSession(params.monitorSessionId, psmuxCommand, runPsmuxCommand)

      if (sharedSessionExists) {
        return existing
      }

      sharedSessions.delete(params.monitorSessionId)
    }

    const sharedSessionExists = options.hasSharedSession
      ? await options.hasSharedSession(params.monitorSessionId)
      : await hasWindowsPsmuxSession(params.monitorSessionId, psmuxCommand, runPsmuxCommand)

    const snapshotPath = buildWindowsPsmuxDashboardSnapshotPath(logDirectory, params.monitorSessionId)
    const dashboardCommand = buildDashboardCommand(snapshotPath)

    if (!sharedSessionExists) {
      await runPsmuxCommand(`${psmuxCommand} start-server`)
      await runPsmuxCommand(buildWindowsPsmuxNewSessionCommand(psmuxCommand, params.monitorSessionId, dashboardCommand))
    }

    const sharedSession: SharedPsmuxSession = {
      sessionId: params.monitorSessionId,
      psmuxCommand,
      attachCommand: buildWindowsPsmuxAttachCommand(psmuxCommand, params.monitorSessionId),
      target: `${params.monitorSessionId}:dashboard`,
      dashboard: createWindowsPsmuxDashboardLayout(params.monitorSessionId),
      jobIds: new Set<string>(),
      opened: false,
      snapshotPath,
    }

    if (!sharedSessionExists) {
      sharedSession.dashboard = await createWindowsPsmuxDashboard(
        params.monitorSessionId,
        psmuxCommand,
        shell,
        runPsmuxCommand,
        runPsmuxQuery,
      )
    } else {
      try {
        sharedSession.dashboard = await discoverWindowsPsmuxDashboard(
          params.monitorSessionId,
          psmuxCommand,
          runPsmuxQuery,
        )
        await runPsmuxCommand(buildWindowsPsmuxRespawnDashboardCommand(
          psmuxCommand,
          sharedSession.dashboard.panes.dashboard.target,
          dashboardCommand,
        ))
      } catch (error) {
        if (!isWindowsPsmuxDashboardContractMismatch(error, params.monitorSessionId)) {
          throw error
        }

        await runPsmuxCommand(`${psmuxCommand} kill-session -t ${params.monitorSessionId}`)
        await runPsmuxCommand(`${psmuxCommand} start-server`)
        await runPsmuxCommand(buildWindowsPsmuxNewSessionCommand(psmuxCommand, params.monitorSessionId, dashboardCommand))
        sharedSession.dashboard = await createWindowsPsmuxDashboard(
          params.monitorSessionId,
          psmuxCommand,
          shell,
          runPsmuxCommand,
          runPsmuxQuery,
        )
      }
    }

    await renderSharedSessionDashboard(sharedSession)

    sharedSessions.set(params.monitorSessionId, sharedSession)
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
      await updateSharedJobStatusFromTranscript(state)
    }
  }

  async function readSharedJobTranscript(state: WindowsPsmuxState): Promise<RuntimeReadResult> {
    const transcript = await readSharedJobTranscriptDelta(state, "transcript")
    if (transcript.completed) {
      markSharedJobCompleted(state)
    }
    return { data: transcript.output }
  }

  async function updateSharedJobStatusFromTranscript(state: WindowsPsmuxState): Promise<void> {
    const transcript = await readSharedJobTranscriptDelta(state, "status")
    if (transcript.completed) {
      markSharedJobCompleted(state)
    }
  }

  function markSharedJobCompleted(state: WindowsPsmuxState): void {
    if (state.job.status === "stopped") {
      return
    }

    state.job = { ...state.job, status: "stopped" }

    const session = sharedSessions.get(state.sessionId)
    session?.jobIds.delete(state.job.id)

    if (session) {
      session.dashboard = unregisterWindowsPsmuxDashboardJob(session.dashboard, state.job.id)
      void renderSharedSessionDashboard(session)
    }
  }

  async function renderSharedSessionDashboard(session: SharedPsmuxSession): Promise<void> {
    const jobs = [...session.jobIds]
      .map((jobId) => sharedJobs.get(jobId))
      .filter((state): state is WindowsPsmuxState => state !== undefined)
      .map((state) => ({
        id: state.job.id,
        backend: state.job.backend as "codex" | "claude-code",
        windowIndex: state.executionWindowIndex ?? 0,
        status: state.job.status === "stopped" ? "stopped" as const : "running" as const,
      }))

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
  ): Promise<{ output: string; completed: boolean }> {
    const offset = mode === "transcript" ? state.transcriptOffset : state.transcriptStatusOffset
    const chunk = await readTranscriptCaptureChunk(readTranscriptCaptureFile, state.transcriptCaptureTarget, offset)

    if (mode === "transcript") {
      state.transcriptOffset = chunk.nextOffset
      state.transcriptStatusOffset = Math.max(state.transcriptStatusOffset, chunk.nextOffset)
    } else {
      state.transcriptStatusOffset = chunk.nextOffset
    }

    const { output, completed } = stripWindowsPsmuxExitMarkers(chunk.data)
    return { output, completed }
  }
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
  psmuxCommand: string,
  runPsmuxQuery: (command: string) => Promise<string> | string,
): Promise<WindowsPsmuxExecutionWindow> {
  const executionWindows = parseWindowsPsmuxExecutionWindows(
    await runPsmuxQuery(buildWindowsPsmuxNewWindowCaptureCommand(psmuxCommand, sessionId, jobId, command)),
  )

  if (executionWindows.length !== 1) {
    throw new Error(`Expected execution window '${sessionId}:job-${jobId}' to report exactly 1 pane, found ${executionWindows.length}`)
  }

  const executionWindow = executionWindows[0]!
  return {
    ...executionWindow,
    target: `${sessionId}:${executionWindow.index}`,
  }
}

function buildWindowsPsmuxTranscriptLogPath(logDirectory: string, jobId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${jobId}.log`))
}

async function configureWindowsPsmuxPipePaneBookkeeping(
  logDirectory: string,
  target: string,
  transcriptLogPath: string,
  psmuxCommand: string,
  runPsmuxCommand: (command: string) => Promise<void> | void,
): Promise<void> {
  await mkdir(logDirectory, { recursive: true })
  await runPsmuxCommand(buildWindowsPsmuxPipePaneCommand(psmuxCommand, target, transcriptLogPath))
}

function buildWindowsPsmuxPipePaneCommand(psmuxCommand: string, target: string, transcriptLogPath: string): string {
  return `${psmuxCommand} pipe-pane -t ${target} -o -- 'Out-File -FilePath \"${transcriptLogPath}\" -Append -Encoding utf8'`
}

function buildWindowsPsmuxSendKeysCommand(psmuxCommand: string, target: string, text: string): string {
  return `${psmuxCommand} send-keys -t ${target} '${escapeWindowsPsmuxPowerShellString(text)}' Enter`
}

function buildWindowsPsmuxNewSessionCommand(psmuxCommand: string, sessionId: string, dashboardCommand: string): string {
  return `${psmuxCommand} new-session -d -s ${sessionId} -n dashboard -- ${dashboardCommand}`
}

function buildWindowsPsmuxRespawnDashboardCommand(psmuxCommand: string, paneTarget: string, dashboardCommand: string): string {
  return `${psmuxCommand} respawn-pane -k -t ${paneTarget} -- ${dashboardCommand}`
}

function buildWindowsPsmuxDashboardShellSplitCommand(psmuxCommand: string, target: string, shell: string): string {
  return `${psmuxCommand} split-window -t ${target} -h -p 35 -d -- ${shell} -NoLogo -NoProfile`
}

function buildWindowsPsmuxWrappedCommand(command: string): string {
  const wrappedCommand = `${command}; $omniExit = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }; Write-Output "${WINDOWS_PSMUX_EXIT_MARKER}$omniExit"; exit $omniExit`
  return `powershell.exe -NoLogo -NoProfile -Command '${escapeWindowsPsmuxPowerShellString(wrappedCommand)}'`
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

function normalizeWindowsPsmuxPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function stripWindowsPsmuxExitMarkers(value: string): { output: string; completed: boolean } {
  let completed = false
  const lines = value.split(/\r?\n/)
  const output = lines
    .filter((line) => {
      const isExitMarker = line.startsWith(WINDOWS_PSMUX_EXIT_MARKER)
      completed ||= isExitMarker
      return !isExitMarker
    })
    .join("\n")

  return { output, completed }
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

function buildWindowsPsmuxNewWindowCaptureCommand(
  psmuxCommand: string,
  sessionId: string,
  jobId: string,
  command: string,
): string {
  return `${psmuxCommand} new-window -P -F "#{window_index} #{pane_id}" -t ${sessionId} -n job-${jobId} -d -- ${buildWindowsPsmuxWrappedCommand(command)}`
}

function buildWindowsPsmuxAttachCommand(psmuxCommand: string, sessionId: string): string {
  return `${psmuxCommand} attach -t ${sessionId}`
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

function openWindowsPsmuxMonitor(params: {
  jobId: string
  target: string
  cwd?: string
  attachCommand: string
  logTailCommand?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = buildWindowsPsmuxAutoOpenCommand(params.attachCommand, params.cwd)
    const child = spawnProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd: params.cwd,
      windowsHide: true,
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("spawn", () => resolve())
  })
}

function buildWindowsPsmuxAutoOpenCommand(attachCommand: string, cwd?: string): string {
  const workingDirectory = cwd ? ` -WorkingDirectory '${escapeWindowsPsmuxPowerShellString(cwd)}'` : ""
  return `Start-Process -FilePath powershell.exe${workingDirectory} -ArgumentList '-NoExit','-Command','${escapeWindowsPsmuxPowerShellString(attachCommand)}'`
}


export function buildWindowsPsmuxDashboardSnapshotPath(logDirectory: string, sessionId: string): string {
  return normalizeWindowsPsmuxPath(join(logDirectory, `${sessionId}-dashboard.json`))
}

function buildDefaultDashboardProcessCommand(snapshotPath: string): string {
  return `node -e "const fs=require('fs');const P=500;const S=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];const A={r:'\\x1b[0m',b:'\\x1b[1m',d:'\\x1b[2m',c:'\\x1b[36m',g:'\\x1b[32m',e:'\\x1b[31m',y:'\\x1b[33m',l:'\\x1b[34m',w:'\\x1b[37m',x:'\\x1b[90m'};let lv=-1,f=0,ls=null;function sm(s,f){if(s==='running')return A.c+S[f%S.length]+A.r;if(s==='completed')return A.g+'✓'+A.r;if(s==='failed')return A.e+'✗'+A.r;return A.y+'■'+A.r}function sc(s){if(s==='running')return A.w;if(s==='completed')return A.g;if(s==='failed')return A.e;return A.y}function sep(){return A.x+'─'.repeat(40)+A.r}function render(sn,f){const l=['','  '+A.b+A.c+sn.title+A.r,'  '+A.x+'Session: '+A.w+sn.sessionId+A.r,'',sep()];if(!sn.jobs||sn.jobs.length===0){l.push('','  '+A.d+'No delegated jobs yet. Waiting for work...'+A.r,'')}else{l.push('','  '+A.b+'Delegated Jobs'+A.r,'');for(const j of sn.jobs){const lb=j.label?' '+A.x+'('+j.label+')'+A.r:'';l.push('  '+sm(j.status,f)+' '+sc(j.status)+j.id+A.r+' '+A.d+'['+j.backend+']'+A.r+' -> '+A.l+'window '+j.windowIndex+A.r+lb)}l.push('')}l.push(sep(),'');if(sn.navigation)for(const h of sn.navigation)l.push('  '+A.x+h+A.r);l.push('');process.stdout.write('\\x1b[2J\\x1b[H'+l.join('\\n'))}function tick(){f++;try{const raw=fs.readFileSync('${snapshotPath.replace(/'/g, "\\'")}','utf8');const sn=JSON.parse(raw);ls=sn;const hr=sn.jobs&&sn.jobs.some(j=>j.status==='running');if(sn.version!==lv||hr){render(sn,f);lv=sn.version}}catch(e){if(ls){render(ls,f)}else{process.stdout.write('\\x1b[2J\\x1b[H\\n  '+A.d+'Waiting for dashboard data...'+A.r+'\\n')}}}tick();setInterval(tick,P)"`
}

async function loadWindowsPtyRuntime(options: WindowsPtyRuntimeOptions): Promise<Runtime> {
  const { createWindowsPtyRuntime } = await import("./windows-pty.js")
  return createWindowsPtyRuntime(options)
}
