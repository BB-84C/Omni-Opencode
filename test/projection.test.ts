import { describe, expect, it } from "vitest"
import { projectEvent } from "../src/opencode/projection.js"
import { DeltaCoalescer } from "../src/opencode/render.js"
import type { DelegatedEvent } from "../src/core/events.js"

describe("projectEvent", () => {
  it("maps assistant.delta → kind 'message'", () => {
    const event: DelegatedEvent = {
      type: "assistant.delta",
      sessionId: "s1",
      text: "Hello",
    }
    const msg = projectEvent(event)
    expect(msg.kind).toBe("message")
    expect(msg.text).toBe("Hello")
    expect(msg.sessionId).toBe("s1")
    expect(msg.raw).toBe(event)
  })

  it("maps tool.start → kind 'tool-activity', text starts with '→'", () => {
    const event: DelegatedEvent = {
      type: "tool.start",
      sessionId: "s2",
      toolName: "bash",
    }
    const msg = projectEvent(event)
    expect(msg.kind).toBe("tool-activity")
    expect(msg.text.startsWith("→")).toBe(true)
    expect(msg.text).toContain("bash")
  })

  it("maps result.final with changedFiles → text contains 'files changed'", () => {
    const event: DelegatedEvent = {
      type: "result.final",
      sessionId: "s3",
      summary: "All done",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
    }
    const msg = projectEvent(event)
    expect(msg.kind).toBe("result")
    expect(msg.text).toContain("files changed")
    expect(msg.text).toContain("All done")
  })

  it("maps command.start → kind 'command', text starts with '$'", () => {
    const event: DelegatedEvent = {
      type: "command.start",
      sessionId: "s4",
      command: "npm install",
    }
    const msg = projectEvent(event)
    expect(msg.kind).toBe("command")
    expect(msg.text.startsWith("$")).toBe(true)
    expect(msg.text).toContain("npm install")
  })
})

describe("DeltaCoalescer", () => {
  it("accumulates assistant.delta events and flushes on non-delta", () => {
    const coalescer = new DeltaCoalescer()

    const delta1: DelegatedEvent = {
      type: "assistant.delta",
      sessionId: "s1",
      text: "Hello ",
    }
    const delta2: DelegatedEvent = {
      type: "assistant.delta",
      sessionId: "s1",
      text: "world",
    }
    const statusEvent: DelegatedEvent = {
      type: "status.update",
      sessionId: "s1",
      message: "Working...",
    }

    // Pushing deltas should return null (accumulated)
    expect(coalescer.push(delta1)).toBeNull()
    expect(coalescer.push(delta2)).toBeNull()

    // Pushing a non-delta should flush the buffer and return the buffered message
    const flushed = coalescer.push(statusEvent)
    expect(flushed).not.toBeNull()
    expect(flushed!.kind).toBe("message")
    expect(flushed!.text).toBe("Hello world")
  })

  it("DeltaCoalescer.flush() returns null when buffer is empty", () => {
    const coalescer = new DeltaCoalescer()
    expect(coalescer.flush()).toBeNull()
  })
})
