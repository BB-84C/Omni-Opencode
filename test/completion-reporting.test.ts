import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(sessionID: string) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "test-agent",
    directory: "D:/Omni-Opencode/.worktrees/pty-monitor",
    worktree: "D:/Omni-Opencode/.worktrees/pty-monitor",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }
}

type LoadPluginOptions = {
  directory?: string
  omitMessageCreate?: boolean
  omitPromptAsync?: boolean
  rejectMessageCreate?: boolean
  rejectRuntimeRead?: boolean
  rejectCompletedSave?: boolean
  readOutputByJobId?: Record<string, string[]>
  snapshotJobs?: Array<{
    id: string
    backend: "claude-code" | "codex"
    command: string
    status: "running" | "stopped"
    monitor: {
      id: string
      attach: { mode: "pty"; target: string }
      launch: { command: string; cwd: string }
    }
  }>
}

async function loadPlugin(options: LoadPluginOptions = {}) {
  vi.resetModules()
  const directory = options.directory ?? uniqueStateDir("completion-reporting")
  const transcriptCaptureTarget = join(directory, ".omni-monitors", "claude-job-1.log").replace(/\\/g, "/")

  const readOutputByJobId = new Map(
    Object.entries(options.readOutputByJobId ?? {
      "claude-job-1": [JSON.stringify({
        finalReport: {
          summary: "Patched PTY completion reporting",
          changedFiles: ["src/plugin.ts", "test/completion-reporting.test.ts"],
        },
      })],
    }),
  )

  if (options.rejectCompletedSave) {
    const records = new Map<string, Record<string, unknown>>()
    vi.doMock("../src/core/store.js", () => ({
      createJobStore: () => ({
        save: vi.fn(async (record: Record<string, unknown>) => {
          if (record.status === "completed") {
            throw new Error("completed save failed")
          }
          records.set(String(record.jobId), record)
        }),
        get: vi.fn(async (jobId: string) => records.get(jobId)),
        list: vi.fn(async () => Array.from(records.values())),
        remove: vi.fn(async (jobId: string) => {
          records.delete(jobId)
        }),
      }),
    }))
  }

  let snapshotCalls = 0
  const runtime = {
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => ({
      id: backend === "claude-code" ? "claude-job-1" : "codex-job-1",
      backend,
      command,
      status: "running" as const,
      monitor: {
        id: `${backend}-monitor-1`,
        attach: { mode: "pty" as const, target: `${backend}-pty-1` },
        launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
      },
    })),
    read: options.rejectRuntimeRead
      ? vi.fn(async () => {
          throw new Error("runtime read failed")
        })
      : vi.fn(async (jobId: string) => ({
          data: readOutputByJobId.get(jobId)?.shift() ?? "",
        })),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => {
      snapshotCalls += 1

      if (options.snapshotJobs) {
        return {
          jobs: snapshotCalls >= 2
            ? options.snapshotJobs
            : [{
                id: "claude-job-1",
                backend: "claude-code" as const,
                command: 'claude --print "report back"',
                status: "running" as const,
                monitor: {
                  id: "monitor-parent-session-1",
                  sessionId: "parent-session-1",
                  attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
                  attachCommand: "psmux attach -t parent-session-1",
                  transcriptCaptureTarget,
                  launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
                },
              }],
        }
      }

      return {
        jobs: [{
          id: "claude-job-1",
          backend: "claude-code" as const,
          command: "claude --print \"report back\"",
          status: snapshotCalls >= 2 ? "stopped" as const : "running" as const,
          monitor: {
            id: "monitor-parent-session-1",
            sessionId: "parent-session-1",
            attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
            attachCommand: "psmux attach -t parent-session-1",
            transcriptCaptureTarget,
            launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
          },
        }],
      }
    }),
    openMonitor: vi.fn(async (jobId: string) => ({
      id: "monitor-parent-session-1",
      sessionId: "parent-session-1",
      attach: { mode: "pty" as const, target: "parent-session-1:dashboard" },
      attachCommand: "psmux attach -t parent-session-1",
      transcriptCaptureTarget: join(directory, ".omni-monitors", `${jobId}.log`).replace(/\\/g, "/"),
      launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
    })),
  }

  vi.doMock("../src/runtime/select-runtime.js", () => ({
    selectRuntime: () => ({
      kind: "windows-psmux" as const,
      runtime,
      autoOpenMonitor: true,
      start: async (params: { backend: "claude-code" | "codex"; command: string }) => {
        const job = await runtime.start(params)
        const monitor = await runtime.openMonitor(job.id)
        return { job, monitor }
      },
    }),
  }))

  const { OmniOpencodePlugin } = await import("../src/plugin.js")
  const client = {
    session: {
      create: vi.fn(),
      ...(options.omitPromptAsync ? {} : { promptAsync: vi.fn() }),
    },
    ...(options.omitMessageCreate
      ? {}
      : {
          message: {
            create: options.rejectMessageCreate
              ? vi.fn().mockRejectedValue(new Error("message write failed"))
              : vi.fn().mockResolvedValue(undefined),
          },
        }),
  }
  const plugin = await OmniOpencodePlugin({
    client: client as never,
    directory,
  } as never)

  return { plugin, client, runtime, directory, transcriptCaptureTarget }
}

describe("completion reporting", () => {
  it("posts one aggregate user follow-up with inspection references when a batch completes", async () => {
    const { plugin, client } = await loadPlugin()

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledWith({
        sessionId: "parent-session-1",
        role: "user",
        content: expect.stringContaining("parent-session-1:message-1"),
      })
    })

    expect(client.session.promptAsync).not.toHaveBeenCalled()

    const completionUpdate = vi.mocked(client.message!.create).mock.calls[0]?.[0]?.content
    expect(vi.mocked(client.message!.create)).toHaveBeenCalledTimes(1)
    expect(completionUpdate).toContain("parent-session-1:message-1")
    expect(completionUpdate).toContain("claude-code")
    expect(completionUpdate).toContain("parent-session-1:claude-job-1")
    expect(completionUpdate).toContain("completed")
    expect(completionUpdate).toContain("Patched PTY completion reporting")
    expect(completionUpdate).toContain("delegated_job_snapshot")
    expect(completionUpdate).toContain("delegated_job_read")
    expect(completionUpdate).toContain("delegated_job_attach")
    expect(completionUpdate).toContain("psmux attach -t parent-session-1")

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(snapshot).toContain('"changedFiles": [')
  })

  it("falls back to session.promptAsync when message.create is unavailable", async () => {
    const { plugin, client } = await loadPlugin({ omitMessageCreate: true })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: "parent-session-1:claude-job-1" },
        makeContext("parent-session-1") as never,
      )

      expect(snapshot).toContain('"status": "completed"')
      expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    })

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "parent-session-1" },
      body: {
        parts: [{ type: "text", text: expect.stringContaining("parent-session-1:message-1") }],
      },
      query: { directory: expect.stringContaining("completion-reporting") },
    })
    expect("message" in client).toBe(false)
  })

  it("marks the delegated job failed when the runtime disappears from snapshot", async () => {
    const { plugin, client } = await loadPlugin({ snapshotJobs: [] })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledWith({
        sessionId: "parent-session-1",
        role: "user",
        content: expect.stringContaining("failed"),
      })
    })

    const completionUpdate = vi.mocked(client.message!.create).mock.calls[0]?.[0]?.content
    expect(completionUpdate).toContain("parent-session-1:message-1")
    expect(completionUpdate).toContain("failed")
    expect(completionUpdate).toContain("delegated_job_snapshot")

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "failed"')
  })

  it("keeps the completed job state when the aggregate follow-up injection fails", async () => {
    const { plugin, client } = await loadPlugin({ rejectMessageCreate: true })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledOnce()
    })

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(snapshot).toContain('aggregate follow-up could not be injected: message write failed')
  })

  it("records an explicit reporting failure when no parent session reporting api is available", async () => {
    const { plugin } = await loadPlugin({ omitMessageCreate: true, omitPromptAsync: true })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: "parent-session-1:claude-job-1" },
        makeContext("parent-session-1") as never,
      )

      expect(snapshot).toContain('aggregate follow-up could not be injected: no parent session reporting api is available')
      expect(snapshot).toContain('"status": "completed"')
    })
  })

  it("persists an explicit failure signal when the background monitor crashes", async () => {
    const { plugin } = await loadPlugin({ rejectRuntimeRead: true })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: "parent-session-1:claude-job-1" },
        makeContext("parent-session-1") as never,
      )

      expect(snapshot).toContain('"status": "failed"')
      expect(snapshot).toContain('runtime read failed')
      expect(snapshot).toContain('Background completion monitor crashed')
    })
  })

  it("keeps snapshot and list consistent when persistence fails after a successful parent update", async () => {
    const directory = uniqueStateDir("completion-reporting-durable")
    const { plugin, client } = await loadPlugin({ rejectCompletedSave: true, directory })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledWith({
        sessionId: "parent-session-1",
        role: "user",
        content: expect.stringContaining("completed"),
      })
    })

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    const listedJobs = await plugin.tool!.delegated_jobs_list.execute(
      {},
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(snapshot).not.toContain('Background completion monitor crashed: completed save failed')
    expect(listedJobs).toContain('parent-session-1:claude-job-1 [claude-code] status=completed')

    const reloaded = await loadPlugin({ directory })
    const reloadedSnapshot = await reloaded.plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )
    const reloadedListedJobs = await reloaded.plugin.tool!.delegated_jobs_list.execute(
      {},
      makeContext("parent-session-1") as never,
    )

    expect(reloadedSnapshot).toContain('"status": "completed"')
    expect(reloadedSnapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(reloadedListedJobs).toContain('parent-session-1:claude-job-1 [claude-code] status=completed')
  })

  it("reads completed psmux transcript output from the persisted capture path after reload", async () => {
    const finalReport = JSON.stringify({
      finalReport: {
        summary: "Patched PTY completion reporting",
        changedFiles: ["src/plugin.ts", "test/completion-reporting.test.ts"],
      },
    })
    const followUp = "follow-up transcript chunk\n"
    const directory = uniqueStateDir("completion-reporting-psmux-reload")
    const { plugin, client, transcriptCaptureTarget } = await loadPlugin({
      directory,
      readOutputByJobId: {
        "claude-job-1": [finalReport, followUp],
      },
    })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledWith({
        sessionId: "parent-session-1",
        role: "user",
        content: expect.stringContaining("completed"),
      })
    })

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )
    const readOutput = await plugin.tool!.delegated_job_read.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(snapshot).toContain(`"transcriptCaptureTarget": "${transcriptCaptureTarget}"`)

    await mkdir(join(directory, ".omni-monitors"), { recursive: true })
    await writeFile(transcriptCaptureTarget, `${finalReport}\n${followUp}__OMNI_OPENCODE_PSMUX_EXIT__:0\n`, "utf8")

    const reloaded = await loadPlugin({ directory, readOutputByJobId: { "claude-job-1": [] } })
    const reloadedReadOutput = await reloaded.plugin.tool!.delegated_job_read.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(reloadedReadOutput).toContain('"summary":"Patched PTY completion reporting"')
    expect(reloadedReadOutput).toContain(followUp)
    expect(reloadedReadOutput).not.toContain("__OMNI_OPENCODE_PSMUX_EXIT__")
  })
})
