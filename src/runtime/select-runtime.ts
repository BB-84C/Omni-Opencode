import { createTmuxRuntime, type TmuxRuntimeOptions } from "./tmux-runtime.js"
import { createWindowsPsmuxRuntime, type WindowsPsmuxRuntimeOptions } from "./windows-psmux.js"
import { createWindowsPtyRuntime, type WindowsPtyRuntimeOptions } from "./windows-pty.js"
import type { PrimaryRuntimeKind, Runtime, RuntimeMonitor, RuntimeJob, RuntimeMonitorLookup, RuntimeStartParams } from "./types.js"

export type RuntimeSelectionKind = PrimaryRuntimeKind

export type SelectedRuntime = {
  kind: RuntimeSelectionKind
  runtime: Runtime
  autoOpenMonitor: boolean
  start(params: RuntimeStartParams): Promise<{ job: RuntimeJob; monitor?: RuntimeMonitor }>
}

export type SelectRuntimeOptions = {
  platform?: NodeJS.Platform
  autoOpenMonitor?: boolean
  windowsPsmuxRuntime?: WindowsPsmuxRuntimeOptions
  windowsRuntime?: WindowsPtyRuntimeOptions
  tmuxRuntime?: TmuxRuntimeOptions
  createWindowsPsmuxRuntime?: () => Runtime
  createWindowsRuntime?: () => Runtime
  createTmuxRuntime?: () => Runtime
}

export function selectRuntime(options: SelectRuntimeOptions = {}): SelectedRuntime {
  const platform = options.platform ?? process.platform
  const autoOpenMonitor = options.autoOpenMonitor ?? true
  const kind = platform === "win32" ? "windows-psmux" : "tmux"
  const runtime = kind === "windows-psmux" ? createPrimaryWindowsRuntime(options) : createTmuxSelectedRuntime(options)

  return {
    kind,
    runtime,
    autoOpenMonitor,
    async start(params: RuntimeStartParams): Promise<{ job: RuntimeJob; monitor?: RuntimeMonitor }> {
      const job = await runtime.start(params)
      const monitor = autoOpenMonitor ? await openSelectedRuntimeMonitor(kind, runtime, job, params) : undefined
      return { job, monitor }
    },
  }
}

async function openSelectedRuntimeMonitor(
  kind: RuntimeSelectionKind,
  runtime: Runtime,
  job: RuntimeJob,
  params: RuntimeStartParams,
): Promise<RuntimeMonitor | undefined> {
  const lookup: RuntimeMonitorLookup = kind === "windows-psmux" && params.monitorSessionId
    ? { type: "shared-session", monitorSessionId: params.monitorSessionId }
    : { type: "job", jobId: job.id }
  try {
    return await runtime.openMonitor(lookup)
  } catch (error) {
    if (!shouldIgnoreAutoOpenMonitorFailure(kind, params)) {
      throw error
    }

    return undefined
  }
}

function shouldIgnoreAutoOpenMonitorFailure(kind: RuntimeSelectionKind, params: RuntimeStartParams): boolean {
  return kind === "windows-psmux" && typeof params.monitorSessionId === "string"
}

function createPrimaryWindowsRuntime(options: SelectRuntimeOptions): Runtime {
  if (options.createWindowsPsmuxRuntime) {
    return options.createWindowsPsmuxRuntime()
  }

  if (options.createWindowsRuntime) {
    return options.createWindowsRuntime()
  }

  return createWindowsPsmuxRuntime(options.windowsPsmuxRuntime ?? options.windowsRuntime)
}

export function createArchivedWindowsRuntime(options: SelectRuntimeOptions): Runtime {
  return options.createWindowsRuntime?.() ?? createWindowsPtyRuntime(options.windowsRuntime)
}

function createTmuxSelectedRuntime(options: SelectRuntimeOptions): Runtime {
  if (options.createTmuxRuntime) {
    return options.createTmuxRuntime()
  }

  if (!options.tmuxRuntime) {
    throw new Error("Tmux runtime requires injected factory or runtime options")
  }

  return createTmuxRuntime(options.tmuxRuntime)
}
