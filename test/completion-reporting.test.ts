import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

function uniqueStateDir(name: string): string {
  return `D:/Omni-Opencode/.worktrees/pty-monitor/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeContext(
  sessionID: string,
  permissions?: Partial<Record<"edit" | "bash" | "webfetch" | "task", "allow" | "ask" | "deny">>,
) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "test-agent",
    directory: "D:/Omni-Opencode/.worktrees/pty-monitor",
    worktree: "D:/Omni-Opencode/.worktrees/pty-monitor",
    permissions,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  }
}

type SnapshotJob = {
  id: string
  backend: "claude-code" | "codex"
  command: string
  status: "running" | "stopped"
  monitor: {
    id: string
    attach: { mode: "pty"; target: string }
    launch: { command: string; cwd: string }
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
  snapshotJobs?: SnapshotJob[]
  snapshotJobsByCall?: SnapshotJob[][]
}

async function loadPlugin(options: LoadPluginOptions = {}) {
  vi.resetModules()
  const directory = options.directory ?? uniqueStateDir("completion-reporting")
  const transcriptCaptureTarget = join(directory, ".omni-monitors", "claude-job-1.log").replace(/\\/g, "/")
  const launchCounts = new Map<"claude-code" | "codex", number>()

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
    start: vi.fn(async ({ backend, command }: { backend: "claude-code" | "codex"; command: string }) => {
      const nextCount = (launchCounts.get(backend) ?? 0) + 1
      launchCounts.set(backend, nextCount)
      const runtimeJobId = backend === "claude-code" ? `claude-job-${nextCount}` : `codex-job-${nextCount}`

      return {
        id: runtimeJobId,
        backend,
        command,
        status: "running" as const,
        backendSessionId: backend === "claude-code" ? "claude-session-123" : "codex-session-123",
        backendResumeSessionId: backend === "claude-code" ? "claude-resume-123" : "codex-session-123",
        monitor: {
          id: `${backend}-monitor-${nextCount}`,
          attach: { mode: "pty" as const, target: `${backend}-pty-${nextCount}` },
          launch: { command, cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
        },
      }
    }),
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

      if (options.snapshotJobsByCall) {
        const jobs = options.snapshotJobsByCall[Math.min(snapshotCalls - 1, options.snapshotJobsByCall.length - 1)] ?? []
        return { jobs }
      }

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
        content: expect.stringContaining("parent-session-1"),
      })
    })

    expect(client.session.promptAsync).not.toHaveBeenCalled()

    const completionUpdate = vi.mocked(client.message!.create).mock.calls[0]?.[0]?.content
    expect(vi.mocked(client.message!.create)).toHaveBeenCalledTimes(1)
    expect(completionUpdate).toContain("parent-session-1")
    expect(completionUpdate).toContain("claude-code")
    expect(completionUpdate).toContain("parent-session-1:claude-job-1")
    expect(completionUpdate).toContain("completed")
    expect(completionUpdate).toContain("delegated_job_snapshot")
    expect(completionUpdate).toContain("delegated_job_read")
    expect(completionUpdate).toContain("delegated_job_attach")
    expect(completionUpdate).not.toContain("Patched PTY completion reporting")

    const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
      { jobId: "parent-session-1:claude-job-1" },
      makeContext("parent-session-1") as never,
    )

    expect(snapshot).toContain('"status": "completed"')
    expect(snapshot).toContain('"summary": "Patched PTY completion reporting"')
    expect(snapshot).toContain('"changedFiles": [')
    expect(snapshot).toContain('"backendSessionId": "claude-session-123"')
    expect(snapshot).toContain('"backendResumeSessionId": "claude-resume-123"')
    expect(snapshot).toContain('"correlationMarker": "omni-opencode:parent-session-1:message-1:claude-code"')
    expect(snapshot).toContain('"promptFingerprint": "')
  })

  it("waits for every job in a mixed terminal batch and injects a concise follow-up with inspection references", async () => {
    const verboseSummary = [
      "Structured completion report follows.",
      "FULL REPORT BODY START",
      "line 1: changed src/plugin.ts",
      "line 2: changed src/runtime/extract-report.ts",
      "line 3: changed test/completion-reporting.test.ts",
      "line 4: ran npm test -- --runInBand",
      "line 5: inspected the entire transcript for anomalies",
      "FULL REPORT BODY END",
    ].join("\n")

    const { plugin, client } = await loadPlugin({
      readOutputByJobId: {
        "claude-job-1": [JSON.stringify({
          finalReport: {
            summary: verboseSummary,
            changedFiles: ["src/plugin.ts", "test/completion-reporting.test.ts"],
          },
        })],
        "codex-job-1": [""],
      },
      snapshotJobsByCall: [
        [
          {
            id: "claude-job-1",
            backend: "claude-code",
            command: 'claude --print "report back"',
            status: "running",
            monitor: {
              id: "monitor-parent-session-1",
              attach: { mode: "pty", target: "parent-session-1:dashboard" },
              launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
            },
          },
          {
            id: "codex-job-1",
            backend: "codex",
            command: 'codex exec --color never "report back"',
            status: "running",
            monitor: {
              id: "monitor-parent-session-1",
              attach: { mode: "pty", target: "parent-session-1:dashboard" },
              launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
            },
          },
        ],
        [
          {
            id: "claude-job-1",
            backend: "claude-code",
            command: 'claude --print "report back"',
            status: "running",
            monitor: {
              id: "monitor-parent-session-1",
              attach: { mode: "pty", target: "parent-session-1:dashboard" },
              launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
            },
          },
          {
            id: "codex-job-1",
            backend: "codex",
            command: 'codex exec --color never "report back"',
            status: "running",
            monitor: {
              id: "monitor-parent-session-1",
              attach: { mode: "pty", target: "parent-session-1:dashboard" },
              launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
            },
          },
        ],
        [
          {
            id: "claude-job-1",
            backend: "claude-code",
            command: 'claude --print "report back"',
            status: "stopped",
            monitor: {
              id: "monitor-parent-session-1",
              attach: { mode: "pty", target: "parent-session-1:dashboard" },
              launch: { command: "psmux attach -t parent-session-1", cwd: "D:/Omni-Opencode/.worktrees/pty-monitor" },
            },
          },
        ],
      ],
    })

    const batchContext = makeContext("parent-session-1")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      batchContext as never,
    )
    await plugin.tool!.delegate_to_codex.execute(
      { prompt: "report back" },
      batchContext as never,
    )
    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      batchContext as never,
    )
    await plugin.tool!.delegated_job_cancel.execute(
      { jobId: "parent-session-1:claude-job-2" },
      batchContext as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledOnce()
    }, { timeout: 10000 })

    const completionUpdate = vi.mocked(client.message!.create).mock.calls[0]?.[0]?.content
    expect(completionUpdate).toContain("parent-session-1")
    expect(completionUpdate).toContain("parent-session-1:claude-job-1")
    expect(completionUpdate).toContain("parent-session-1:codex-job-1")
    expect(completionUpdate).toContain("parent-session-1:claude-job-2")
    expect(completionUpdate).toContain("completed")
    expect(completionUpdate).toContain("failed")
    expect(completionUpdate).toContain("cancelled")
    expect(completionUpdate).toContain('delegated_job_snapshot({"jobId":"parent-session-1:claude-job-1"})')
    expect(completionUpdate).toContain('delegated_job_read({"jobId":"parent-session-1:codex-job-1"})')
    expect(completionUpdate).toContain('delegated_job_attach({"jobId":"parent-session-1:claude-job-2"})')
    expect(completionUpdate).not.toContain("FULL REPORT BODY START")
    expect(completionUpdate).not.toContain("line 4: ran npm test -- --runInBand")
    expect(completionUpdate.split("\n").length).toBeLessThanOrEqual(8)
  }, 15000)

  it("keeps the injected parent follow-up concise and points to inspection tools instead of dumping the report body", async () => {
    const verboseSummary = [
      "Executive summary.",
      "FULL REPORT BODY START",
      "detail 1: inspected src/plugin.ts",
      "detail 2: inspected src/runtime/extract-report.ts",
      "detail 3: inspected test/completion-reporting.test.ts",
      "detail 4: verified runtime snapshot transitions",
      "detail 5: prepared a long narrative that should stay out of the parent message",
      "FULL REPORT BODY END",
    ].join("\n")

    const { plugin, client } = await loadPlugin({
      readOutputByJobId: {
        "claude-job-1": [JSON.stringify({
          finalReport: {
            summary: verboseSummary,
            changedFiles: ["src/plugin.ts", "test/completion-reporting.test.ts"],
          },
        })],
      },
    })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      makeContext("parent-session-1") as never,
    )

    await vi.waitFor(() => {
      expect(client.message!.create).toHaveBeenCalledOnce()
    })

    const completionUpdate = vi.mocked(client.message!.create).mock.calls[0]?.[0]?.content
    expect(completionUpdate).toContain("delegated_job_snapshot")
    expect(completionUpdate).toContain("delegated_job_read")
    expect(completionUpdate).toContain("delegated_job_attach")
    expect(completionUpdate).toContain("parent-session-1:claude-job-1")
    expect(completionUpdate).not.toContain("FULL REPORT BODY START")
    expect(completionUpdate).not.toContain("detail 5: prepared a long narrative")
    expect(completionUpdate.length).toBeLessThan(500)
  })

  it("keeps a cancelled delegated job cancelled when its runtime entry disappears during shutdown", async () => {
    const { plugin } = await loadPlugin({ snapshotJobs: [] })
    const batchContext = makeContext("parent-session-1")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "report back" },
      batchContext as never,
    )

    await plugin.tool!.delegated_job_cancel.execute(
      { jobId: "parent-session-1:claude-job-1" },
      batchContext as never,
    )

    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: "parent-session-1:claude-job-1" },
        batchContext as never,
      )

      expect(snapshot).toContain('"status": "interrupted"')
      expect(snapshot).toContain('"cleanupReason": "cancelled"')
      expect(snapshot).not.toContain('"status": "failed"')
    })
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
        parts: [{ type: "text", text: expect.stringContaining("parent-session-1") }],
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
    expect(completionUpdate).toContain("parent-session-1")
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

  it("preserves permission profile metadata in the completed job snapshot", async () => {
    const { plugin } = await loadPlugin()
    const context = makeContext("parent-session-1", {
      edit: "ask",
      bash: "ask",
      webfetch: "deny",
      task: "deny",
    })
    vi.mocked(context.ask).mockResolvedValue("allow-once")

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts and run npm test" },
      context as never,
    )

    await vi.waitFor(async () => {
      const snapshot = await plugin.tool!.delegated_job_snapshot.execute(
        { jobId: "parent-session-1:claude-job-1" },
        context as never,
      )

      expect(snapshot).toContain('"status": "completed"')
      expect(snapshot).toContain('"permissionProfile": "dangerous"')
      expect(snapshot).toContain('"approvalMode": "once"')
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
