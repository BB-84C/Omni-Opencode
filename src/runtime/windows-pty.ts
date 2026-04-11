import * as nodePty from "node-pty"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { spawn as spawnProcess, type ChildProcess } from "node:child_process"
import {
  appendWindowsMultiplexerCommand,
  ensureWindowsMultiplexerSessionArtifacts,
  hasLiveWindowsMultiplexerOwner,
  resolveWindowsMultiplexerEventPath,
  resolveWindowsMultiplexerSessionDirectory,
} from "./windows-multiplexer.js"
import type {
  Runtime,
  RuntimeJob,
  RuntimeMonitor,
  RuntimeMonitorLookup,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartParams,
} from "./types.js"

// Archived node-pty path retained for explicit fallback coverage only.
export const WINDOWS_PTY_RUNTIME_ARCHIVE_NOTICE = "archived node-pty Windows runtime fallback only"

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
  launchHelper?: (params: {
    shell: string
    command: string
    cwd?: string
    env?: NodeJS.ProcessEnv
    backend: RuntimeStartParams["backend"]
    jobId: string
  }) => Promise<WindowsPtyClient> | WindowsPtyClient
  logDirectory?: string
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
    initialOffset?: number
  }) => Promise<WindowsPtyClient> | WindowsPtyClient
  readSharedEventBaseline?: (eventPath: string) => Promise<number> | number
}

export function resolveNodePtySpawn(
  module: unknown,
  fallbackLoader?: () => unknown,
): WindowsPtySpawn {
  const candidate = module as {
    spawn?: WindowsPtySpawn
    default?: { spawn?: WindowsPtySpawn }
  }

  const fallback = fallbackLoader?.() as
    | { spawn?: WindowsPtySpawn; default?: { spawn?: WindowsPtySpawn } }
    | undefined

  const resolved = candidate.spawn ?? candidate.default?.spawn ?? fallback?.spawn ?? fallback?.default?.spawn
  if (typeof resolved !== "function") {
    throw new Error("node-pty spawn export is unavailable")
  }

  return resolved
}

export async function resolveNodePtySpawnAsync(
  module: unknown,
  fallbackLoader?: () => Promise<unknown>,
): Promise<WindowsPtySpawn> {
  try {
    return resolveNodePtySpawn(module)
  } catch {
    if (!fallbackLoader) {
      throw new Error("node-pty spawn export is unavailable")
    }
  }

  return resolveNodePtySpawn(await fallbackLoader())
}

export function resolveNodeHelperExecutable(execPath = process.execPath): string {
  const normalized = execPath.toLowerCase()
  if (normalized.includes("opencode") || normalized.endsWith("bun.exe") || normalized.endsWith("bun")) {
    return "node"
  }

  return execPath
}

export function buildWindowsMonitorCommand(logPath: string): string {
  const nodeExecutable = buildWindowsNodeExecutable(resolveNodeHelperExecutable())
  const monitorScript = quoteWindowsCommandArg(resolveWindowsRuntimeScriptPath("windows-monitor.js"))
  const target = quoteWindowsCommandArg(logPath)

  return `${nodeExecutable} ${monitorScript} ${target}`
}

export function buildWindowsMultiplexerAttachCommand(sessionId: string): string {
  const nodeExecutable = buildWindowsNodeExecutable(resolveNodeHelperExecutable())
  const multiplexerScript = quoteWindowsCommandArg(resolveWindowsRuntimeScriptPath("windows-multiplexer.js"))
  const session = quoteWindowsCommandArg(sessionId)

  return `${nodeExecutable} ${multiplexerScript} attach --session ${session}`
}

export function buildWindowsAutoOpenCommand(params: { attachCommand: string; cwd?: string; statePath?: string }): string {
  const args = [`'-NoExit'`, `'-Command'`, `'${escapePowerShellSingleQuotedString(params.attachCommand)}'`].join(",")
  const workingDirectory = params.cwd
    ? ` -WorkingDirectory '${escapePowerShellSingleQuotedString(params.cwd)}'`
    : ""
  const stateCapture = params.statePath
    ? `; $launch = @{ pid = $process.Id; command = '${escapePowerShellSingleQuotedString(params.attachCommand)}' } | ConvertTo-Json -Compress; Set-Content -Path '${escapePowerShellSingleQuotedString(params.statePath)}' -Value $launch`
    : ""

  return `$ErrorActionPreference = 'Stop'; try { $process = Start-Process -FilePath powershell.exe${workingDirectory} -ArgumentList ${args} -PassThru${stateCapture} } catch { ${params.statePath ? `Set-Content -Path '${escapePowerShellSingleQuotedString(params.statePath)}' -Value (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress); ` : ""}throw }`
}

type WindowsPtyState = {
  client: WindowsPtyClient
  job: RuntimeJob
  transcript: string
  logPath: string
  sharedSessionId?: string
}

type SharedWindowsMonitor = {
  target: string
  attachCommand: string
  jobIds: Set<string>
  opened: boolean
}

export function createWindowsPtyRuntime(options: WindowsPtyRuntimeOptions = {}): Runtime {
  const platform = options.platform ?? process.platform

  if (platform !== "win32") {
    throw new Error("Windows PTY runtime requires win32")
  }

  const jobs = new Map<string, WindowsPtyState>()
  const sharedMonitors = new Map<string, SharedWindowsMonitor>()
  const shell = options.shell ?? "powershell.exe"
  const cwd = options.cwd
  const env = options.env
  const launchHelper = options.launchHelper ?? launchWindowsPtyHelper
  const launchSharedSessionClient = options.launchSharedSessionClient ?? launchSharedWindowsPtyClient
  const logDirectory = options.logDirectory ?? join(cwd ?? process.cwd(), ".omni-monitors")
  const open = options.open ?? openWindowsMonitor
  const readSharedEventBaseline = options.readSharedEventBaseline ?? readWindowsSharedEventBaseline
  let nextId = 1

  return {
    async start(params: RuntimeStartParams): Promise<RuntimeJob> {
      const id = `runtime-${nextId++}`
      const jobCwd = params.cwd ?? cwd
      await mkdir(logDirectory, { recursive: true })
      const sharedSessionId = params.monitorSessionId
      const sharedMonitor = sharedSessionId ? await ensureSharedWindowsMonitor(sharedMonitors, logDirectory, sharedSessionId) : undefined
      const logPath = join(logDirectory, `${id}.log`)
      await writeFile(logPath, "", "utf-8")

      const attachCommand = sharedMonitor?.attachCommand ?? buildWindowsMonitorCommand(logPath)
      const logTailCommand = sharedMonitor ? undefined : `Get-Content -Path \"${logPath}\" -Wait`
      const monitorCwd = sharedSessionId ? resolveWindowsRuntimeWorkspaceRoot() : jobCwd
      const monitor: RuntimeMonitor = {
        id: sharedSessionId ? `monitor-${sharedSessionId}` : `monitor-${id}`,
        sessionId: sharedSessionId,
        attach: {
          mode: "pty",
            target: sharedMonitor?.target ?? logPath,
          },
        attachCommand,
        logTailCommand,
        launch: {
          command: attachCommand,
          cwd: monitorCwd,
        },
      }
      const client = sharedSessionId
        ? await launchSharedSessionClient({
            sessionId: sharedSessionId,
            jobId: id,
            backend: params.backend,
            shell,
            command: params.command,
            cwd: jobCwd,
            env,
            logDirectory,
            initialOffset: await readSharedEventBaseline(resolveWindowsMultiplexerEventPath(logDirectory, sharedSessionId)),
          })
        : options.spawn
          ? options.spawn(shell, ["-NoLogo", "-NoProfile", "-Command", params.command], {
              cwd: jobCwd,
              env,
              name: "xterm-color",
            })
          : await launchHelper({
              shell,
              command: params.command,
              cwd: jobCwd,
              env,
              backend: params.backend,
              jobId: id,
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
        logPath,
        sharedSessionId,
      }

      client.onData((chunk) => {
        state.transcript += chunk
        void appendFile(state.logPath, chunk, "utf-8")
      })

      client.onExit(() => {
        state.job = { ...state.job, status: "stopped" }
      })

      jobs.set(id, state)

      if (sharedMonitor) {
        sharedMonitor.jobIds.add(id)
      }

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
      await releaseSharedMonitorJob(sharedMonitors, logDirectory, state.sharedSessionId, jobId)
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

      const jobId = lookup.jobId
      const state = getState(jobs, jobId)
      const monitor = state.job.monitor
      const sharedMonitor = state.sharedSessionId ? sharedMonitors.get(state.sharedSessionId) : undefined
      const sharedHostAlive = state.sharedSessionId
        ? await hasLiveWindowsMultiplexerOwner(logDirectory, state.sharedSessionId)
        : false

      if (!sharedMonitor?.opened || !sharedHostAlive) {
        await open({
          jobId,
          target: monitor.attach.target,
          cwd: monitor.launch.cwd,
          attachCommand: monitor.attachCommand ?? monitor.launch.command,
          logTailCommand: monitor.logTailCommand,
        })

        if (sharedMonitor) {
          sharedMonitor.opened = true
        }
      }

      return monitor
    },
  }
}

async function ensureSharedWindowsMonitor(
  sharedMonitors: Map<string, SharedWindowsMonitor>,
  logDirectory: string,
  sessionId: string,
): Promise<SharedWindowsMonitor> {
  const existing = sharedMonitors.get(sessionId)
  if (existing) {
    return existing
  }

  await ensureWindowsMultiplexerSessionArtifacts(logDirectory, sessionId)
  const target = resolveWindowsMultiplexerSessionDirectory(logDirectory, sessionId)

  const sharedMonitor: SharedWindowsMonitor = {
    target,
    attachCommand: buildWindowsMultiplexerAttachCommand(sessionId),
    jobIds: new Set<string>(),
    opened: false,
  }

  sharedMonitors.set(sessionId, sharedMonitor)
  return sharedMonitor
}

function launchWindowsPtyHelper(params: {
  shell: string
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  backend: RuntimeStartParams["backend"]
  jobId: string
}): WindowsPtyClient {
  const payload = Buffer.from(JSON.stringify(params), "utf-8").toString("base64")
  const helperScript = [
    "const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));",
    "const pty = require('node-pty');",
    "const child = pty.spawn(payload.shell, ['-NoLogo','-NoProfile','-Command', payload.command], { cwd: payload.cwd, env: payload.env, name: 'xterm-color' });",
    "child.onData((chunk) => process.stdout.write(chunk));",
    "child.onExit((event) => process.exit(event.exitCode ?? 0));",
    "process.on('SIGTERM', () => { try { child.kill(); } finally { process.exit(0); } });",
  ].join(" ")

  const child = spawnProcess(resolveNodeHelperExecutable(), ["-e", helperScript, payload], {
    cwd: params.cwd,
    env: params.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  return wrapHelperProcess(child)
}

async function launchSharedWindowsPtyClient(params: {
  sessionId: string
  jobId: string
  backend: RuntimeStartParams["backend"]
  shell: string
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  logDirectory: string
  initialOffset?: number
}): Promise<WindowsPtyClient> {
  await appendWindowsMultiplexerCommand(params.logDirectory, {
    type: "start",
    sessionId: params.sessionId,
    jobId: params.jobId,
    backend: params.backend,
    shell: params.shell,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
  })

  return createSharedWindowsPtyClient(params)
}

async function readWindowsSharedEventBaseline(eventPath: string): Promise<number> {
  try {
    const info = await statFile(eventPath)
    return info.size
  } catch {
    return 0
  }
}

function getWindowsMultiplexerCompleteRecordLength(buffer: Buffer): number {
  const lastNewline = Math.max(buffer.lastIndexOf(0x0a), buffer.lastIndexOf(0x0d))
  return lastNewline < 0 ? 0 : lastNewline + 1
}

function wrapHelperProcess(child: ChildProcess): WindowsPtyClient {
  let dataListener: ((chunk: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined

  child.stdout?.on("data", (chunk) => dataListener?.(String(chunk)))
  child.stderr?.on("data", (chunk) => dataListener?.(String(chunk)))
  child.on("exit", (exitCode) => exitListener?.({ exitCode: exitCode ?? 0 }))

  return {
    pid: child.pid ?? -1,
    kill() {
      child.kill()
    },
    onData(listener) {
      dataListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
  }
}

function createSharedWindowsPtyClient(params: {
  sessionId: string
  jobId: string
  logDirectory: string
  initialOffset?: number
}): WindowsPtyClient {
  let dataListener: ((chunk: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined
  let offset = params.initialOffset ?? 0
  let closed = false
  const eventPath = resolveWindowsMultiplexerEventPath(params.logDirectory, params.sessionId)
  const timer = setInterval(() => {
    void pumpSharedWindowsPtyEvents()
  }, 50)

  timer.unref()

  async function pumpSharedWindowsPtyEvents(): Promise<void> {
    if (closed) {
      return
    }

    let info
    try {
      info = await statFile(eventPath)
    } catch {
      return
    }

    if (info.size <= offset) {
      return
    }

    const handle = await openFile(eventPath)

    try {
      const length = info.size - offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const completeLength = getWindowsMultiplexerCompleteRecordLength(buffer)

      if (completeLength <= 0) {
        return
      }

      const completeContent = buffer.subarray(0, completeLength).toString("utf-8")
      offset += completeLength

      for (const line of completeContent.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }

        let event: { type: string; jobId: string; chunk?: string; exitCode?: number }
        try {
          event = JSON.parse(trimmed) as { type: string; jobId: string; chunk?: string; exitCode?: number }
        } catch {
          continue
        }

        if (event.jobId !== params.jobId) {
          continue
        }

        if (event.type === "data") {
          dataListener?.(event.chunk ?? "")
          continue
        }

        if (event.type === "exit") {
          closed = true
          clearInterval(timer)
          exitListener?.({ exitCode: event.exitCode ?? 0 })
        }
      }
    } finally {
      await handle.close()
    }
  }

  return {
    pid: -1,
    kill() {
      void appendWindowsMultiplexerCommand(params.logDirectory, {
        type: "stop",
        sessionId: params.sessionId,
        jobId: params.jobId,
      })
    },
    onData(listener) {
      dataListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
  }
}

function getState(jobs: Map<string, WindowsPtyState>, jobId: string): WindowsPtyState {
  const state = jobs.get(jobId)

  if (!state) {
    throw new Error(`Unknown runtime job: ${jobId}`)
  }

  return state
}

async function releaseSharedMonitorJob(
  sharedMonitors: Map<string, SharedWindowsMonitor>,
  logDirectory: string,
  sessionId: string | undefined,
  jobId: string,
): Promise<void> {
  if (!sessionId) {
    return
  }

  const sharedMonitor = sharedMonitors.get(sessionId)
  if (!sharedMonitor) {
    return
  }

  sharedMonitor.jobIds.delete(jobId)
  const sharedHostAlive = await hasLiveWindowsMultiplexerOwner(logDirectory, sessionId)

  if (sharedMonitor.jobIds.size === 0 && !sharedHostAlive) {
    sharedMonitors.delete(sessionId)
  }
}

export async function openWindowsMonitor(params: {
  jobId: string
  target: string
  cwd?: string
  attachCommand: string
  logTailCommand?: string
}, dependencies: {
  spawnProcess?: typeof spawnProcess
  readWindowsMonitorLaunchState?: typeof readWindowsMonitorLaunchState
  isProcessAlive?: typeof isProcessAlive
} = {}): Promise<void> {
  const statePath = `${params.target}.open.json`
  const command = buildWindowsAutoOpenCommand({
    attachCommand: params.attachCommand,
    cwd: params.cwd,
    statePath,
  })
  const spawnWindowsProcess = dependencies.spawnProcess ?? spawnProcess
  const readLaunchState = dependencies.readWindowsMonitorLaunchState ?? readWindowsMonitorLaunchState
  const checkProcessAlive = dependencies.isProcessAlive ?? isProcessAlive
  let stdout = ""
  let stderr = ""
  const child = spawnWindowsProcess(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", command],
    {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  )

  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 0))
  })

  const state = await readLaunchState(statePath)
  if (exitCode !== 0 || state?.error) {
    const detail = state?.error || stderr.trim() || stdout.trim() || `wrapper exited with code ${exitCode}`
    throw new Error(`Windows monitor auto-open failed: ${detail}`)
  }

  if (!state?.pid) {
    throw new Error("Windows monitor auto-open failed: missing monitor PID state")
  }

  if (!checkProcessAlive(state.pid)) {
    throw new Error(`Windows monitor auto-open failed: monitor process ${state.pid} did not stay alive`)
  }
}

function quoteWindowsCommandArg(value: string): string {
  const escaped = value.replace(/"/g, '\\"')
  return `"${escaped}"`
}

function resolveWindowsRuntimeScriptPath(scriptName: string): string {
  const runtimePath = fileURLToPath(new URL(`./${scriptName}`, import.meta.url))
  return runtimePath.replace(/[\\/]src[\\/]runtime[\\/]/, `${pathSeparator}dist${pathSeparator}runtime${pathSeparator}`)
}

function resolveWindowsRuntimeWorkspaceRoot(): string {
  const runtimeScriptPath = resolveWindowsRuntimeScriptPath("windows-monitor.js")
  return runtimeScriptPath.replace(/[\\/]dist[\\/]runtime[\\/][^\\/]+$/, "").replace(/\\/g, "/")
}

function buildWindowsNodeExecutable(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === "node" || normalized.endsWith("node.exe")) {
    return "node"
  }

  return `& ${quoteWindowsCommandArg(value)}`
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''")
}

async function readWindowsMonitorLaunchState(statePath: string): Promise<{ pid?: number; error?: string } | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const raw = await readFile(statePath, "utf-8")
      return JSON.parse(raw) as { pid?: number; error?: string }
    } catch {
      await delay(50)
    }
  }

  return undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function statFile(path: string) {
  return await import("node:fs/promises").then(({ stat }) => stat(path))
}

async function openFile(path: string) {
  return await import("node:fs/promises").then(({ open }) => open(path, "r"))
}

function sanitizeWindowsMonitorSessionId(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}`
}

const pathSeparator = "\\"
