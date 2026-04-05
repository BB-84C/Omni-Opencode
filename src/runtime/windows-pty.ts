import { spawn as spawnPty } from "node-pty"
import type {
  Runtime,
  RuntimeJob,
  RuntimeMonitor,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartParams,
} from "./types.js"

export type WindowsPtyClient = {
  pid: number
  kill(): void
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
}

export type WindowsPtySpawnOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  name?: string
}

export type WindowsPtySpawn = (
  file: string,
  args: string[],
  options: WindowsPtySpawnOptions,
) => WindowsPtyClient

export type WindowsPtyRuntimeOptions = {
  shell?: string
  platform?: NodeJS.Platform
  cwd?: string
  env?: NodeJS.ProcessEnv
  spawn?: WindowsPtySpawn
}

type WindowsPtyState = {
  client: WindowsPtyClient
  job: RuntimeJob
  transcript: string
}

export function createWindowsPtyRuntime(options: WindowsPtyRuntimeOptions = {}): Runtime {
  const platform = options.platform ?? process.platform

  if (platform !== "win32") {
    throw new Error("Windows PTY runtime requires win32")
  }

  const jobs = new Map<string, WindowsPtyState>()
  const shell = options.shell ?? "powershell.exe"
  const cwd = options.cwd
  const env = options.env
  const spawn = options.spawn ?? spawnWindowsPty
  let nextId = 1

  return {
    async start(params: RuntimeStartParams): Promise<RuntimeJob> {
      const id = `runtime-${nextId++}`
      const monitor: RuntimeMonitor = {
        id: `monitor-${id}`,
        attach: {
          mode: "pty",
          target: `monitor-${id}`,
        },
        launch: {
          command: params.command,
          cwd,
        },
      }
      const client = spawn(shell, ["-NoLogo", "-NoProfile", "-Command", params.command], {
        cwd,
        env,
        name: "xterm-color",
      })
      const job: RuntimeJob = {
        id,
        backend: params.backend,
        command: params.command,
        status: "running",
        monitor,
      }
      const state: WindowsPtyState = {
        client,
        job,
        transcript: "",
      }

      client.onData((chunk) => {
        state.transcript += chunk
      })

      client.onExit(() => {
        state.job = { ...state.job, status: "stopped" }
      })

      jobs.set(id, state)
      return job
    },

    async read(jobId: string): Promise<RuntimeReadResult> {
      const state = getState(jobs, jobId)
      const data = state.transcript
      state.transcript = ""
      return { data }
    },

    async stop(jobId: string): Promise<void> {
      const state = getState(jobs, jobId)
      state.client.kill()
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

function spawnWindowsPty(
  file: string,
  args: string[],
  options: WindowsPtySpawnOptions,
): WindowsPtyClient {
  return spawnPty(file, args, options)
}

function getState(jobs: Map<string, WindowsPtyState>, jobId: string): WindowsPtyState {
  const state = jobs.get(jobId)

  if (!state) {
    throw new Error(`Unknown runtime job: ${jobId}`)
  }

  return state
}
