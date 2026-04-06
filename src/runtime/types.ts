export type RuntimeBackend = "claude-code" | "codex"

export type RuntimeStartParams = {
  backend: RuntimeBackend
  command: string
}

export type RuntimeLaunchMetadata = {
  command: string
  cwd?: string
}

export type RuntimeAttachMetadata = {
  mode: "pty" | "tmux"
  target: string
}

export type RuntimeMonitor = {
  id: string
  attach: RuntimeAttachMetadata
  launch: RuntimeLaunchMetadata
  attachCommand?: string
  logTailCommand?: string
}

export type RuntimeJob = {
  id: string
  backend: RuntimeBackend
  command: string
  status: "running" | "stopped"
  monitor: RuntimeMonitor
}

export type RuntimeReadResult = {
  data: string
}

export type RuntimeSnapshot = {
  jobs: RuntimeJob[]
}

export interface Runtime {
  start(params: RuntimeStartParams): Promise<RuntimeJob>
  read(jobId: string): Promise<RuntimeReadResult>
  stop(jobId: string): Promise<void>
  snapshot(): Promise<RuntimeSnapshot>
  openMonitor(jobId: string): Promise<RuntimeMonitor>
}
