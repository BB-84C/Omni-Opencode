import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { ClaudeStreamParser } from "../src/runtime/claude-stream-parser"

const claudeStdoutFixture = readFileSync(
  new URL("./fixtures/claude-stdout.jsonl", import.meta.url),
  "utf8",
)

const claudeHeavyStdoutFixture = readFileSync(
  new URL("./fixtures/claude-heavy-stdout.jsonl", import.meta.url),
  "utf8",
)

describe("claude stream parser", () => {
  it("parses stream-json lines into structured events", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push(
      [
        JSON.stringify({ type: "message_start", message: { id: "msg-1" } }),
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: null } }),
      ].join("\n") + "\n",
    )

    expect(events).toEqual([
      {
        backend: "claude",
        kind: "status",
        eventType: "message_start",
        raw: { type: "message_start", message: { id: "msg-1" } },
      },
      {
        backend: "claude",
        kind: "message",
        eventType: "content_block_delta",
        text: "Hello",
        raw: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "message_delta",
        raw: { type: "message_delta", delta: { stop_reason: null } },
      },
    ])
  })

  it("detects completion from stop_reason end_turn", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push(
      `${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n`,
    )

    expect(events).toEqual([
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        raw: { type: "message_delta", delta: { stop_reason: "end_turn" } },
      },
    ])
  })

  it("ignores malformed and partial lines until a full json line arrives", () => {
    const parser = new ClaudeStreamParser()

    expect(parser.push('{"type":"content_block_delta","delta":{"type":"text_delta","text":"par')).toEqual([])

    expect(parser.push('tial"}}\nnot-json\n')).toEqual([
      {
        backend: "claude",
        kind: "message",
        eventType: "content_block_delta",
        text: "partial",
        raw: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        },
      },
    ])
  })

  it("ignores protocol noise around real claude stream fixtures", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push(claudeStdoutFixture)

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "system" }),
        expect.objectContaining({ eventType: "assistant" }),
        expect.objectContaining({ eventType: "user" }),
        expect.objectContaining({ eventType: "result" }),
        expect.objectContaining({ eventType: "rate_limit_event" }),
      ]),
    )
  })

  it("parses nested text deltas from real claude stream fixtures without duplicate final message emission", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push(claudeStdoutFixture)

    const statusEvents = events.filter((e) => e.kind === "status")
    const messageEvents = events.filter((e) => e.kind === "message")
    const completionEvents = events.filter((e) => e.kind === "completion")

    // Two tool_use events from incremental content_block_start
    expect(statusEvents.filter((e) => e.eventType.startsWith("tool_use."))).toHaveLength(2)
    expect(statusEvents[0]).toEqual(expect.objectContaining({
      backend: "claude",
      kind: "status",
      eventType: "tool_use.Read",
    }))

    // Two tool_result events from top-level user records
    expect(statusEvents.filter((e) => e.eventType.startsWith("tool_result."))).toHaveLength(2)

    // message_start for the final assistant turn
    expect(statusEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "message_start" }),
      ]),
    )

    // Final result.success
    expect(statusEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "result.success" }),
      ]),
    )

    // Text deltas
    expect(messageEvents).toHaveLength(2)
    expect(messageEvents[0]).toEqual(expect.objectContaining({
      eventType: "content_block_delta",
      text: "PACKAGE: omni-opencode",
    }))

    // Completion
    expect(completionEvents).toHaveLength(1)
    expect(completionEvents[0]).toEqual(expect.objectContaining({
      eventType: "message_delta",
      text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
    }))
  })

  it("falls back to top-level final text when no streamed text delta is present", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode" }],
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
      }),
      "",
    ].join("\n"))

    expect(events).toEqual([
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
        raw: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "result.success",
        raw: {
          type: "result",
          subtype: "success",
          result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
        },
      },
    ])
  })

  it("falls back to result text when result arrives after end_turn", () => {
    const parser = new ClaudeStreamParser()

    const earlyEvents = parser.push([
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      }),
      "",
    ].join("\n"))

    expect(earlyEvents).toEqual([])

    const finalEvents = parser.push([
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
      }),
      "",
    ].join("\n"))

    expect(finalEvents).toEqual([
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
        raw: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "result.success",
        raw: {
          type: "result",
          subtype: "success",
          result: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
        },
      },
    ])
  })

  it("emits a terminal result.success status even when result arrives after end_turn completion", () => {
    const parser = new ClaudeStreamParser()

    const earlyEvents = parser.push([
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
      }),
      "",
    ].join("\n"))

    expect(earlyEvents).toEqual([])

    const finalEvents = parser.push([
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
      }),
      "",
    ].join("\n"))

    expect(finalEvents).toEqual([
      {
        backend: "claude",
        kind: "completion",
        eventType: "message_delta",
        raw: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        },
        text: "ok",
      },
      {
        backend: "claude",
        kind: "status",
        eventType: "result.success",
        raw: {
          type: "result",
          subtype: "success",
          result: "ok",
        },
      },
    ])
  })

  it("emits provider-truthful tool and final-result lifecycle events from heavier claude fixtures", () => {
    const parser = new ClaudeStreamParser()

    const events = parser.push(claudeHeavyStdoutFixture)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        backend: "claude",
        kind: "status",
        eventType: "tool_use.Read",
        raw: expect.objectContaining({
          type: "tool_use",
          name: "Read",
        }),
      }),
      expect.objectContaining({
        backend: "claude",
        kind: "status",
        eventType: "tool_result.ok",
        raw: expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu_01UFCFSWb5WUxAYLEqm7AXUr",
        }),
      }),
      expect.objectContaining({
        backend: "claude",
        kind: "status",
        eventType: "message_delta",
        raw: expect.objectContaining({
          type: "message_delta",
          delta: expect.objectContaining({ stop_reason: "tool_use" }),
        }),
      }),
      expect.objectContaining({
        backend: "claude",
        kind: "completion",
        eventType: "result.success",
        text: expect.stringContaining("classifyWindowsPsmuxDashboardStatus"),
        raw: expect.objectContaining({
          type: "result",
          subtype: "success",
        }),
      }),
    ]))
  })
})
