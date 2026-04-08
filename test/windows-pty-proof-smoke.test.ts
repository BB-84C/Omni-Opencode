import { afterEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"

type MockProofPtyChild = {
  pid: number
  kill: ReturnType<typeof vi.fn>
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode?: number }) => void): void
  emitData(chunk: string): void
  emitExit(event: { exitCode?: number }): void
}

function createMockProofPtyChild(pid: number): MockProofPtyChild {
  let dataListener: ((chunk: string) => void) | undefined
  let exitListener: ((event: { exitCode?: number }) => void) | undefined

  return {
    pid,
    kill: vi.fn(),
    onData(listener) {
      dataListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
    emitData(chunk) {
      dataListener?.(chunk)
    },
    emitExit(event) {
      exitListener?.(event)
    },
  }
}

async function loadWindowsPtyProofModule() {
  return import("../scripts/windows-pty-multiplexer-proof")
}

async function readWindowsPtyProofSource() {
  return readFile(new URL("../scripts/windows-pty-multiplexer-proof.ts", import.meta.url), "utf8")
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe("windows PTY proof smoke mode", () => {
  it("starts the configured panes and captures their initial output and state transitions", async () => {
    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])

    const { defineWindowsPtyProof, runWindowsPtyProofSmoke } = await loadWindowsPtyProofModule()
    const proof = defineWindowsPtyProof()
    const smokePromise = runWindowsPtyProofSmoke(proof, { spawnPty })

    children[0].emitData("codex-1 ready")
    children[1].emitData("codex-2 ready")
    children[2].emitData("codex-3 ready")
    children[3].emitData("claude-1 ready")
    children[4].emitData("claude-2 ready")

    children.forEach((child, index) => {
      child.emitExit({ exitCode: index })
    })

    const result = await smokePromise

    expect(spawnPty).toHaveBeenCalledTimes(proof.panes.length)
    expect(result.stateTransitions).toEqual([
      { paneId: "codex-1", status: "running" },
      { paneId: "codex-2", status: "running" },
      { paneId: "codex-3", status: "running" },
      { paneId: "claude-1", status: "running" },
      { paneId: "claude-2", status: "running" },
      { paneId: "codex-1", status: "done" },
      { paneId: "codex-2", status: "error" },
      { paneId: "codex-3", status: "error" },
      { paneId: "claude-1", status: "error" },
      { paneId: "claude-2", status: "error" },
    ])
    expect(result.outputByPaneId).toEqual({
      "codex-1": "codex-1 ready",
      "codex-2": "codex-2 ready",
      "codex-3": "codex-3 ready",
      "claude-1": "claude-1 ready",
      "claude-2": "claude-2 ready",
    })
    expect(result.exitCodesByPaneId).toEqual({
      "codex-1": 0,
      "codex-2": 1,
      "codex-3": 2,
      "claude-1": 3,
      "claude-2": 4,
    })
  })

  it("can stop the smoke run cleanly after a short timeout without manual interaction", async () => {
    vi.useFakeTimers()

    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])

    try {
      const { defineWindowsPtyProof, runWindowsPtyProofSmoke } = await loadWindowsPtyProofModule()
      const proof = defineWindowsPtyProof()
      const smokePromise = runWindowsPtyProofSmoke(proof, {
        spawnPty,
        durationMs: 25,
      })
      let settled = false
      void smokePromise.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(25)

      expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
      expect(settled).toBe(false)

      children.forEach((child) => {
        child.emitExit({ exitCode: 0 })
      })

      const result = await smokePromise

      expect(result.stopReason).toBe("timeout")
      expect(result.stateTransitions).toEqual([
        { paneId: "codex-1", status: "running" },
        { paneId: "codex-2", status: "running" },
        { paneId: "codex-3", status: "running" },
        { paneId: "claude-1", status: "running" },
        { paneId: "claude-2", status: "running" },
        { paneId: "codex-1", status: "done" },
        { paneId: "codex-2", status: "done" },
        { paneId: "codex-3", status: "done" },
        { paneId: "claude-1", status: "done" },
        { paneId: "claude-2", status: "done" },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("still completes automatically after timeout when PTY exits never arrive", async () => {
    vi.useFakeTimers()

    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])

    try {
      const { defineWindowsPtyProof, runWindowsPtyProofSmoke } = await loadWindowsPtyProofModule()
      const proof = defineWindowsPtyProof()
      const smokePromise = runWindowsPtyProofSmoke(proof, {
        spawnPty,
        durationMs: 25,
      })
      let settled = false
      void smokePromise.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(25)

      expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)

      const result = await smokePromise

      expect(result.stopReason).toBe("timeout")
      expect(result.exitCodesByPaneId).toEqual({})
      expect(result.stateTransitions).toEqual([
        { paneId: "codex-1", status: "running" },
        { paneId: "codex-2", status: "running" },
        { paneId: "codex-3", status: "running" },
        { paneId: "claude-1", status: "running" },
        { paneId: "claude-2", status: "running" },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns a stable smoke snapshot after resolution", async () => {
    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])

    const { defineWindowsPtyProof, runWindowsPtyProofSmoke } = await loadWindowsPtyProofModule()
    const proof = defineWindowsPtyProof()
    const smokePromise = runWindowsPtyProofSmoke(proof, { spawnPty })

    children[0].emitData("initial output")
    children.forEach((child) => {
      child.emitExit({ exitCode: 0 })
    })

    const result = await smokePromise

    children[0].emitData(" after resolution")
    children[0].emitExit({ exitCode: 7 })

    expect(result.outputByPaneId["codex-1"]).toBe("initial output")
    expect(result.exitCodesByPaneId["codex-1"]).toBe(0)
    expect(result.stateTransitions).toEqual([
      { paneId: "codex-1", status: "running" },
      { paneId: "codex-2", status: "running" },
      { paneId: "codex-3", status: "running" },
      { paneId: "claude-1", status: "running" },
      { paneId: "claude-2", status: "running" },
      { paneId: "codex-1", status: "done" },
      { paneId: "codex-2", status: "done" },
      { paneId: "codex-3", status: "done" },
      { paneId: "claude-1", status: "done" },
      { paneId: "claude-2", status: "done" },
    ])
  })

  it("exposes smoke mode through the proof script CLI path", async () => {
    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])
    const write = vi.fn()

    const { runWindowsPtyProofCli } = await loadWindowsPtyProofModule()

    const cliPromise = runWindowsPtyProofCli(["--smoke"], {
      spawnPty,
      write,
    })

    children.forEach((child) => {
      child.emitExit({ exitCode: 0 })
    })

    const result = await cliPromise
    const source = await readWindowsPtyProofSource()

    expect(result.stopReason).toBe("all-exited")
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Smoke result: all-exited"))
    expect(source).toContain("runWindowsPtyProofCli(process.argv.slice(2))")
  })

  it("defaults to persistent panel-render mode when no --smoke flag is provided", async () => {
    vi.useFakeTimers()

    const children = Array.from({ length: 5 }, (_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])
    const writes: string[] = []

    try {
      const { runWindowsPtyProofCli } = await loadWindowsPtyProofModule()

      const cliPromise = runWindowsPtyProofCli([], {
        spawnPty,
        write(message) {
          writes.push(message)
        },
        durationMs: 25,
      })

      children[0].emitData("codex output")
      await vi.advanceTimersByTimeAsync(25)
      children.forEach((child) => {
        child.emitExit({ exitCode: 0 })
      })
      await cliPromise

      expect(writes.join("\n")).toContain("=== Codex 1 ===")
      expect(writes.join("\n")).toContain("Status: running")
      expect(writes.join("\n")).toContain("codex output")
      expect(writes.join("\n")).not.toContain("Smoke result:")
    } finally {
      vi.useRealTimers()
    }
  })
})
