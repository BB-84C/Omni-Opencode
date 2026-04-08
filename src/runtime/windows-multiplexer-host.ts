import * as nodePty from "node-pty"
import { open, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  appendWindowsMultiplexerEvent,
  ensureWindowsMultiplexerSessionArtifacts,
  hasLiveWindowsMultiplexerOwner,
  readWindowsMultiplexerCursor,
  resolveDefaultWindowsMultiplexerStateDirectory,
  resolveWindowsMultiplexerCommandPath,
  writeWindowsMultiplexerOwner,
  writeWindowsMultiplexerCursor,
  type WindowsMultiplexerCommand,
  WINDOWS_MULTIPLEXER_HOST_BANNER,
} from "./windows-multiplexer.js"

// Archived helper retained only for the legacy node-pty fallback path.
export const WINDOWS_MULTIPLEXER_HOST_ARCHIVE_NOTICE = "archived Windows multiplexer host fallback only"

export async function runWindowsMultiplexerHost(argv: string[]): Promise<number> {
  const sessionIndex = argv.indexOf("--session")
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined
  const stateDirectoryIndex = argv.indexOf("--state-dir")
  const stateDirectory = stateDirectoryIndex >= 0
    ? argv[stateDirectoryIndex + 1]
    : resolveDefaultWindowsMultiplexerStateDirectory()

  if (!sessionId) {
    process.stderr.write("Usage: node windows-multiplexer-host.js --session <sessionId>\n")
    return 1
  }

  let offset = await readWindowsMultiplexerCursor(stateDirectory, sessionId)
  let closed = false
  const commandPath = resolveWindowsMultiplexerCommandPath(stateDirectory, sessionId)
  const children = new Map<string, WindowsMultiplexerHostChild>()

  await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, sessionId)
  if (await hasLiveWindowsMultiplexerOwner(stateDirectory, sessionId, (pid) => pid === process.pid ? false : isProcessAlive(pid))) {
    return 0
  }
  await writeWindowsMultiplexerOwner(stateDirectory, sessionId, process.pid)

  process.on("SIGINT", () => {
    closed = true
    for (const child of children.values()) {
      child.kill()
    }
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    closed = true
    for (const child of children.values()) {
      child.kill()
    }
    process.exit(0)
  })

  offset = await processWindowsMultiplexerCommandsOnce({
    stateDirectory,
    sessionId,
    children,
    offset,
    setOffset(value) {
      offset = value
    },
  })

  const timer = setInterval(() => {
    void processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId,
      children,
      offset,
      setOffset(value) {
        offset = value
      },
    })
  }, 250)

  timer.unref()
  process.stdout.write(`\n${WINDOWS_MULTIPLEXER_HOST_BANNER} Session ${sessionId} attached\n`)

  while (!closed) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return 0
}

type WindowsMultiplexerHostChild = {
  kill(): void
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode?: number }) => void): void
}

export async function processWindowsMultiplexerCommandsOnce(params: {
  stateDirectory: string
  sessionId: string
  children: Map<string, WindowsMultiplexerHostChild>
  offset: number
  setOffset: (value: number) => void
  spawnPty?: typeof spawnWindowsMultiplexerPty
  writeOutput?: (chunk: string) => void
}): Promise<number> {
  const commandPath = resolveWindowsMultiplexerCommandPath(params.stateDirectory, params.sessionId)
  const info = await stat(commandPath)
  const offset = params.offset

  if (info.size <= offset) {
    return offset
  }

  const handle = await open(commandPath, "r")
  let nextOffset = offset

  try {
    const length = info.size - offset
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    const completeLength = getWindowsMultiplexerCompleteRecordLength(buffer)
    nextOffset = offset + completeLength

    if (completeLength <= 0) {
      return offset
    }

    const completeContent = buffer.subarray(0, completeLength).toString("utf-8")
    params.setOffset(nextOffset)
    await writeWindowsMultiplexerCursor(params.stateDirectory, params.sessionId, nextOffset)
    for (const line of completeContent.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      let command: WindowsMultiplexerCommand
      try {
        command = JSON.parse(trimmed) as WindowsMultiplexerCommand
      } catch {
        continue
      }

      await handleCommand(
        params.stateDirectory,
        params.sessionId,
        command,
        params.children,
        params.spawnPty ?? spawnWindowsMultiplexerPty,
        params.writeOutput ?? ((chunk) => process.stdout.write(chunk)),
      )
    }
  } finally {
    await handle.close()
  }

  return nextOffset
}

function getWindowsMultiplexerCompleteRecordLength(buffer: Buffer): number {
  const lastNewline = Math.max(buffer.lastIndexOf(0x0a), buffer.lastIndexOf(0x0d))
  return lastNewline < 0 ? 0 : lastNewline + 1
}

async function handleCommand(
  stateDirectory: string,
  sessionId: string,
  command: WindowsMultiplexerCommand,
  children: Map<string, WindowsMultiplexerHostChild>,
  spawnPty: typeof spawnWindowsMultiplexerPty,
  writeOutput: (chunk: string) => void,
): Promise<void> {
  if (command.type === "stop") {
    children.get(command.jobId)?.kill()
    return
  }

  if (children.has(command.jobId)) {
    return
  }

  const child = spawnPty(command.shell, ["-NoLogo", "-NoProfile", "-Command", command.command], {
    cwd: command.cwd,
    env: command.env,
    name: "xterm-color",
  })

  children.set(command.jobId, child)
  writeOutput(`\n${WINDOWS_MULTIPLEXER_HOST_BANNER} Started ${command.backend} ${command.jobId}\n`)

  child.onData((chunk) => {
    writeOutput(chunk)
    void appendWindowsMultiplexerEvent(stateDirectory, sessionId, {
      type: "data",
      jobId: command.jobId,
      chunk,
    })
  })

  child.onExit((event) => {
    children.delete(command.jobId)
    void appendWindowsMultiplexerEvent(stateDirectory, sessionId, {
      type: "exit",
      jobId: command.jobId,
      exitCode: event.exitCode ?? 0,
    })
  })
}

function spawnWindowsMultiplexerPty(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string },
): WindowsMultiplexerHostChild {
  const spawn = resolveNodePtySpawn(nodePty)
  return spawn(file, args, options)
}

function resolveNodePtySpawn(module: unknown): {
  (
    file: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string },
  ): { kill(): void; onData(listener: (chunk: string) => void): void; onExit(listener: (event: { exitCode?: number }) => void): void }
} {
  const candidate = module as {
    spawn?: unknown
    default?: { spawn?: unknown }
  }
  const resolved = candidate.spawn ?? candidate.default?.spawn
  if (typeof resolved !== "function") {
    throw new Error("node-pty spawn export is unavailable")
  }
  return resolved as {
    (
      file: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string },
    ): { kill(): void; onData(listener: (chunk: string) => void): void; onExit(listener: (event: { exitCode?: number }) => void): void }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runWindowsMultiplexerHost(process.argv.slice(2)).then((code) => {
    process.exit(code)
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
