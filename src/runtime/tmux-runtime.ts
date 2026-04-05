import type {
  Runtime,
  RuntimeJob,
  RuntimeMonitor,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartParams,
} from "./types.js"

export type TmuxBackend = {
  createSession(params: { sessionName: string; command: string; cwd?: string }): void | Promise<void>
  readOutput(
    sessionName: string,
    cursor: string | undefined,
  ): { data: string; cursor?: string; active: boolean } | Promise<{ data: string; cursor?: string; active: boolean }>
  killSession(sessionName: string): void | Promise<void>
}

export type TmuxRuntimeOptions = {
  backend: TmuxBackend
  cwd?: string
  platform?: NodeJS.Platform
  sessionPrefix?: string
}

type TmuxRuntimeState = {
  sessionName: string
  cursor?: string
  job: RuntimeJob
}

export function createTmuxRuntime(options: TmuxRuntimeOptions): Runtime {
  const platform = options.platform ?? process.platform

  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("Tmux runtime requires linux or darwin")
  }

  const jobs = new Map<string, TmuxRuntimeState>()
  const cwd = options.cwd
  const sessionPrefix = options.sessionPrefix ?? "omni"
  let nextId = 1

  return {
    async start(params: RuntimeStartParams): Promise<RuntimeJob> {
      const id = `runtime-${nextId++}`
      const sessionName = `${sessionPrefix}-${params.backend}-${nextId - 1}`
      const monitor: RuntimeMonitor = {
        id: sessionName,
        attach: {
          mode: "tmux",
          target: sessionName,
        },
        launch: {
          command: params.command,
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

      await options.backend.createSession({
        sessionName,
        command: params.command,
        cwd,
      })

      jobs.set(id, {
        sessionName,
        job,
      })

      return job
    },

    async read(jobId: string): Promise<RuntimeReadResult> {
      const state = getState(jobs, jobId)
      const result = await options.backend.readOutput(state.sessionName, state.cursor)
      state.cursor = result.cursor

      if (!result.active) {
        state.job = { ...state.job, status: "stopped" }
      }

      return { data: result.data }
    },

    async stop(jobId: string): Promise<void> {
      const state = getState(jobs, jobId)
      await options.backend.killSession(state.sessionName)
      state.job = { ...state.job, status: "stopped" }
    },

    async snapshot(): Promise<RuntimeSnapshot> {
      return {
        jobs: [...jobs.values()].map((state) => state.job),
      }
    },

    async openMonitor(jobId: string): Promise<RuntimeMonitor> {
      return getState(jobs, jobId).job.monitor
    },
  }
}

function getState(jobs: Map<string, TmuxRuntimeState>, jobId: string): TmuxRuntimeState {
  const state = jobs.get(jobId)

  if (!state) {
    throw new Error(`Unknown runtime job: ${jobId}`)
  }

  return state
}
