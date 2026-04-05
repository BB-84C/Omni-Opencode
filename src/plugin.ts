/**
 * omni-opencode plugin entry point.
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 * Native Task/subagent integration uses OpenCode's own Task mechanism:
 *
 *   1. Plugin `config` hook injects `omni-claude-bridge` and `omni-codex-bridge`
 *      as `mode: "subagent"` agents.
 *   2. The parent LLM invokes these agents through OpenCode's native Task flow.
 *      OpenCode creates the child session and Task card automatically.
 *   3. Inside the wrapper child session, the bridge agent calls
 *      `omni_start_claude_job` or `omni_start_codex_job`.
 *   4. Those tools start the external backend immediately and register a
 *      pending drain, then return IMMEDIATELY so the bridge agent can finish
 *      its turn.
 *   5. When the bridge child session fires `session.idle`, the plugin `event`
 *      hook detects the pending drain and begins the projection loop.
 *      All `promptAsync(noReply:true)` writes land in a now-truly-idle session.
 *
 * ── DESIGN CONSTRAINTS ────────────────────────────────────────────────────────
 * The drain must not start until the wrapper child session is genuinely idle:
 *   • Starting inside the tool keeps the turn open → writes stall.
 *   • Starting after tool return but before bridge final answer → still racing.
 *   • Starting on `session.idle` → session is free, writes land reliably.
 * We accept the trade-off: Task card shows "done" while drain continues posting.
 *
 * ── REMOVED ───────────────────────────────────────────────────────────────────
 * `delegate_to_claude` / `delegate_to_codex` parent-facing tools are removed.
 * The parent LLM must invoke bridge agents through native Task directly.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { tool, type PluginInput, type Plugin, type Config } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { createJobStore } from "./core/store.js"
import { createClaudeClient } from "./adapters/claude-client.js"
import { createClaudeAdapter } from "./adapters/claude-adapter.js"
import { createCodexClient } from "./adapters/codex-client.js"
import { createCodexAdapter } from "./adapters/codex-adapter.js"
import { DeltaCoalescer } from "./opencode/render.js"
import type { DelegatedEvent } from "./core/events.js"
import type { Backend, JobRecord } from "./core/jobs.js"
import type { BackendAdapter, JobHandle } from "./adapters/types.js"

export const OmniOpencodePlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const stateDir = `${directory}/.broker-state`
  const store = createJobStore(stateDir)
  const claudeAdapter = createClaudeAdapter(createClaudeClient())
  const codexAdapter = createCodexAdapter(createCodexClient())

  // Plugin-scope drain registry. Keeps Promise references alive across tool-callback
  // boundaries so Bun/Node will not GC background drains.
  const activeJobs = new Map<string, Promise<string>>()

  // Pending drains: backend is started, waiting for session.idle before draining.
  // Key: childSessionId, Value: thunk that starts the drain when called.
  const pendingDrains = new Map<string, () => void>()

  // ---------------------------------------------------------------------------
  // Write a projected text entry into a session.
  // promptAsync(noReply:true) is the only public write path that does not trigger
  // an LLM response. It creates role:"user" log entries.
  // IMPORTANT: this must only be called AFTER the session is idle (session.idle
  // event has fired), otherwise the running turn holds the session and writes stall.
  // Errors are swallowed so a failed post never aborts the drain.
  // ---------------------------------------------------------------------------
  async function postToSession(sessionId: string, text: string): Promise<void> {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text }] },
    })
  }

  // ---------------------------------------------------------------------------
  // Broker drain: subscribes to adapter events, projects them into the child
  // session, checkpoints telemetry. Returns the final summary string.
  // Always triggered by session.idle event — never started before session is free.
  // ---------------------------------------------------------------------------
  async function drainStream(
    childSessionId: string,
    backend: Backend,
    handle: JobHandle,
    adapter: BackendAdapter,
  ): Promise<string> {
    let eventSeq = 0
    let lastProjectedMessage: string | undefined
    let summary: string | undefined
    const changedFiles: string[] = []
    let activeTool: string | undefined
    let activeCommand: string | undefined

    const checkpoint = async (status: JobRecord["status"]): Promise<void> => {
      await store.save({
        childSessionId,
        backend,
        backendThreadId: handle.id,
        status,
        lastEventSeq: eventSeq,
        lastProjectedMessage,
        summary,
        changedFiles: [...changedFiles],
        activeTool,
        activeCommand,
        lastCheckpointAt: Date.now(),
        resumable: status === "interrupted",
      })
    }

    try {
      const coalescer = new DeltaCoalescer()

      for await (const rawEvent of adapter.subscribeEvents(handle.id)) {
        const event = rawEvent as DelegatedEvent
        eventSeq++

        if (event.type === "result.final") {
          summary = event.summary
          if (event.changedFiles) changedFiles.push(...event.changedFiles)
        } else if (event.type === "file.change") {
          changedFiles.push(event.path)
        } else if (event.type === "tool.start") {
          activeTool = event.toolName
        } else if (event.type === "tool.end") {
          activeTool = undefined
        } else if (event.type === "command.start") {
          activeCommand = event.command
        }

        const projected = coalescer.push(event)
        if (projected) {
          lastProjectedMessage = projected.text
          // Safe to call now: session.idle has already fired, session turn is free
          await postToSession(childSessionId, projected.text).catch(() => {})
        }

        if (eventSeq % 5 === 0) {
          await checkpoint("running")
        }
      }

      const remaining = coalescer.flush()
      if (remaining) {
        lastProjectedMessage = remaining.text
        await postToSession(childSessionId, remaining.text).catch(() => {})
      }

      await checkpoint("completed")
      return summary ?? ""
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await checkpoint("failed").catch(() => {})
      await postToSession(childSessionId, `[omni-opencode] error: ${message}`).catch(() => {})
      return `error: ${message}`
    } finally {
      activeJobs.delete(childSessionId)
    }
  }

  // ---------------------------------------------------------------------------
  // Shared start helper for internal bridge tools.
  // Starts the backend job and saves the initial broker record immediately.
  // Registers a pending drain thunk — the actual drain starts when session.idle
  // fires for this childSessionId (via the event hook below).
  // Returns a confirmation string immediately so the bridge agent's tool call
  // can complete and the bridge agent can finish its own turn cleanly.
  // ---------------------------------------------------------------------------
  async function startAndRegister(
    childSessionId: string,
    backend: Backend,
    prompt: string,
    cwd: string,
  ): Promise<string> {
    const adapter = backend === "codex" ? codexAdapter : claudeAdapter
    const handle = await adapter.startJob({ childSessionId, prompt, cwd })
    await store.save({ childSessionId, backend, backendThreadId: handle.id, status: "running" })

    // Register drain thunk. The event hook fires it when session.idle arrives.
    // This avoids the race where the bridge agent is still generating its final
    // answer when the drain tries to write into the session.
    pendingDrains.set(childSessionId, () => {
      const drain = drainStream(childSessionId, backend, handle, adapter)
      activeJobs.set(childSessionId, drain)
      pendingDrains.delete(childSessionId)
    })

    return (
      `${backend} job started (session: ${childSessionId}). ` +
      `Results will stream into this session once the bridge agent completes. ` +
      `Use delegated_job_snapshot("${childSessionId}") to check telemetry.`
    )
  }

  return {
    // ── Event hook: trigger pending drains on session.idle ───────────────────
    // When the bridge child session goes idle (bridge agent finished its turn),
    // any registered pending drain for that session is kicked off.
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID
        const startDrain = pendingDrains.get(sessionId)
        if (startDrain) {
          startDrain()
        }
      }
    },

    // ── Config hook: inject wrapper bridge subagents ─────────────────────────
    // These are the primary delegation entry points. The parent LLM invokes them
    // through OpenCode's native Task flow — not through plugin tool injection.
    // Each agent is restricted to its respective internal start tool only.
    config: async (input: Config) => {
      input.agent ??= {}

      input.agent["omni-claude-bridge"] = {
        description:
          "Delegates a coding or research task to Claude Code as an external subagent. " +
          "Use when asked to delegate work to Claude Code.",
        mode: "subagent",
        prompt:
          "You are omni-claude-bridge. " +
          "Call omni_start_claude_job with the full task prompt and then stop. " +
          "Do not add commentary, summaries, polling guidance, or follow-up text. " +
          "Do not attempt the task yourself. Do not call any other tool.",
        tools: { omni_start_claude_job: true },
        permission: { edit: "deny", webfetch: "deny", bash: { "*": "deny" } },
      }

      input.agent["omni-codex-bridge"] = {
        description:
          "Delegates a coding task to OpenAI Codex as an external subagent. " +
          "Use when asked to delegate work to Codex.",
        mode: "subagent",
        prompt:
          "You are omni-codex-bridge. " +
          "Call omni_start_codex_job with the full task prompt and then stop. " +
          "Do not add commentary, summaries, polling guidance, or follow-up text. " +
          "Do not attempt the task yourself. Do not call any other tool.",
        tools: { omni_start_codex_job: true },
        permission: { edit: "deny", webfetch: "deny", bash: { "*": "deny" } },
      }
    },

    tool: {
      // ── Internal bridge tools ──────────────────────────────────────────────
      // Called only by wrapper subagents running inside native Task child sessions.
      // They start the backend immediately and return — never await the drain.

      omni_start_claude_job: tool({
        description:
          "[Internal — omni-claude-bridge only] " +
          "Starts a Claude Code job bound to the current session and returns immediately. " +
          "Results stream into this session after the bridge agent finishes its turn.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Claude Code"),
        },
        async execute({ prompt }, context) {
          return startAndRegister(context.sessionID, "claude-code", prompt, context.directory)
        },
      }),

      omni_start_codex_job: tool({
        description:
          "[Internal — omni-codex-bridge only] " +
          "Starts a Codex job bound to the current session and returns immediately. " +
          "Results stream into this session after the bridge agent finishes its turn.",
        args: {
          prompt: tool.schema.string().describe("The full task prompt for Codex"),
        },
        async execute({ prompt }, context) {
          return startAndRegister(context.sessionID, "codex", prompt, context.directory)
        },
      }),

      // ── Inspection and control tools ───────────────────────────────────────
      // Keyed on the native Task child session ID (visible in Task card metadata).

      delegated_jobs_list: tool({
        description: "List all delegated jobs and their current status.",
        args: {},
        async execute() {
          const jobs = await store.list()
          if (jobs.length === 0) return "No delegated jobs found."
          return jobs
            .map(j => {
              const parts = [
                `- ${j.childSessionId} [${j.backend}] status=${j.status}`,
                j.lastProjectedMessage
                  ? `last="${j.lastProjectedMessage.slice(0, 60)}"`
                  : null,
              ]
              return parts.filter(Boolean).join(" ")
            })
            .join("\n")
        },
      }),

      delegated_job_snapshot: tool({
        description:
          "Get full telemetry for a delegated job: status, last projected message, " +
          "final summary, changed files, active tool/command, and event count.",
        args: {
          childSessionId: tool.schema
            .string()
            .describe("The native Task child session ID"),
        },
        async execute({ childSessionId }) {
          const job = await store.get(childSessionId)
          if (!job) return `No job found for session ${childSessionId}`
          return JSON.stringify(job, null, 2)
        },
      }),

      delegated_job_cancel: tool({
        description: "Cancel a running delegated job.",
        args: {
          childSessionId: tool.schema
            .string()
            .describe("The native Task child session ID to cancel"),
        },
        async execute({ childSessionId }) {
          const job = await store.get(childSessionId)
          if (!job) return `No job found for session ${childSessionId}`
          if (job.status !== "running")
            return `Job ${childSessionId} is not running (status: ${job.status})`
          const adapter = job.backend === "codex" ? codexAdapter : claudeAdapter
          await adapter.cancelJob(job.backendThreadId ?? "")
          await store.save({ ...job, status: "interrupted" })
          return `Cancelled job ${childSessionId}`
        },
      }),
    },
  }
}
