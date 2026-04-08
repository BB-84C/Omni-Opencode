import * as nodePty from "node-pty"
import { pathToFileURL } from "node:url"

export type WindowsPtyProofBackend = "codex" | "claude-code"

export type WindowsPtyProofChild = {
  pid: number
  kill(): void
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: { exitCode?: number }) => void): void
}

export type WindowsPtyProofSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string },
) => WindowsPtyProofChild

export type WindowsPtyProofPane = {
  id: string
  label: string
  backend: WindowsPtyProofBackend
  prompt: string
  command: string
  launch: {
    kind: "pty-child"
    shell: "powershell.exe"
    args: ["-NoLogo", "-NoProfile", "-Command", string]
  }
}

export type WindowsPtyProofChildSpec = {
  paneId: string
  backend: WindowsPtyProofBackend
  shell: "powershell.exe"
  args: ["-NoLogo", "-NoProfile", "-Command", string]
}

export type WindowsPtyProofDefinition = {
  launchMode: "direct-pty"
  panes: WindowsPtyProofPane[]
  ptyChildren: WindowsPtyProofChildSpec[]
}

export type RunningWindowsPtyProofPane = {
  pane: WindowsPtyProofPane
  child: WindowsPtyProofChild
}

export type RunningWindowsPtyProof = {
  panes: RunningWindowsPtyProofPane[]
  stop(): void
}

export type StartWindowsPtyProofOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  spawnPty?: WindowsPtyProofSpawn
  onPaneData?: (paneId: string, chunk: string) => void
  onPaneExit?: (paneId: string, exitCode: number) => void
}

export type RunWindowsPtyProofSmokeOptions = StartWindowsPtyProofOptions & {
  durationMs?: number
}

export type WindowsPtyProofPaneStatus = "idle" | "running" | "done" | "error"

export type WindowsPtyProofPaneRenderState = {
  paneId: string
  status: WindowsPtyProofPaneStatus
  buffer: string
}

export type WindowsPtyProofSmokeTransition = {
  paneId: string
  status: Extract<WindowsPtyProofPaneStatus, "running" | "done" | "error">
}

export type WindowsPtyProofSmokeResult = {
  stopReason: "all-exited" | "timeout"
  stateTransitions: WindowsPtyProofSmokeTransition[]
  outputByPaneId: Record<string, string>
  exitCodesByPaneId: Record<string, number>
}

export type RunWindowsPtyProofCliOptions = RunWindowsPtyProofSmokeOptions & {
  write?: (message: string) => void
  clear?: () => void
}

export type WindowsPtyProofLiveResult = {
  stopReason: "all-exited" | "timeout"
  paneStates: WindowsPtyProofPaneRenderState[]
}

const smokeShutdownGraceMs = 1000

const paneBlueprints = [
  {
    id: "codex-1",
    label: "Codex 1",
    backend: "codex",
    prompt: "Inspect the repository and report the current runtime architecture.",
  },
  {
    id: "codex-2",
    label: "Codex 2",
    backend: "codex",
    prompt: "Review the Windows PTY proof plan and identify implementation checkpoints.",
  },
  {
    id: "codex-3",
    label: "Codex 3",
    backend: "codex",
    prompt: "Trace how direct PTY ownership differs from monitor attach semantics in this repo.",
  },
  {
    id: "claude-1",
    label: "Claude 1",
    backend: "claude-code",
    prompt: "Summarize the risks and open questions for a standalone Windows PTY multiplexer proof.",
  },
  {
    id: "claude-2",
    label: "Claude 2",
    backend: "claude-code",
    prompt: "List the validation steps required before running a five-pane live proof on Windows.",
  },
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  backend: WindowsPtyProofBackend
  prompt: string
}>

export function defineWindowsPtyProof(): WindowsPtyProofDefinition {
  const panes = paneBlueprints.map((pane): WindowsPtyProofPane => {
    const command = buildDelegationCommand(pane.backend, pane.prompt)

    return {
      ...pane,
      command,
      launch: {
        kind: "pty-child",
        shell: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command", command],
      },
    }
  })

  return {
    launchMode: "direct-pty",
    panes,
    ptyChildren: panes.map((pane) => ({
      paneId: pane.id,
      backend: pane.backend,
      shell: pane.launch.shell,
      args: pane.launch.args,
    })),
  }
}

export function renderWindowsPtyProofTerminal(
  proof: WindowsPtyProofDefinition,
  paneStates: WindowsPtyProofPaneRenderState[],
): string {
  const stateByPaneId = new Map(paneStates.map((paneState) => [paneState.paneId, paneState]))

  return proof.panes
    .map((pane) => {
      const paneState = stateByPaneId.get(pane.id)
      const status = paneState?.status ?? "idle"
      const buffer = paneState?.buffer ?? ""

      return [`=== ${pane.label} ===`, `Status: ${status}`, buffer].join("\n")
    })
    .join("\n\n")
}

function buildDelegationCommand(backend: WindowsPtyProofBackend, prompt: string): string {
  const escapedPrompt = JSON.stringify(prompt)
  return backend === "claude-code"
    ? `claude --print ${escapedPrompt}`
    : `codex exec --color never ${escapedPrompt}`
}

export function startWindowsPtyProof(
  proof: WindowsPtyProofDefinition,
  options: StartWindowsPtyProofOptions = {},
): RunningWindowsPtyProof {
  const spawnPty = options.spawnPty ?? (nodePty.spawn as WindowsPtyProofSpawn)

  const panes = proof.panes.map((pane) => {
    const child = spawnPty(pane.launch.shell, pane.launch.args, {
      cwd: options.cwd,
      env: options.env,
      name: "xterm-color",
    })

    child.onData((chunk) => {
      options.onPaneData?.(pane.id, chunk)
    })

    child.onExit((event) => {
      options.onPaneExit?.(pane.id, event.exitCode ?? 0)
    })

    return {
      pane,
      child,
    }
  })

  return {
    panes,
    stop() {
      for (const pane of panes) {
        pane.child.kill()
      }
    },
  }
}

export function runWindowsPtyProofSmoke(
  proof: WindowsPtyProofDefinition,
  options: RunWindowsPtyProofSmokeOptions = {},
): Promise<WindowsPtyProofSmokeResult> {
  return new Promise((resolve) => {
    const stateTransitions: WindowsPtyProofSmokeTransition[] = []
    const outputByPaneId = Object.fromEntries(proof.panes.map((pane) => [pane.id, ""])) as Record<string, string>
    const exitCodesByPaneId: Record<string, number> = {}
    const remainingPaneIds = new Set(proof.panes.map((pane) => pane.id))

    let stopReason: WindowsPtyProofSmokeResult["stopReason"] = "all-exited"
    let resolved = false
    let timeout: NodeJS.Timeout | undefined
    let forcedFinishTimeout: NodeJS.Timeout | undefined

    const finish = () => {
      if (resolved) {
        return
      }

      resolved = true
      if (timeout) {
        clearTimeout(timeout)
      }
      if (forcedFinishTimeout) {
        clearTimeout(forcedFinishTimeout)
      }

      resolve({
        stopReason,
        stateTransitions: stateTransitions.map((transition) => ({ ...transition })),
        outputByPaneId: { ...outputByPaneId },
        exitCodesByPaneId: { ...exitCodesByPaneId },
      })
    }

    const runningProof = startWindowsPtyProof(proof, {
      ...options,
      onPaneData(paneId, chunk) {
        if (resolved) {
          return
        }

        outputByPaneId[paneId] += chunk
        options.onPaneData?.(paneId, chunk)
      },
      onPaneExit(paneId, exitCode) {
        if (resolved || !remainingPaneIds.has(paneId)) {
          return
        }

        exitCodesByPaneId[paneId] = exitCode
        remainingPaneIds.delete(paneId)
        stateTransitions.push({ paneId, status: exitCode === 0 ? "done" : "error" })
        options.onPaneExit?.(paneId, exitCode)

        if (remainingPaneIds.size === 0) {
          finish()
        }
      },
    })

    for (const pane of runningProof.panes) {
      stateTransitions.push({ paneId: pane.pane.id, status: "running" })
    }

    if (options.durationMs !== undefined) {
      timeout = setTimeout(() => {
        stopReason = "timeout"
        runningProof.stop()

        if (remainingPaneIds.size === 0) {
          finish()
          return
        }

        forcedFinishTimeout = setTimeout(() => {
          finish()
        }, smokeShutdownGraceMs)
      }, options.durationMs)
    }
  })
}

export function runWindowsPtyProofLive(
  proof: WindowsPtyProofDefinition,
  options: RunWindowsPtyProofCliOptions = {},
): Promise<WindowsPtyProofLiveResult> {
  return new Promise((resolve) => {
    const paneStates = new Map<string, WindowsPtyProofPaneRenderState>(
      proof.panes.map((pane) => [pane.id, { paneId: pane.id, status: "idle", buffer: "" }]),
    )
    const remainingPaneIds = new Set(proof.panes.map((pane) => pane.id))
    const write = options.write ?? ((message: string) => process.stdout.write(message))
    const clear = options.clear ?? (() => process.stdout.write("\x1bc"))

    let resolved = false
    let timeout: NodeJS.Timeout | undefined
    let forcedFinishTimeout: NodeJS.Timeout | undefined

    const render = () => {
      clear()
      write(`${renderWindowsPtyProofTerminal(proof, [...paneStates.values()])}\n`)
    }

    const finish = (stopReason: WindowsPtyProofLiveResult["stopReason"]) => {
      if (resolved) {
        return
      }

      resolved = true
      if (timeout) {
        clearTimeout(timeout)
      }
      if (forcedFinishTimeout) {
        clearTimeout(forcedFinishTimeout)
      }

      resolve({
        stopReason,
        paneStates: [...paneStates.values()].map((paneState) => ({ ...paneState })),
      })
    }

    const runningProof = startWindowsPtyProof(proof, {
      ...options,
      onPaneData(paneId, chunk) {
        if (resolved) {
          return
        }

        const paneState = paneStates.get(paneId)
        if (!paneState) {
          return
        }

        paneState.status = "running"
        paneState.buffer = trimProofBuffer(`${paneState.buffer}${scrubProofOutput(chunk)}`)
        options.onPaneData?.(paneId, chunk)
        render()
      },
      onPaneExit(paneId, exitCode) {
        if (resolved || !remainingPaneIds.has(paneId)) {
          return
        }

        remainingPaneIds.delete(paneId)
        const paneState = paneStates.get(paneId)
        if (paneState) {
          paneState.status = exitCode === 0 ? "done" : "error"
          paneState.buffer = trimProofBuffer(`${paneState.buffer}\n[exit ${exitCode}]`)
        }

        options.onPaneExit?.(paneId, exitCode)
        render()

        if (remainingPaneIds.size === 0) {
          finish(timeout ? "timeout" : "all-exited")
        }
      },
    })

    for (const pane of proof.panes) {
      const paneState = paneStates.get(pane.id)
      if (paneState) {
        paneState.status = "running"
      }
    }

    render()

    if (options.durationMs !== undefined) {
      timeout = setTimeout(() => {
        runningProof.stop()

        if (remainingPaneIds.size === 0) {
          finish("timeout")
          return
        }

        forcedFinishTimeout = setTimeout(() => {
          finish("timeout")
        }, smokeShutdownGraceMs)
      }, options.durationMs)
    }
  })
}

export async function runWindowsPtyProofCli(
  args: string[],
  options: RunWindowsPtyProofCliOptions = {},
): Promise<WindowsPtyProofSmokeResult | WindowsPtyProofLiveResult> {
  if (!args.includes("--smoke")) {
    return await runWindowsPtyProofLive(defineWindowsPtyProof(), options)
  }

  const result = await runWindowsPtyProofSmoke(defineWindowsPtyProof(), {
    ...options,
    durationMs: options.durationMs ?? 1000,
  })

  const write = options.write ?? ((message: string) => process.stdout.write(message))
  write(`Smoke result: ${result.stopReason}\n`)
  return result
}

function scrubProofOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9:;<=>?]*[ -/]*[@-~]/g, "")
}

function trimProofBuffer(value: string): string {
  const lines = value.split(/\r?\n/)
  return lines.slice(-20).join("\n")
}

function isWindowsPtyProofEntrypoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false
  }

  return importMetaUrl === pathToFileURL(argv1).href
}

if (isWindowsPtyProofEntrypoint(import.meta.url, process.argv[1])) {
  void runWindowsPtyProofCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
