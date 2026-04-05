/**
 * Real end-to-end delegation pipeline test.
 *
 * Exercises the full cycle: parent orchestrates → delegates to Claude Code and
 * Codex → events stream through canonical model + projection layer → child
 * session results reported back to parent.
 *
 * Requires both `claude` and `codex` CLIs to be installed and authenticated.
 * Set SKIP_CODEX_E2E=1 or SKIP_CLAUDE_E2E=1 to skip individual backends.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClaudeAdapter } from "../../src/adapters/claude-adapter.js"
import { createClaudeClient } from "../../src/adapters/claude-client.js"
import { createCodexAdapter } from "../../src/adapters/codex-adapter.js"
import { createCodexClient, type CodexClient } from "../../src/adapters/codex-client.js"
import { createJobStore } from "../../src/core/store.js"
import { projectEvent } from "../../src/opencode/projection.js"
import type { DelegatedEvent } from "../../src/core/events.js"
import type { ProjectedMessage } from "../../src/opencode/projection.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CWD = process.cwd().replace(/\\/g, "/")
// A read-only task: no shell commands, no file writes — just reading a file
const DELEGATE_TASK =
  "Read the file src/index.ts in the current working directory and tell me what TypeScript symbols it exports. One sentence answer."

const SKIP_CLAUDE = process.env.SKIP_CLAUDE_E2E === "1"
const SKIP_CODEX = process.env.SKIP_CODEX_E2E === "1"

// Per-test timeout — real LLM calls can be slow
const TIMEOUT = 60_000

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let codexClient: CodexClient | null = null

afterAll(() => {
  // Clean up the codex app-server subprocess
  codexClient?.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  adapter: ReturnType<typeof createClaudeAdapter | typeof createCodexAdapter>,
  jobId: string,
): Promise<{ events: DelegatedEvent[]; projected: ProjectedMessage[] }> {
  const events: DelegatedEvent[] = []
  const projected: ProjectedMessage[] = []
  for await (const event of adapter.subscribeEvents(jobId)) {
    events.push(event)
    projected.push(projectEvent(event))
  }
  return { events, projected }
}

function assertDelegationResult(events: DelegatedEvent[], projected: ProjectedMessage[], backend: string) {
  // Must end with a result.final event
  const finalEvent = events.find(e => e.type === "result.final")
  expect(finalEvent, `${backend}: expected result.final event`).toBeDefined()

  // result.final must have a non-empty summary
  const summary = (finalEvent as Extract<DelegatedEvent, { type: "result.final" }>).summary
  expect(summary, `${backend}: summary should be non-empty`).toBeTruthy()

  // Projection must include at least one projected message
  expect(projected.length, `${backend}: expected projected messages`).toBeGreaterThan(0)

  // The final projected message should have kind "result"
  const resultMessage = projected.find(m => m.kind === "result")
  expect(resultMessage, `${backend}: expected projected result message`).toBeDefined()

  return summary
}

// ---------------------------------------------------------------------------
// Test 1: Claude Code delegation
// ---------------------------------------------------------------------------

describe("Claude Code delegation", { timeout: TIMEOUT }, () => {
  it.skipIf(SKIP_CLAUDE)("delegates task and streams events ending with result.final", async () => {
    const client = createClaudeClient()
    const adapter = createClaudeAdapter(client)

    const handle = await adapter.startJob({
      childSessionId: "e2e-claude-1",
      prompt: DELEGATE_TASK,
      cwd: CWD,
    })

    const { events, projected } = await collectEvents(adapter, handle.id)

    const summary = assertDelegationResult(events, projected, "claude-code")

    // Must have at least one assistant message (showing real LLM work)
    expect(
      events.some(e => e.type === "assistant.delta" || e.type === "assistant.message"),
      "claude-code: expected at least one assistant.delta or assistant.message",
    ).toBe(true)

    // The summary should mention "pluginName" or "export" (it read the file)
    expect(
      summary.toLowerCase().includes("plugin") || summary.toLowerCase().includes("export") || summary.includes("omni"),
      `claude-code: summary should reference the file contents, got: "${summary}"`,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 2: Codex delegation
// ---------------------------------------------------------------------------

describe("Codex delegation", { timeout: TIMEOUT }, () => {
  beforeAll(() => {
    if (!SKIP_CODEX) {
      codexClient = createCodexClient()
    }
  })

  it.skipIf(SKIP_CODEX)("delegates task via app-server and streams events ending with result.final", async () => {
    const adapter = createCodexAdapter(codexClient!)

    const handle = await adapter.startJob({
      childSessionId: "e2e-codex-1",
      prompt: DELEGATE_TASK,
      cwd: CWD,
    })

    const { events, projected } = await collectEvents(adapter, handle.id)

    assertDelegationResult(events, projected, "codex")

    // Must have at least one assistant delta
    expect(
      events.some(e => e.type === "assistant.delta"),
      "codex: expected at least one assistant.delta",
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Full pipeline — both backends, store, projection, parent report
// ---------------------------------------------------------------------------

describe("full delegation pipeline", { timeout: TIMEOUT * 2 }, () => {
  it.skipIf(SKIP_CLAUDE)(
    "orchestrates both backends and assembles a parent session report",
    async () => {
      const store = createJobStore()
      const parentSessionId = "pipeline-parent-1"
      const claudeJobId = `${parentSessionId}:claude-job-1`

      // -- Claude Code child job --
      const claudeClient = createClaudeClient()
      const claudeAdapter = createClaudeAdapter(claudeClient)

      const claudeHandle = await claudeAdapter.startJob({
        childSessionId: "pipeline-claude-1",
        prompt: DELEGATE_TASK,
        cwd: CWD,
      })

      await store.save({
        jobId: claudeJobId,
        parentSessionId,
        runtimeType: "tmux",
        runtimeHandle: claudeHandle.id,
        attachTarget: claudeHandle.id,
        terminalLogPath: `logs/${claudeJobId}.log`,
        childSessionId: "pipeline-claude-1",
        backend: "claude-code",
        backendThreadId: claudeHandle.id,
        status: "running",
      })

      const claudeResult = await collectEvents(claudeAdapter, claudeHandle.id)
      const claudeFinal = claudeResult.events.find(e => e.type === "result.final")!
      const claudeSummary = (claudeFinal as Extract<DelegatedEvent, { type: "result.final" }>).summary

      await store.save({
        jobId: claudeJobId,
        parentSessionId,
        runtimeType: "tmux",
        runtimeHandle: claudeHandle.id,
        attachTarget: claudeHandle.id,
        terminalLogPath: `logs/${claudeJobId}.log`,
        childSessionId: "pipeline-claude-1",
        backend: "claude-code",
        backendThreadId: claudeHandle.id,
        status: "completed",
      })

      // -- Codex child job (if available) --
      let codexSummary: string | null = null
      if (!SKIP_CODEX) {
        const codexJobId = `${parentSessionId}:codex-job-1`
        if (!codexClient) codexClient = createCodexClient()
        const codexAdp = createCodexAdapter(codexClient)

        const codexHandle = await codexAdp.startJob({
          childSessionId: "pipeline-codex-1",
          prompt: DELEGATE_TASK,
          cwd: CWD,
        })

        await store.save({
          jobId: codexJobId,
          parentSessionId,
          runtimeType: "tmux",
          runtimeHandle: codexHandle.id,
          attachTarget: codexHandle.id,
          terminalLogPath: `logs/${codexJobId}.log`,
          childSessionId: "pipeline-codex-1",
          backend: "codex",
          backendThreadId: codexHandle.id,
          status: "running",
        })

        const codexResult = await collectEvents(codexAdp, codexHandle.id)
        const codexFinal = codexResult.events.find(e => e.type === "result.final")!
        codexSummary = (codexFinal as Extract<DelegatedEvent, { type: "result.final" }>).summary

        await store.save({
          jobId: codexJobId,
          parentSessionId,
          runtimeType: "tmux",
          runtimeHandle: codexHandle.id,
          attachTarget: codexHandle.id,
          terminalLogPath: `logs/${codexJobId}.log`,
          childSessionId: "pipeline-codex-1",
          backend: "codex",
          backendThreadId: codexHandle.id,
          status: "completed",
        })
      }

      // -- Build parent session report --
      const jobs = await store.list()
      const completedJobs = jobs.filter(j => j.status === "completed")

      const parentReport = [
        "=== Delegation Pipeline Report ===",
        `Completed child jobs: ${completedJobs.length}`,
        `Claude Code result: ${claudeSummary}`,
        codexSummary ? `Codex result: ${codexSummary}` : "Codex: skipped",
        "==================================",
      ].join("\n")

      // Assertions on the parent report
      expect(completedJobs.length).toBeGreaterThanOrEqual(1)
      expect(parentReport).toContain("Claude Code result:")
      expect(claudeSummary).toBeTruthy()
      expect(claudeResult.projected.some(m => m.kind === "result")).toBe(true)

      // Verify store integrity
      const claudeJob = await store.get(claudeJobId)
      expect(claudeJob?.status).toBe("completed")
      expect(claudeJob?.backend).toBe("claude-code")

      // Print the report for visibility in test output
      console.log("\n" + parentReport)
    },
  )
})
