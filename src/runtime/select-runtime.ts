import { createTmuxRuntime, type TmuxRuntimeOptions } from "./tmux-runtime.js"
import { createWindowsPtyRuntime, type WindowsPtyRuntimeOptions } from "./windows-pty.js"
import type { Runtime, RuntimeMonitor, RuntimeJob, RuntimeStartParams } from "./types.js"

export type RuntimeSelectionKind = "windows-pty" | "tmux"

export type SelectedRuntime = {
  kind: RuntimeSelectionKind
  runtime: Runtime
  autoOpenMonitor: boolean
  start(params: RuntimeStartParams): Promise<{ job: RuntimeJob; monitor?: RuntimeMonitor }>
}

export type SelectRuntimeOptions = {
  platform?: NodeJS.Platform
  autoOpenMonitor?: boolean
  windowsRuntime?: WindowsPtyRuntimeOptions
  tmuxRuntime?: TmuxRuntimeOptions
  createWindowsRuntime?: () => Runtime
  createTmuxRuntime?: () => Runtime
}

export function selectRuntime(options: SelectRuntimeOptions = {}): SelectedRuntime {
  const platform = options.platform ?? process.platform
  const autoOpenMonitor = options.autoOpenMonitor ?? true
  const kind = platform === "win32" ? "windows-pty" : "tmux"
  const runtime = kind === "windows-pty" ? createWindowsRuntime(options) : createTmuxSelectedRuntime(options)

  return {
    kind,
    runtime,
    autoOpenMonitor,
    async start(params: RuntimeStartParams): Promise<{ job: RuntimeJob; monitor?: RuntimeMonitor }> {
      const job = await runtime.start(params)
      const monitor = autoOpenMonitor ? await runtime.openMonitor(job.id) : undefined
      return { job, monitor }
    },
  }
}

function createWindowsRuntime(options: SelectRuntimeOptions): Runtime {
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
