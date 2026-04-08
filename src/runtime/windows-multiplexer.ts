import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// Archived helper retained only for the legacy node-pty fallback path.
export const WINDOWS_MULTIPLEXER_ARCHIVE_NOTICE = "archived Windows multiplexer fallback only"
export const WINDOWS_MULTIPLEXER_HOST_BANNER = "[omni-multiplexer]"

export type WindowsMultiplexerStartCommand = {
  type: "start"
  sessionId: string
  jobId: string
  backend: "claude-code" | "codex"
  shell: string
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type WindowsMultiplexerStopCommand = {
  type: "stop"
  sessionId: string
  jobId: string
}

export type WindowsMultiplexerCommand = WindowsMultiplexerStartCommand | WindowsMultiplexerStopCommand

export type WindowsMultiplexerDataEvent = {
  type: "data"
  jobId: string
  chunk: string
}

export type WindowsMultiplexerExitEvent = {
  type: "exit"
  jobId: string
  exitCode: number
}

export type WindowsMultiplexerEvent = WindowsMultiplexerDataEvent | WindowsMultiplexerExitEvent

export type RunWindowsMultiplexerCliOptions = {
  stateDirectory?: string
  spawnHost?: (params: { sessionId: string; stateDirectory: string }) => Promise<number> | number
  isProcessAlive?: (pid: number) => boolean
}

export function buildWindowsMultiplexerHostCommand(sessionId: string): string {
  const hostScript = resolveWindowsRuntimeScriptPath("windows-multiplexer-host.js")
  return `node "${hostScript}" --session "${sessionId}"`
}

export function resolveDefaultWindowsMultiplexerStateDirectory(): string {
  const runtimeDirectory = dirname(resolveWindowsRuntimeScriptPath("windows-multiplexer.js"))
  const workspaceRoot = dirname(dirname(runtimeDirectory))
  return join(workspaceRoot, ".omni-monitors")
}

export function resolveWindowsMultiplexerSessionDirectory(stateDirectory: string, sessionId: string): string {
  return join(stateDirectory, sanitizeWindowsMonitorSessionId(sessionId))
}

export function resolveWindowsMultiplexerCommandPath(stateDirectory: string, sessionId: string): string {
  return join(resolveWindowsMultiplexerSessionDirectory(stateDirectory, sessionId), "commands.ndjson")
}

export function resolveWindowsMultiplexerEventPath(stateDirectory: string, sessionId: string): string {
  return join(resolveWindowsMultiplexerSessionDirectory(stateDirectory, sessionId), "events.ndjson")
}

export function resolveWindowsMultiplexerOwnerPath(stateDirectory: string, sessionId: string): string {
  return join(resolveWindowsMultiplexerSessionDirectory(stateDirectory, sessionId), "owner.json")
}

export function resolveWindowsMultiplexerCursorPath(stateDirectory: string, sessionId: string): string {
  return join(resolveWindowsMultiplexerSessionDirectory(stateDirectory, sessionId), "command-cursor.json")
}

export async function ensureWindowsMultiplexerSessionArtifacts(stateDirectory: string, sessionId: string): Promise<void> {
  const sessionDirectory = resolveWindowsMultiplexerSessionDirectory(stateDirectory, sessionId)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(resolveWindowsMultiplexerCommandPath(stateDirectory, sessionId), "", { flag: "a" })
  await writeFile(resolveWindowsMultiplexerEventPath(stateDirectory, sessionId), "", { flag: "a" })
}

export async function appendWindowsMultiplexerCommand(
  stateDirectory: string,
  command: WindowsMultiplexerCommand,
): Promise<void> {
  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, command.sessionId)
  await appendWindowsMultiplexerRecord(resolveWindowsMultiplexerCommandPath(stateDirectory, command.sessionId), command)
}

export async function appendWindowsMultiplexerEvent(
  stateDirectory: string,
  sessionId: string,
  event: WindowsMultiplexerEvent,
): Promise<void> {
  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, sessionId)
  await appendWindowsMultiplexerRecord(resolveWindowsMultiplexerEventPath(stateDirectory, sessionId), event)
}

export async function runWindowsMultiplexerCli(argv: string[], options: RunWindowsMultiplexerCliOptions = {}): Promise<number> {
  const [action, ...args] = argv

  if (action !== "attach") {
    process.stderr.write("Usage: node windows-multiplexer.js attach --session <sessionId>\n")
    return 1
  }

  const sessionIndex = args.indexOf("--session")
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined

  if (!sessionId) {
    process.stderr.write("Usage: node windows-multiplexer.js attach --session <sessionId>\n")
    return 1
  }

  const stateDirectory = options.stateDirectory ?? resolveDefaultWindowsMultiplexerStateDirectory()
  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, sessionId)

  if (await hasLiveWindowsMultiplexerOwner(stateDirectory, sessionId, options.isProcessAlive)) {
    return 0
  }

  const spawnHost = options.spawnHost ?? defaultWindowsMultiplexerHostSpawner

  return await spawnHost({ sessionId, stateDirectory })
}

export async function hasLiveWindowsMultiplexerOwner(
  stateDirectory: string,
  sessionId: string,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): Promise<boolean> {
  try {
    const raw = await readFile(resolveWindowsMultiplexerOwnerPath(stateDirectory, sessionId), "utf-8")
    const owner = JSON.parse(raw) as { pid?: number }
    return typeof owner.pid === "number" && isProcessAlive(owner.pid)
  } catch {
    return false
  }
}

export async function writeWindowsMultiplexerOwner(
  stateDirectory: string,
  sessionId: string,
  pid: number,
): Promise<void> {
  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, sessionId)
  await writeFile(resolveWindowsMultiplexerOwnerPath(stateDirectory, sessionId), JSON.stringify({ pid }), "utf-8")
}

export async function readWindowsMultiplexerCursor(stateDirectory: string, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(resolveWindowsMultiplexerCursorPath(stateDirectory, sessionId), "utf-8")
    const cursor = JSON.parse(raw) as { offset?: number }
    return typeof cursor.offset === "number" ? cursor.offset : 0
  } catch {
    return 0
  }
}

export async function writeWindowsMultiplexerCursor(
  stateDirectory: string,
  sessionId: string,
  offset: number,
): Promise<void> {
  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, sessionId)
  await writeFile(resolveWindowsMultiplexerCursorPath(stateDirectory, sessionId), JSON.stringify({ offset }), "utf-8")
}

async function defaultWindowsMultiplexerHostSpawner(params: { sessionId: string; stateDirectory: string }): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./windows-multiplexer-host.js", import.meta.url)),
      "--session",
      params.sessionId,
      "--state-dir",
      params.stateDirectory,
    ], {
      stdio: "inherit",
    })

    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 0))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runWindowsMultiplexerCli(process.argv.slice(2)).then((code) => {
    process.exit(code)
  })
}

async function appendWindowsMultiplexerRecord(path: string, value: WindowsMultiplexerCommand | WindowsMultiplexerEvent): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8")
}

function resolveWindowsRuntimeScriptPath(scriptName: string): string {
  const runtimePath = fileURLToPath(new URL(`./${scriptName}`, import.meta.url))
  return runtimePath.replace(/[\\/]src[\\/]runtime[\\/]/, `${pathSeparator}dist${pathSeparator}runtime${pathSeparator}`)
}

function sanitizeWindowsMonitorSessionId(sessionId: string): string {
  return `session-${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}`
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pathSeparator = "\\"
