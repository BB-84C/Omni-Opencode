import { afterEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"

type MockProofPtyChild = {
  pid: number
  kill: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
}

function createMockProofPtyChild(pid: number): MockProofPtyChild {
  return {
    pid,
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  }
}

const expectedPaneDefinitions = [
  {
    id: "codex-1",
    label: "Codex 1",
    backend: "codex",
    prompt: "Inspect the repository and report the current runtime architecture.",
    command: 'codex exec --color never "Inspect the repository and report the current runtime architecture."',
  },
  {
    id: "codex-2",
    label: "Codex 2",
    backend: "codex",
    prompt: "Review the Windows PTY proof plan and identify implementation checkpoints.",
    command: 'codex exec --color never "Review the Windows PTY proof plan and identify implementation checkpoints."',
  },
  {
    id: "codex-3",
    label: "Codex 3",
    backend: "codex",
    prompt: "Trace how direct PTY ownership differs from monitor attach semantics in this repo.",
    command: 'codex exec --color never "Trace how direct PTY ownership differs from monitor attach semantics in this repo."',
  },
  {
    id: "claude-1",
    label: "Claude 1",
    backend: "claude-code",
    prompt: "Summarize the risks and open questions for a standalone Windows PTY multiplexer proof.",
    command: 'claude --print "Summarize the risks and open questions for a standalone Windows PTY multiplexer proof."',
  },
  {
    id: "claude-2",
    label: "Claude 2",
    backend: "claude-code",
    prompt: "List the validation steps required before running a five-pane live proof on Windows.",
    command: 'claude --print "List the validation steps required before running a five-pane live proof on Windows."',
  },
] as const

async function loadWindowsPtyProofModule() {
  return import("../scripts/windows-pty-multiplexer-proof")
}

async function readWindowsPtyProofSource() {
  return readFile(new URL("../scripts/windows-pty-multiplexer-proof.ts", import.meta.url), "utf8")
}

async function loadWindowsPtyProofModuleWithSpawn(spawn: ReturnType<typeof vi.fn>) {
  vi.doMock("node-pty", () => ({ spawn }))
  const module = await import("../scripts/windows-pty-multiplexer-proof")
  return module
}

afterEach(() => {
  vi.doUnmock("node-pty")
  vi.resetModules()
  vi.restoreAllMocks()
})

describe("windows PTY multiplexer standalone proof contract", () => {
  it("defines five panes for the standalone proof", async () => {
    const { defineWindowsPtyProof } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()

    expect(proof.panes).toHaveLength(5)
  })

  it("allocates three Codex panes and two Claude panes", async () => {
    const { defineWindowsPtyProof } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()
    const backendCounts = proof.panes.reduce((counts: Record<string, number>, pane: { backend: string }) => {
      counts[pane.backend] = (counts[pane.backend] ?? 0) + 1
      return counts
    }, {})

    expect(backendCounts).toEqual({
      codex: 3,
      "claude-code": 2,
    })
  })

  it("defines exact pane labels, backends, prompts, and commands", async () => {
    const { defineWindowsPtyProof } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()

    expect(proof.panes).toEqual(expectedPaneDefinitions.map((pane) => ({
      ...pane,
      launch: {
        kind: "pty-child",
        shell: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command", pane.command],
      },
    })))
  })

  it("uses direct PTY child launch definitions instead of monitor attach or log-tail semantics", async () => {
    const { defineWindowsPtyProof } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()
    const launchKinds = proof.panes.map((pane: { launch: { kind: string } }) => pane.launch.kind)

    expect(proof.launchMode).toBe("direct-pty")
    expect(launchKinds).toEqual(["pty-child", "pty-child", "pty-child", "pty-child", "pty-child"])
    expect(launchKinds).not.toContain("monitor-attach")
    expect(launchKinds).not.toContain("log-tail")
  })

  it("defines one PTY child spec per pane", async () => {
    const { defineWindowsPtyProof } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()

    expect(proof.ptyChildren).toEqual(expectedPaneDefinitions.map((pane) => ({
      paneId: pane.id,
      backend: pane.backend,
      shell: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", pane.command],
    })))
  })

  it("spawns one PTY child per pane", async () => {
    const children = expectedPaneDefinitions.map((_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawn = vi.fn(() => children[spawnIndex++])

    const { defineWindowsPtyProof, startWindowsPtyProof } = await loadWindowsPtyProofModuleWithSpawn(spawn)

    const proof = defineWindowsPtyProof()
    const runningProof = startWindowsPtyProof(proof)

    expect(spawn).toHaveBeenCalledTimes(proof.panes.length)
    expect(spawn.mock.calls).toEqual(proof.panes.map((pane) => [
      pane.launch.shell,
      pane.launch.args,
      {
        name: "xterm-color",
      },
    ]))
    expect(runningProof.panes.map((pane) => pane.child.pid)).toEqual([1, 2, 3, 4, 5])
  })

  it("attaches output handlers directly to each PTY child", async () => {
    const children = expectedPaneDefinitions.map((_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawn = vi.fn(() => children[spawnIndex++])

    const { defineWindowsPtyProof, startWindowsPtyProof } = await loadWindowsPtyProofModuleWithSpawn(spawn)

    const receivedChunks: Array<{ paneId: string; chunk: string }> = []
    const runningProof = startWindowsPtyProof(defineWindowsPtyProof(), {
      onPaneData(paneId, chunk) {
        receivedChunks.push({ paneId, chunk })
      },
    })

    expect(children.every((child) => child.onData.mock.calls.length === 1)).toBe(true)

    runningProof.panes.forEach((pane, index) => {
      const listener = children[index].onData.mock.calls[0]?.[0] as ((chunk: string) => void) | undefined
      expect(typeof listener).toBe("function")
      listener?.(`${pane.pane.id}:ready`)
    })

    expect(receivedChunks).toEqual(runningProof.panes.map((pane) => ({
      paneId: pane.pane.id,
      chunk: `${pane.pane.id}:ready`,
    })))
  })

  it("uses the direct PTY path through the cleaned-up proof start options", async () => {
    const children = expectedPaneDefinitions.map((_, index) => createMockProofPtyChild(index + 1))
    let spawnIndex = 0
    const spawnPty = vi.fn(() => children[spawnIndex++])

    const { defineWindowsPtyProof, startWindowsPtyProof } = await loadWindowsPtyProofModuleWithSpawn(vi.fn())

    const runningProof = startWindowsPtyProof(defineWindowsPtyProof(), { spawnPty })

    expect(spawnPty).toHaveBeenCalledTimes(runningProof.panes.length)
  })

  it("does not declare monitor or log-follow helper options in the standalone proof script", async () => {
    const source = await readWindowsPtyProofSource()

    expect(source).not.toContain("attachMonitor?:")
    expect(source).not.toContain("followLogs?:")
  })

})
