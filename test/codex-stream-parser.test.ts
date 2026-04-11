import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { CodexStreamParser } from "../src/runtime/codex-stream-parser"

const codexStdoutFixture = readFileSync(
  new URL("./fixtures/codex-stdout.jsonl", import.meta.url),
  "utf8",
)

describe("codex stream parser", () => {
  it("parses json stream lines into structured events", () => {
    const parser = new CodexStreamParser()

    const events = parser.push(
      [
        JSON.stringify({ type: "turn.started", turn_id: "turn-1" }),
        JSON.stringify({ type: "assistant.message.delta", delta: "Hello" }),
        JSON.stringify({ type: "assistant.message.completed", text: "Hello world" }),
      ].join("\n") + "\n",
    )

    expect(events).toEqual([
      {
        backend: "codex",
        kind: "status",
        eventType: "turn.started",
        raw: { type: "turn.started", turn_id: "turn-1" },
      },
      {
        backend: "codex",
        kind: "message",
        eventType: "assistant.message.delta",
        text: "Hello",
        raw: { type: "assistant.message.delta", delta: "Hello" },
      },
      {
        backend: "codex",
        kind: "message",
        eventType: "assistant.message.completed",
        text: "Hello world",
        raw: { type: "assistant.message.completed", text: "Hello world" },
      },
    ])
  })

  it("detects completion from turn.completed", () => {
    const parser = new CodexStreamParser()

    const events = parser.push(
      `${JSON.stringify({ type: "turn.completed", turn_id: "turn-1" })}\n`,
    )

    expect(events).toEqual([
      {
        backend: "codex",
        kind: "completion",
        eventType: "turn.completed",
        raw: { type: "turn.completed", turn_id: "turn-1" },
      },
    ])
  })

  it("carries the latest completed item text into turn.completed", () => {
    const parser = new CodexStreamParser()

    const events = parser.push(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "Final answer from Codex",
          },
        }),
        JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
      ].join("\n") + "\n",
    )

    expect(events).toEqual([
      {
        backend: "codex",
        kind: "message",
        eventType: "item.completed",
        text: "Final answer from Codex",
        raw: {
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "Final answer from Codex",
          },
        },
      },
      {
        backend: "codex",
        kind: "completion",
        eventType: "turn.completed",
        text: "Final answer from Codex",
        raw: { type: "turn.completed", turn_id: "turn-1" },
      },
    ])
  })

  it("extracts completed agent message text from nested item payloads", () => {
    const parser = new CodexStreamParser()

    const events = parser.push(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          text: "Please specify what to read.",
        },
      })}\n`,
    )

    expect(events).toEqual([
      {
        backend: "codex",
        kind: "message",
        eventType: "item.completed",
        text: "Please specify what to read.",
        raw: {
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "Please specify what to read.",
          },
        },
      },
    ])
  })

  it("ignores malformed and partial lines until a full json line arrives", () => {
    const parser = new CodexStreamParser()

    expect(parser.push('{"type":"assistant.message.delta","delta":"par')).toEqual([])

    expect(parser.push('tial"}\nnot-json\n')).toEqual([
      {
        backend: "codex",
        kind: "message",
        eventType: "assistant.message.delta",
        text: "partial",
        raw: { type: "assistant.message.delta", delta: "partial" },
      },
    ])
  })

  it("parses real codex stdout fixture into status message and completion events", () => {
    const parser = new CodexStreamParser()

    const events = parser.push(codexStdoutFixture)

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backend: "codex",
          kind: "status",
          eventType: "thread.started",
          raw: expect.objectContaining({ type: "thread.started" }),
        }),
        expect.objectContaining({
          backend: "codex",
          kind: "message",
          eventType: "item.completed",
          text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
          raw: expect.objectContaining({ type: "item.completed" }),
        }),
        expect.objectContaining({
          backend: "codex",
          kind: "completion",
          eventType: "turn.completed",
          text: "PACKAGE: omni-opencode\nTITLE: Omni-Opencode",
          raw: expect.objectContaining({ type: "turn.completed" }),
        }),
      ]),
    )
  })
})
