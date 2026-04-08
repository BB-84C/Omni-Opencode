import { describe, expect, it, vi } from "vitest"
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildWindowsAutoOpenCommand,
  createWindowsPtyRuntime,
  openWindowsMonitor,
  resolveNodePtySpawn,
  resolveNodePtySpawnAsync,
  resolveNodeHelperExecutable,
  WINDOWS_PTY_RUNTIME_ARCHIVE_NOTICE,
} from "../src/runtime/windows-pty"
import { selectRuntime } from "../src/runtime/select-runtime"
import { writeWindowsMultiplexerOwner } from "../src/runtime/windows-multiplexer"
import { processWindowsMultiplexerCommandsOnce } from "../src/runtime/windows-multiplexer-host"
import { resolveWindowsMultiplexerEventPath } from "../src/runtime/windows-multiplexer"

type MockPty = {
  emitData(chunk: string): void
  exit(code?: number): void
}

function createMockPty(): MockPty & {
  pid: number
  kill(): void
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
} {
  let dataListener: ((chunk: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined

  return {
    pid: 4242,
    onData(listener) {
      dataListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
    kill() {},
    emitData(chunk: string) {
      dataListener?.(chunk)
    },
    exit(code = 0) {
      exitListener?.({ exitCode: code })
    },
  }
}

describe("archived windows PTY runtime fallback coverage", () => {
  it("exposes archive-only metadata for the legacy node-pty path", () => {
    expect(WINDOWS_PTY_RUNTIME_ARCHIVE_NOTICE).toContain("archived")
    expect(WINDOWS_PTY_RUNTIME_ARCHIVE_NOTICE).toContain("fallback")
  })

  it("resolves node-pty spawn from default export shape", () => {
    const spawn = vi.fn()

    expect(resolveNodePtySpawn({ default: { spawn } })).toBe(spawn)
  })

  it("falls back to a loader when direct node-pty exports are unavailable", () => {
    const spawn = vi.fn()

    expect(resolveNodePtySpawn({}, () => ({ spawn }))).toBe(spawn)
  })

  it("falls back to an async loader when direct node-pty exports are unavailable", async () => {
    const spawn = vi.fn()

    await expect(resolveNodePtySpawnAsync({}, async () => ({ default: { spawn } }))).resolves.toBe(spawn)
  })

  it("resolves spawn from a plain CommonJS-style module export object", () => {
    const spawn = vi.fn()

    expect(resolveNodePtySpawn({ spawn, fork: vi.fn() })).toBe(spawn)
  })

  it("uses node instead of the host executable when process.execPath is an opencode/bun host", () => {
    expect(resolveNodeHelperExecutable("C:/Users/Administrator/AppData/Roaming/npm/opencode.exe")).toBe("node")
  })

  it("wraps Windows auto-open in Start-Process so the monitor can detach from the host", () => {
    const command = buildWindowsAutoOpenCommand({
      attachCommand: 'node "D:/Omni-Opencode/dist/runtime/windows-monitor.js" "D:/Omni-Opencode/.omni-monitors/runtime-1.log"',
      cwd: "D:/Omni-Opencode",
      statePath: "D:/Omni-Opencode/.omni-monitors/runtime-1.open.json",
    })

    expect(command).toContain("Start-Process")
    expect(command).toContain("-FilePath powershell.exe")
    expect(command).toContain("-WorkingDirectory 'D:/Omni-Opencode'")
    expect(command).toContain("-PassThru")
    expect(command).toContain("runtime-1.open.json")
    expect(command).toContain("'-NoExit','-Command','node \"D:/Omni-Opencode/dist/runtime/windows-monitor.js\" \"D:/Omni-Opencode/.omni-monitors/runtime-1.log\"'")
  })

  it("fails clearly off Windows", () => {
    expect(() => createWindowsPtyRuntime({ platform: "linux" })).toThrow(
      "Windows PTY runtime requires win32",
    )
  })

  it("builds launch metadata and captures incremental PTY output", async () => {
    const spawnCalls: Array<{
      file: string
      args: string[]
      options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string }
    }> = []
    const pty = createMockPty()
    const open = vi.fn(async () => undefined)

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "C:/vault",
      env: { TERM_PROGRAM: "vitest" },
      open,
      spawn(file, args, options) {
        spawnCalls.push({ file, args, options })
        return pty
      },
    })

    const job = await runtime.start({
      backend: "codex",
      command: "node child.js --watch",
    })

    pty.emitData("alpha")
    pty.emitData(" beta")

    expect(spawnCalls).toEqual([
      {
        file: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command", "node child.js --watch"],
        options: {
          cwd: "C:/vault",
          env: { TERM_PROGRAM: "vitest" },
          name: "xterm-color",
        },
      },
    ])

    const monitor = await runtime.openMonitor({ type: "job", jobId: job.id })

    expect(job.command).toBe("node child.js --watch")
    expect(job.monitor.id).toBeTruthy()
    expect(monitor).toEqual(job.monitor)
    expect(monitor.attach).toEqual({
      mode: "pty",
      target: job.monitor.attach.target,
    })
    expect(monitor.attachCommand).toContain("windows-monitor.js")
    expect(monitor.attachCommand).toContain(job.monitor.attach.target)
    expect(monitor.logTailCommand).toBe(`Get-Content -Path \"${job.monitor.attach.target}\" -Wait`)
    expect(monitor.attachCommand).not.toBe(monitor.logTailCommand)
    expect(monitor.launch).toEqual({
      command: monitor.attachCommand,
      cwd: "C:/vault",
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(await runtime.read(job.id)).toEqual({ data: "alpha beta" })
    expect(await runtime.read(job.id)).toEqual({ data: "" })

    pty.emitData("gamma")
    expect(await runtime.read(job.id)).toEqual({ data: "gamma" })

    pty.exit(0)
    const snapshot = await runtime.snapshot()

    expect(snapshot.jobs).toContainEqual({
      ...job,
      status: "stopped",
    })
  })

  it("returns the exact shared multiplexer attach command for a parent session", async () => {
    const pty = createMockPty()
    const launchSharedSessionClient = vi.fn(async () => pty)
    const open = vi.fn(async () => undefined)

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      open,
      launchSharedSessionClient,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })

    expect(job.monitor.attachCommand).toBe(
      'node "D:\\Omni-Opencode\\dist\\runtime\\windows-multiplexer.js" attach --session "parent-session-1"',
    )
    expect(job.monitor.attachCommand).not.toContain("windows-monitor.js")
    expect(job.monitor.attach.target).toContain("session-parent-session-1")
    expect(job.monitor.attach.target).not.toContain(".log")
    expect(job.monitor.attach.target).not.toContain("runtime-1.log")
    expect(job.monitor.logTailCommand).toBeUndefined()
    expect(launchSharedSessionClient).toHaveBeenCalledWith({
      sessionId: "parent-session-1",
      jobId: job.id,
      backend: "claude-code",
      shell: "powershell.exe",
      command: 'claude --print "hello"',
      cwd: "D:/Omni-Opencode",
      env: undefined,
      logDirectory: expect.any(String),
      initialOffset: 0,
    })
    await expect(runtime.openMonitor({ type: "job", jobId: job.id })).resolves.toMatchObject({
      attachCommand:
        'node "D:\\Omni-Opencode\\dist\\runtime\\windows-multiplexer.js" attach --session "parent-session-1"',
    })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("propagates shared-host PTY output and exit back through the default shared client path", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))
    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "hello"',
      monitorSessionId: "parent-session-1",
    })

    const hostPty = createMockPty()
    const spawnPty = vi.fn(() => hostPty)

    await processWindowsMultiplexerCommandsOnce({
      stateDirectory: logDirectory,
      sessionId: "parent-session-1",
      children: new Map(),
      offset: 0,
      setOffset() {},
      spawnPty,
      writeOutput() {},
    })

    hostPty.emitData("alpha")
    hostPty.emitData(" beta")

    await vi.waitFor(async () => {
      const events = await import("node:fs/promises").then(({ readFile }) =>
        readFile(resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1"), "utf-8"),
      )
      expect(events).toContain("alpha")
      expect(events).toContain(" beta")
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    const sharedOutput = await runtime.read(job.id)
    expect(sharedOutput.data).toContain("alpha")
    expect(sharedOutput.data).toContain(" beta")
    expect(await runtime.read(job.id)).toEqual({ data: "" })

    hostPty.exit(7)

    await vi.waitFor(async () => {
      const snapshot = await runtime.snapshot()
      expect(snapshot.jobs).toContainEqual({
        ...job,
        status: "stopped",
      })
    })

    expect(spawnPty).toHaveBeenCalledWith("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", 'claude --print "hello"'], {
      cwd: "D:/Omni-Opencode",
      env: undefined,
      name: "xterm-color",
    })
  })

  it("ignores stale shared-session events from a previous archived runtime process when job ids restart", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))
    await mkdir(join(logDirectory, "session-parent-session-1"), { recursive: true })
    await writeFile(
      resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1"),
      `${JSON.stringify({ type: "data", jobId: "runtime-1", chunk: "stale output" })}\n`,
      "utf-8",
    )

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "fresh"',
      monitorSessionId: "parent-session-1",
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    await expect(runtime.read(job.id)).resolves.toEqual({ data: "" })

    await appendFile(
      resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1"),
      `${JSON.stringify({ type: "data", jobId: job.id, chunk: "fresh output" })}\n`,
      "utf-8",
    )

    await vi.waitFor(async () => {
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "fresh output" })
    })
  })

  it("captures the archived shared-event baseline before polling so immediate fresh output is not skipped", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))
    await mkdir(join(logDirectory, "session-parent-session-1"), { recursive: true })
    const eventPath = resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1")
    await writeFile(
      eventPath,
      `${JSON.stringify({ type: "data", jobId: "runtime-1", chunk: "stale output" })}\n`,
      "utf-8",
    )
    const readSharedEventBaseline = vi.fn(async (path: string) => {
      const raw = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf-8"))
      return raw.length
    })

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
      readSharedEventBaseline,
    } as never)

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "fresh"',
      monitorSessionId: "parent-session-1",
    })

    await appendFile(
      eventPath,
      `${JSON.stringify({ type: "data", jobId: job.id, chunk: "fresh output" })}\n`,
      "utf-8",
    )

    await vi.waitFor(async () => {
      expect(readSharedEventBaseline).toHaveBeenCalledWith(eventPath)
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "fresh output" })
    })
  })

  it("ignores a trailing partial shared-event line until the archived event record is complete", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))
    await mkdir(join(logDirectory, "session-parent-session-1"), { recursive: true })
    const eventPath = resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1")
    await writeFile(eventPath, "", "utf-8")

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "fresh"',
      monitorSessionId: "parent-session-1",
    })

    await appendFile(
      eventPath,
      `${JSON.stringify({ type: "data", jobId: job.id, chunk: "alpha" })}\n${JSON.stringify({ type: "data", jobId: job.id, chunk: "beta" }).slice(0, -2)}`,
      "utf-8",
    )

    await vi.waitFor(async () => {
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "alpha" })
    })

    await appendFile(eventPath, '"}\n', "utf-8")

    await vi.waitFor(async () => {
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "beta" })
    })
  })

  it("advances the archived shared-event cursor by UTF-8 bytes without dropping later output", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))
    await mkdir(join(logDirectory, "session-parent-session-1"), { recursive: true })
    const eventPath = resolveWindowsMultiplexerEventPath(logDirectory, "parent-session-1")
    await writeFile(eventPath, "", "utf-8")

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      logDirectory,
    })

    const job = await runtime.start({
      backend: "claude-code",
      command: 'claude --print "fresh"',
      monitorSessionId: "parent-session-1",
    })

    const firstLine = `${JSON.stringify({ type: "data", jobId: job.id, chunk: "olá" })}\n`
    const secondLine = `${JSON.stringify({ type: "data", jobId: job.id, chunk: "世界" })}`

    await appendFile(eventPath, `${firstLine}${secondLine}`, "utf-8")

    await vi.waitFor(async () => {
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "olá" })
    })

    await appendFile(eventPath, "\n", "utf-8")

    await vi.waitFor(async () => {
      await expect(runtime.read(job.id)).resolves.toEqual({ data: "世界" })
    })
  })

  it("falls back to exit-code detail when archived auto-open fails without stderr or stdout output", async () => {
    const stdout = { on: vi.fn() }
    const stderr = { on: vi.fn() }
    const child = {
      stdout,
      stderr,
      on(event: string, listener: (value?: number) => void) {
        if (event === "exit") {
          listener(7)
        }
      },
    }

    await expect(openWindowsMonitor({
      jobId: "runtime-1",
      target: "D:/Omni-Opencode/.omni-monitors/runtime-1.log",
      cwd: "D:/Omni-Opencode",
      attachCommand: 'node "D:/Omni-Opencode/dist/runtime/windows-monitor.js" "D:/Omni-Opencode/.omni-monitors/runtime-1.log"',
    }, {
      spawnProcess: vi.fn(() => child as never),
      readWindowsMonitorLaunchState: vi.fn(async () => undefined),
    })).rejects.toThrow("Windows monitor auto-open failed: wrapper exited with code 7")
  })

  it("auto-opens the shared monitor host for the first delegated job in a parent session", async () => {
    const pty = createMockPty()
    const launchMonitor = vi.fn(async () => {
      await writeWindowsMultiplexerOwner(logDirectory, "parent-session-1", process.pid)
    })
    const launchSharedSessionClient = vi.fn(async () => pty)
    const logDirectory = await mkdtemp(join(tmpdir(), "omni-pty-"))

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "C:/vault",
      logDirectory,
      open: launchMonitor,
      launchSharedSessionClient,
    })

    const selection = selectRuntime({
      platform: "win32",
      createWindowsRuntime: () => runtime,
    })

    const started = await selection.start({
      backend: "claude-code",
      command: "claude --print \"hello\"",
      monitorSessionId: "parent-session-1",
    })
    const job = started.job

    expect(launchSharedSessionClient).toHaveBeenCalledTimes(1)
    expect(started.monitor).toBeUndefined()

    expect(launchMonitor).not.toHaveBeenCalled()
  })

  it("uses a helper launcher when no direct spawn implementation is injected", async () => {
    const helperClient = createMockPty()
    const launchHelper = vi.fn(async () => helperClient)

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "C:/vault",
      launchHelper,
    })

    const job = await runtime.start({
      backend: "codex",
      command: "codex \"hello\"",
    })

    expect(launchHelper).toHaveBeenCalledWith({
      shell: "powershell.exe",
      command: "codex \"hello\"",
      cwd: "C:/vault",
      env: undefined,
      backend: "codex",
      jobId: job.id,
    })
  })
})
