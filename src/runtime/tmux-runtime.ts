import type {
  Runtime,
  RuntimeJob,
  RuntimeMonitor,
  RuntimeMonitorLookup,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartParams,
} from "./types.js"

export type TmuxBackend = {
  createSession(params: { sessionName: string; command: string; cwd?: string }): { targetId: string } | Promise<{ targetId: string }>
  joinSession(params: { sessionName: string; command: string; cwd?: string }): { targetId: string } | Promise<{ targetId: string }>
  readOutput(
    targetId: string,
    cursor: string | undefined,
  ): { data: string; cursor?: string; active: boolean } | Promise<{ data: string; cursor?: string; active: boolean }>
  killTarget(targetId: string): void | Promise<void>
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
  targetId: string
  cursor?: string
  job: RuntimeJob
}

type SharedTmuxSession = {
  jobIds: Set<string>
}

export function createTmuxRuntime(options: TmuxRuntimeOptions): Runtime {
  const platform = options.platform ?? process.platform

  if (platform !== "linux" && platform !== "darwin") {
    throw new Error("Tmux runtime requires linux or darwin")
  }

  const jobs = new Map<string, TmuxRuntimeState>()
  const sharedSessions = new Map<string, SharedTmuxSession>()
  const cwd = options.cwd
  const sessionPrefix = options.sessionPrefix ?? "omni"
  let nextId = 1

  return {
    async start(params: RuntimeStartParams): Promise<RuntimeJob> {
      const id = `runtime-${nextId++}`
      const sessionName = params.monitorSessionId
        ? `${sessionPrefix}-${params.monitorSessionId}`
        : `${sessionPrefix}-${params.backend}-${nextId - 1}`
      const monitor: RuntimeMonitor = {
        id: sessionName,
        sessionId: params.monitorSessionId,
        attach: {
          mode: "tmux",
          target: sessionName,
        },
        attachCommand: `tmux attach -t ${sessionName}`,
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

      const sharedSession = sharedSessions.get(sessionName)
      const target = sharedSession
        ? await options.backend.joinSession({
            sessionName,
            command: params.command,
            cwd,
          })
        : await options.backend.createSession({
            sessionName,
            command: params.command,
            cwd,
          })

      if (sharedSession) {
        sharedSession.jobIds.add(id)
      } else {
        sharedSessions.set(sessionName, { jobIds: new Set([id]) })
      }

      jobs.set(id, {
        sessionName,
        targetId: target.targetId,
        job,
      })

      return job
    },

    async read(jobId: string): Promise<RuntimeReadResult> {
      const state = getState(jobs, jobId)
      const result = await options.backend.readOutput(state.targetId, state.cursor)
      state.cursor = result.cursor

      if (!result.active) {
        state.job = { ...state.job, status: "stopped" }
        releaseSessionJob(sharedSessions, state.sessionName, jobId)
      }

      return { data: result.data }
    },

    async stop(jobId: string): Promise<void> {
      const state = getState(jobs, jobId)
      await options.backend.killTarget(state.targetId)

      if (releaseSessionJob(sharedSessions, state.sessionName, jobId)) {
        await options.backend.killSession(state.sessionName)
      }

      state.job = { ...state.job, status: "stopped" }
    },

    async snapshot(): Promise<RuntimeSnapshot> {
      return {
        jobs: [...jobs.values()].map((state) => state.job),
      }
    },

    async openMonitor(lookup: RuntimeMonitorLookup): Promise<RuntimeMonitor> {
      if (lookup.type !== "job") {
        throw new Error(`Unknown runtime job: ${lookup.monitorSessionId}`)
      }

      return getState(jobs, lookup.jobId).job.monitor
    },
  }
}

function releaseSessionJob(
  sharedSessions: Map<string, SharedTmuxSession>,
  sessionName: string,
  jobId: string,
): boolean {
  const sharedSession = sharedSessions.get(sessionName)

  if (!sharedSession) {
    return false
  }

  sharedSession.jobIds.delete(jobId)

  if (sharedSession.jobIds.size > 0) {
    return false
  }

  sharedSessions.delete(sessionName)
  return true
}

function getState(jobs: Map<string, TmuxRuntimeState>, jobId: string): TmuxRuntimeState {
  const state = jobs.get(jobId)

  if (!state) {
    throw new Error(`Unknown runtime job: ${jobId}`)
  }

  return state
}
