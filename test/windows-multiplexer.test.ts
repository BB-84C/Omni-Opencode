import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { selectRuntime } from "../src/runtime/select-runtime"
import { createWindowsPtyRuntime } from "../src/runtime/windows-pty"
import {
  appendWindowsMultiplexerCommand,
  buildWindowsMultiplexerHostCommand,
  ensureWindowsMultiplexerSessionArtifacts,
  resolveWindowsMultiplexerCommandPath,
  readWindowsMultiplexerCursor,
  resolveWindowsMultiplexerEventPath,
  resolveWindowsMultiplexerOwnerPath,
  runWindowsMultiplexerCli,
  writeWindowsMultiplexerOwner,
  WINDOWS_MULTIPLEXER_ARCHIVE_NOTICE,
  WINDOWS_MULTIPLEXER_HOST_BANNER,
} from "../src/runtime/windows-multiplexer"
import {
  processWindowsMultiplexerCommandsOnce,
  WINDOWS_MULTIPLEXER_HOST_ARCHIVE_NOTICE,
} from "../src/runtime/windows-multiplexer-host"

function createMockPty() {
  let dataListener: ((chunk: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined

  return {
    pid: 4242,
    kill() {},
    onData(listener: (chunk: string) => void) {
      dataListener = listener
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListener = listener
    },
    emitData(chunk: string) {
      dataListener?.(chunk)
    },
    exit(code = 0) {
      exitListener?.({ exitCode: code })
    },
  }
}

describe("archived windows shared multiplexer fallback coverage", () => {
  it("marks the legacy multiplexer host path as archived fallback coverage only", () => {
    expect(WINDOWS_MULTIPLEXER_ARCHIVE_NOTICE).toContain("archived")
    expect(WINDOWS_MULTIPLEXER_ARCHIVE_NOTICE).toContain("fallback")
    expect(WINDOWS_MULTIPLEXER_HOST_ARCHIVE_NOTICE).toContain("archived")
    expect(WINDOWS_MULTIPLEXER_HOST_ARCHIVE_NOTICE).toContain("fallback")
  })

  it("routes the shared attach surface through the multiplexer host entrypoint instead of omni-monitor", () => {
    const command = buildWindowsMultiplexerHostCommand("parent-session-1")

    expect(command).toContain("windows-multiplexer-host.js")
    expect(command).not.toContain("windows-monitor.js")
    expect(WINDOWS_MULTIPLEXER_HOST_BANNER).not.toContain("omni-monitor")
  })

  it("does not spawn a second host when the session already has a live owner", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    await writeWindowsMultiplexerOwner(stateDirectory, "parent-session-1", process.pid)
    const spawnHost = vi.fn(async () => 0)

    await expect(runWindowsMultiplexerCli(["attach", "--session", "parent-session-1"], {
      stateDirectory,
      spawnHost,
    })).resolves.toBe(0)

    expect(spawnHost).not.toHaveBeenCalled()
  })

  it("processes shared-session start commands through the host PTY path and emits events", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    const mockPty = createMockPty()
    const spawnPty = vi.fn(() => mockPty)
    const writes: string[] = []

    await appendWindowsMultiplexerCommand(stateDirectory, {
      type: "start",
      sessionId: "parent-session-1",
      jobId: "runtime-1",
      backend: "claude-code",
      shell: "powershell.exe",
      command: 'claude --print "hello"',
      cwd: "D:/Omni-Opencode",
      env: undefined,
    })

    await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: 0,
      setOffset() {},
      spawnPty,
      writeOutput(chunk) {
        writes.push(chunk)
      },
    })

    mockPty.emitData("codex output")
    mockPty.exit(0)

    await vi.waitFor(async () => {
      const events = await readFile(resolveWindowsMultiplexerEventPath(stateDirectory, "parent-session-1"), "utf-8")
      expect(events).toContain('"type":"data"')
      expect(events).toContain('"jobId":"runtime-1"')
      expect(events).toContain("codex output")
      expect(events).toContain('"type":"exit"')
    })

    expect(spawnPty).toHaveBeenCalledWith("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", 'claude --print "hello"'], {
      cwd: "D:/Omni-Opencode",
      env: undefined,
      name: "xterm-color",
    })
    expect(writes.join("\n")).toContain("Started claude-code runtime-1")
  })

  it("checkpoints the command cursor so a replacement host does not replay old starts", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    const firstPty = createMockPty()
    const secondPty = createMockPty()
    const firstSpawn = vi.fn(() => firstPty)
    const secondSpawn = vi.fn(() => secondPty)

    await appendWindowsMultiplexerCommand(stateDirectory, {
      type: "start",
      sessionId: "parent-session-1",
      jobId: "runtime-1",
      backend: "claude-code",
      shell: "powershell.exe",
      command: 'claude --print "hello"',
      cwd: "D:/Omni-Opencode",
      env: undefined,
    })

    const firstOffset = await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: 0,
      setOffset() {},
      spawnPty: firstSpawn,
      writeOutput() {},
    })

    const checkpoint = await readWindowsMultiplexerCursor(stateDirectory, "parent-session-1")
    expect(checkpoint).toBe(firstOffset)

    const secondOffset = await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: checkpoint,
      setOffset() {},
      spawnPty: secondSpawn,
      writeOutput() {},
    })

    expect(firstSpawn).toHaveBeenCalledTimes(1)
    expect(secondSpawn).not.toHaveBeenCalled()
    expect(secondOffset).toBe(checkpoint)
  })

  it("ignores truncated command-log lines until they become valid JSON", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    const spawnPty = vi.fn(() => createMockPty())

    await appendWindowsMultiplexerCommand(stateDirectory, {
      type: "start",
      sessionId: "parent-session-1",
      jobId: "runtime-1",
      backend: "claude-code",
      shell: "powershell.exe",
      command: 'claude --print "hello"',
      cwd: "D:/Omni-Opencode",
      env: undefined,
    })
    await writeFile(
      resolveWindowsMultiplexerCommandPath(stateDirectory, "parent-session-1"),
      `${JSON.stringify({
        type: "start",
        sessionId: "parent-session-1",
        jobId: "runtime-1",
        backend: "claude-code",
        shell: "powershell.exe",
        command: 'claude --print "hello"',
        cwd: "D:/Omni-Opencode",
      })}\n{"type":"start","sessionId":"parent-session-1","jobId":"runtime-2"`,
      "utf-8",
    )

    const firstOffset = await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: 0,
      setOffset() {},
      spawnPty,
      writeOutput() {},
    })

    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(firstOffset).toBeGreaterThan(0)
  })

  it("advances the archived command cursor by UTF-8 bytes instead of decoded string length", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    const firstLine = `${JSON.stringify({
      type: "start",
      sessionId: "parent-session-1",
      jobId: "runtime-1",
      backend: "claude-code",
      shell: "powershell.exe",
      command: 'Write-Output "olá"',
      cwd: "D:/Omni-Opencode",
    })}\n`
    const secondLine = `${JSON.stringify({
      type: "start",
      sessionId: "parent-session-1",
      jobId: "runtime-2",
      backend: "codex",
      shell: "powershell.exe",
      command: 'Write-Output "status"',
      cwd: "D:/Omni-Opencode",
    })}`
    const spawnPty = vi.fn(() => createMockPty())

    await ensureWindowsMultiplexerSessionArtifacts(stateDirectory, "parent-session-1")

    await writeFile(
      resolveWindowsMultiplexerCommandPath(stateDirectory, "parent-session-1"),
      `${firstLine}${secondLine}`,
      "utf-8",
    )

    const firstOffset = await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: 0,
      setOffset() {},
      spawnPty,
      writeOutput() {},
    })

    expect(firstOffset).toBe(Buffer.byteLength(firstLine, "utf-8"))
    expect(spawnPty).toHaveBeenCalledTimes(1)

    await appendFile(resolveWindowsMultiplexerCommandPath(stateDirectory, "parent-session-1"), "\n", "utf-8")

    await processWindowsMultiplexerCommandsOnce({
      stateDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: firstOffset,
      setOffset() {},
      spawnPty,
      writeOutput() {},
    })

    expect(spawnPty).toHaveBeenCalledTimes(2)
  })

  it("reuses one shared monitor host for later delegated jobs in the same parent session", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-mux-"))
    const launchMonitor = vi.fn(async (params: { target: string }) => {
      await writeWindowsMultiplexerOwner(logDirectory, "parent-session-1", process.pid)
    })
    const launchSharedSessionClient = vi.fn(async () => createMockPty())
    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
      open: launchMonitor,
      launchSharedSessionClient,
    })

    const selection = selectRuntime({
      platform: "win32",
      createWindowsRuntime: () => runtime,
    })

    const firstStart = await selection.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })
    await runtime.stop(firstStart.job.id)
    const secondStart = await selection.start({
      backend: "codex",
      command: 'codex exec "status"',
      monitorSessionId: "parent-session-1",
    })
    const firstJob = firstStart.job
    const secondJob = secondStart.job

    const expectedAttachCommand =
      'node "D:\\Omni-Opencode\\dist\\runtime\\windows-multiplexer.js" attach --session "parent-session-1"'

    expect(firstJob.monitor.attachCommand).toBe(expectedAttachCommand)
    expect(secondJob.monitor.attachCommand).toBe(expectedAttachCommand)
    expect(secondJob.monitor.attach.target).toBe(firstJob.monitor.attach.target)
    expect(firstStart.monitor).toBeUndefined()
    expect(secondStart.monitor).toBeUndefined()
    expect(launchSharedSessionClient).toHaveBeenCalledTimes(2)
    expect(launchMonitor).not.toHaveBeenCalled()
  })

  it("reports shared host auto-open failure without aborting the Windows runtime start", async () => {
    const open = vi.fn(async () => {
      throw new Error("window creation failed")
    })
    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      open,
      launchSharedSessionClient: vi.fn(async () => createMockPty()),
    })

    const selection = selectRuntime({
      platform: "win32",
      createWindowsRuntime: () => runtime,
    })

    await expect(selection.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })).resolves.toMatchObject({
      job: {
        monitor: {
          attachCommand:
            'node "D:\\Omni-Opencode\\dist\\runtime\\windows-multiplexer.js" attach --session "parent-session-1"',
        },
      },
      monitor: undefined,
    })

    await expect(runtime.openMonitor({ type: "job", jobId: "runtime-1" })).rejects.toThrow("window creation failed")
    expect(open).toHaveBeenCalledTimes(1)
  })
})
