import { vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function makeContext(sessionID: string, messageID = "message-1") {
  return {
    sessionID,
    messageID,
    agent: "test-agent",
    permissions: {
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
      task: "deny",
    },
    directory: "D:/Omni-Opencode/.worktrees/pty-monitor",
    worktree: "D:/Omni-Opencode/.worktrees/pty-monitor",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }
}

type Backend = "claude-code" | "codex"

function runtimeMonitorSessionId(runtimeKind: LoadDelegationPluginOptions["runtimeKind"], jobId: string, monitorSessionId?: string): string | undefined {
  return runtimeKind === "windows-psmux" ? (monitorSessionId ?? jobId) : undefined
}

function runtimeMonitorAttach(runtimeKind: LoadDelegationPluginOptions["runtimeKind"], jobId: string, monitorSessionId?: string) {
  const sessionId = runtimeMonitorSessionId(runtimeKind, jobId, monitorSessionId)
  return runtimeKind === "windows-psmux"
    ? { mode: "pty" as const, target: `${sessionId}:dashboard` }
    : { mode: "pty" as const, target: `${jobId}-pty` }
}

function runtimeMonitorAttachCommand(runtimeKind: LoadDelegationPluginOptions["runtimeKind"], jobId: string, monitorSessionId?: string): string | undefined {
  const sessionId = runtimeMonitorSessionId(runtimeKind, jobId, monitorSessionId)
  return runtimeKind === "windows-psmux" && sessionId ? `psmux attach -t ${sessionId}` : undefined
}

type LoadDelegationPluginOptions = {
  runtimeKind?: "windows-psmux" | "windows-pty" | "tmux"
  includeMessageCreate?: boolean
  stateName: string
  nextJobId?: (backend: Backend, launchCount: number) => string
}

export async function loadDelegationPlugin(options: LoadDelegationPluginOptions) {
  vi.resetModules()

  let launchCount = 0
  const nextJobId = options.nextJobId ?? ((backend: Backend) => backend === "claude-code" ? "claude-job-1" : "codex-job-1")
  const runtime = {
    start: vi.fn(async ({ backend, command, monitorSessionId }: { backend: Backend; command: string; monitorSessionId?: string }) => {
      launchCount += 1
      const jobId = nextJobId(backend, launchCount)
      const attach = runtimeMonitorAttach(options.runtimeKind, jobId, monitorSessionId)
      const attachCommand = runtimeMonitorAttachCommand(options.runtimeKind, jobId, monitorSessionId)
      return {
        id: jobId,
        backend,
        command,
        status: "running" as const,
        monitor: {
          id: `${(options.runtimeKind === "windows-psmux" ? monitorSessionId ?? jobId : jobId)}-monitor`,
          sessionId: runtimeMonitorSessionId(options.runtimeKind, jobId, monitorSessionId),
          attach,
          attachCommand,
          launch: { command: attachCommand ?? command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }
    }),
    read: vi.fn(async () => ({ data: "" })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ jobs: [] })),
    openMonitor: vi.fn(async (lookup: { type: "job"; jobId: string } | { type: "shared-session"; monitorSessionId: string }) => ({
      id: `${lookup.type === "job" ? lookup.jobId : lookup.monitorSessionId}-monitor`,
      sessionId: lookup.type === "shared-session" ? lookup.monitorSessionId : undefined,
      attach: lookup.type === "shared-session"
        ? { mode: "pty" as const, target: `${lookup.monitorSessionId}:dashboard` }
        : { mode: "pty" as const, target: `${lookup.jobId}-pty` },
      attachCommand: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : undefined,
      launch: {
        command: lookup.type === "shared-session" ? `psmux attach -t ${lookup.monitorSessionId}` : `attached ${lookup.jobId}`,
        cwd: "D:/Omni-Opencode/.worktrees/pty-monitor",
      },
    })),
  }

  vi.doMock("../../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: options.runtimeKind ?? "windows-pty",
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: Backend; command: string; monitorSessionId?: string }) => {
        const job = await runtime.start(params)
        const monitor = options.runtimeKind === "windows-psmux" && params.monitorSessionId
          ? await runtime.openMonitor({ type: "shared-session", monitorSessionId: params.monitorSessionId })
          : await runtime.openMonitor({ type: "job", jobId: job.id })
        return { job, monitor }
      },
      }),
  }))

  const { OmniOpencodePlugin } = await import("../../src/plugin.js")
  const client = {
    session: {
      create: vi.fn(),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    ...(options.includeMessageCreate === false
      ? {}
      : {
          message: {
            create: vi.fn().mockResolvedValue(undefined),
          },
        }),
  }
  const plugin = await OmniOpencodePlugin({
    client: client as never,
    directory: uniqueStateDir(options.stateName),
  } as never)

  return { plugin, client, runtime }
}
