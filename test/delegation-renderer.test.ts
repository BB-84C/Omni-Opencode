import { describe, expect, it } from "vitest"

import type { DelegationStreamEvent } from "../src/runtime/delegation-stream-types"
import {
  renderDelegationBackendNoise,
  renderDelegationEvent,
  renderDelegationTranscriptEvents,
} from "../src/runtime/delegation-renderer"

describe("delegation renderer", () => {
  it("renders markdown-like assistant output readably", () => {
    const event: DelegationStreamEvent = {
      backend: "codex",
      kind: "message",
      eventType: "assistant.message.completed",
      text: [
        "# Summary",
        "",
        "- first item",
        "- second item with `inline code`",
        "",
        "```ts",
        "const value = 42",
        "```",
      ].join("\n"),
      raw: { type: "assistant.message.completed" },
    }

    expect(renderDelegationEvent(event)).toBe(
      [
        "\x1b[1m\x1b[36mSummary\x1b[0m",
        "",
        "  • first item",
        "  • second item with \x1b[36minline code\x1b[0m",
        "",
        "\x1b[2m```ts\x1b[0m",
        "const value = 42",
        "\x1b[2m```\x1b[0m",
      ].join("\n"),
    )
  })

  it("styles status lines with ansi color", () => {
    const event: DelegationStreamEvent = {
      backend: "claude",
      kind: "status",
      eventType: "message_start",
      raw: { type: "message_start", message: { id: "msg-1" } },
    }

    expect(renderDelegationEvent(event)).toBe(
      "\x1b[33m[claude] status: message_start\x1b[0m",
    )
  })

  it("clearly distinguishes progress warnings errors and final results", () => {
    const progress: DelegationStreamEvent = {
      backend: "codex",
      kind: "status",
      eventType: "turn.started",
      raw: { type: "turn.started" },
    }
    const warning: DelegationStreamEvent = {
      backend: "codex",
      kind: "status",
      eventType: "warning",
      raw: { type: "warning", message: "Careful now" },
    }
    const error: DelegationStreamEvent = {
      backend: "codex",
      kind: "status",
      eventType: "error",
      raw: { type: "error", message: "Containment breach" },
    }
    const result: DelegationStreamEvent = {
      backend: "codex",
      kind: "completion",
      eventType: "turn.completed",
      raw: { type: "turn.completed" },
    }

    expect(renderDelegationEvent(progress)).toBe(
      "\x1b[33m[codex] progress: turn.started\x1b[0m",
    )
    expect(renderDelegationEvent(warning)).toBe(
      "\x1b[33m[codex] warning: Careful now\x1b[0m",
    )
    expect(renderDelegationEvent(error)).toBe(
      "\x1b[31m[codex] error: Containment breach\x1b[0m",
    )
    expect(renderDelegationEvent(result)).toBe(
      "\x1b[32m[codex] final result\x1b[0m",
    )
  })

  it("renders readable terminal output instead of raw json", () => {
    const event: DelegationStreamEvent = {
      backend: "claude",
      kind: "message",
      eventType: "content_block_delta",
      text: "Plain output",
      raw: { type: "content_block_delta", delta: { text: "Plain output" } },
    }

    const rendered = renderDelegationEvent(event)

    expect(rendered).toContain("Plain output")
    expect(rendered).not.toContain('{"type":"content_block_delta"')
    expect(rendered).not.toContain("\"delta\"")
  })

  it("normalizes windows line endings in markdown-like output", () => {
    const event: DelegationStreamEvent = {
      backend: "codex",
      kind: "message",
      eventType: "assistant.message.completed",
      text: "# Summary\r\n\r\n- first item with `inline code`\r\n\r\n```ts\r\nconst value = 42\r\n```",
      raw: { type: "assistant.message.completed" },
    }

    const rendered = renderDelegationEvent(event)

    expect(rendered).toBe(
      [
        "\x1b[1m\x1b[36mSummary\x1b[0m",
        "",
        "  • first item with \x1b[36minline code\x1b[0m",
        "",
        "\x1b[2m```ts\x1b[0m",
        "const value = 42",
        "\x1b[2m```\x1b[0m",
      ].join("\n"),
    )
    expect(rendered).not.toContain("\r")
  })

  it("renders completion text when the event carries final content", () => {
    const event: DelegationStreamEvent = {
      backend: "codex",
      kind: "completion",
      eventType: "turn.completed",
      text: "Final answer",
      raw: { type: "turn.completed" },
    }

    expect(renderDelegationEvent(event)).toBe(
      "\x1b[32m[codex] final result\x1b[0m\nFinal answer",
    )
  })

  it("renders backend stderr as progress noise for transcript output", () => {
    expect(renderDelegationBackendNoise("codex", "Reading additional input from stdin...\n")).toBe(
      "[codex] progress: Reading additional input from stdin...",
    )
  })

  it("renders Claude transcript output from the coalesced completion only", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "claude",
        kind: "status",
        eventType: "message_start",
        raw: { type: "message_start" },
      },
      {
        backend: "claude",
        kind: "message",
        eventType: "content_block_delta",
        text: "PACKAGE: omni-opencode",
        raw: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "PACKAGE: omni-opencode" },
        },
      },
      {
        backend: "claude",
        kind: "message",
        eventType: "content_block_delta",
        text: "\nTITLE: Omni-Opencode",
        raw: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "\nTITLE: Omni-Opencode" },
        },
      },
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
        raw: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
    ])
  })

  it("preserves markdown-like readability in transcript events", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "codex",
        kind: "message",
        eventType: "assistant.message.completed",
        text: "## Findings\n- Package name: `omni-opencode`",
        raw: { type: "assistant.message.completed" },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "\x1b[1m\x1b[36mFindings\x1b[0m\n  • Package name: \x1b[36momni-opencode\x1b[0m",
    ])
  })

  it("keeps Codex transcript progress and narration without adding a synthetic final wrapper", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "codex",
        kind: "status",
        eventType: "thread.run.progress",
        raw: { type: "thread.run.progress", message: "Inspecting package metadata" },
      },
      {
        backend: "codex",
        kind: "message",
        eventType: "assistant.message.delta",
        text: "Inspecting package metadata",
        raw: { type: "assistant.message.delta", delta: "Inspecting package metadata" },
      },
      {
        backend: "codex",
        kind: "completion",
        eventType: "turn.completed",
        text: "## Findings\n- Package name: `omni-opencode`",
        raw: { type: "turn.completed" },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "[codex] progress: Inspecting package metadata",
      "Inspecting package metadata",
      "\x1b[1m\x1b[36mFindings\x1b[0m\n  • Package name: \x1b[36momni-opencode\x1b[0m",
    ])
  })

  it("does not duplicate Claude final result markers when completion has no text", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        raw: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "[claude] final result",
    ])
  })

  it("renders summarized intermediate Claude tool activity in transcripts", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "claude",
        kind: "status",
        eventType: "tool_use",
        raw: {
          type: "tool_use",
          id: "toolu_01UFCFSWb5WUxAYLEqm7AXUr",
          name: "Read",
          input: { file_path: "D:/Omni-Opencode/package.json" },
        },
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "tool_result.error",
        raw: {
          type: "tool_result",
          tool_use_id: "toolu_01UFCFSWb5WUxAYLEqm7AXUr",
          is_error: true,
        },
      },
      {
        backend: "claude",
        kind: "completion",
        eventType: "result.success",
        text: "## Findings\n- Package name: `omni-opencode`",
        raw: {
          type: "result",
          subtype: "success",
        },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "[claude] tool_use: Read",
      "[claude] tool_result: error",
      "\u001b[1m\u001b[36mFindings\u001b[0m\n  • Package name: \u001b[36momni-opencode\u001b[0m",
    ])
  })

  it("keeps Claude tool lines concise and leaves the final answer as direct assistant output", () => {
    const events: DelegationStreamEvent[] = [
      {
        backend: "claude",
        kind: "status",
        eventType: "tool_use",
        raw: {
          type: "tool_use",
          id: "toolu_02",
          name: "Read",
          input: { file_path: "D:/Omni-Opencode/package.json" },
        },
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "tool_result",
        raw: {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        backend: "claude",
        kind: "completion",
        eventType: "result.success",
        text: "## Findings\n- Package name: `omni-opencode`",
        raw: {
          type: "result",
          subtype: "success",
          result: "## Findings\n- Package name: `omni-opencode`",
        },
      },
    ]

    expect(renderDelegationTranscriptEvents(events)).toEqual([
      "[claude] tool_use: Read",
      "[claude] tool_result: ok",
      "\u001b[1m\u001b[36mFindings\u001b[0m\n  • Package name: \u001b[36momni-opencode\u001b[0m",
    ])
  })
})
