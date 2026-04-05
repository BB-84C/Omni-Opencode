import type {
  Runtime,
  RuntimeJob,
  RuntimeMonitor,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartParams,
} from "./types.js"

export function createFakeRuntime(): Runtime {
  const jobs = new Map<string, RuntimeJob>()
  let nextId = 1

  return {
    async start(params: RuntimeStartParams): Promise<RuntimeJob> {
      const id = `runtime-${nextId++}`
      const job: RuntimeJob = {
        id,
        backend: params.backend,
        command: params.command,
        status: "running",
        monitor: {
          id: `monitor-${id}`,
          attach: {
            mode: "pty",
            target: `monitor-${id}`,
          },
          launch: {
            command: params.command,
          },
        },
      }

      jobs.set(id, job)
      return job
    },

    async read(jobId: string): Promise<RuntimeReadResult> {
      getJob(jobs, jobId)
      return { data: "" }
    },

    async stop(jobId: string): Promise<void> {
      const job = getJob(jobs, jobId)
      jobs.set(jobId, { ...job, status: "stopped" })
    },

    async snapshot(): Promise<RuntimeSnapshot> {
      return { jobs: [...jobs.values()] }
    },

    async openMonitor(jobId: string): Promise<RuntimeMonitor> {
      const job = getJob(jobs, jobId)
      return job.monitor
    },
  }
}

function getJob(jobs: Map<string, RuntimeJob>, jobId: string): RuntimeJob {
  const job = jobs.get(jobId)

  if (!job) {
    throw new Error(`Unknown runtime job: ${jobId}`)
  }

  return job
}
