import { describe, expect, it } from "vitest"
import { createWindowsPtyRuntime } from "../src/runtime/windows-pty"

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

describe("windows PTY runtime", () => {
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

    const runtime = createWindowsPtyRuntime({
      shell: "powershell.exe",
      platform: "win32",
      cwd: "C:/vault",
      env: { TERM_PROGRAM: "vitest" },
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

    const monitor = await runtime.openMonitor(job.id)

    expect(job.command).toBe("node child.js --watch")
    expect(job.monitor.id).toBeTruthy()
    expect(monitor).toEqual(job.monitor)
    expect(monitor.attach).toEqual({
      mode: "pty",
      target: job.monitor.id,
    })
    expect(monitor.launch).toEqual({
      command: "node child.js --watch",
      cwd: "C:/vault",
    })
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
})
