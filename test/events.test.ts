import { describe, expect, it } from "vitest"
import { delegatedEventSchema } from "../src/core/events.js"
import type { DelegatedEvent } from "../src/core/events.js"

describe("delegatedEventSchema", () => {
  // --- Each event type parses successfully ---

  it("parses assistant.delta", () => {
    const result = delegatedEventSchema.safeParse({
      type: "assistant.delta",
      sessionId: "s1",
      text: "hello",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const ev: DelegatedEvent = result.data
      expect(ev.type).toBe("assistant.delta")
    }
  })

  it("parses assistant.message", () => {
    const result = delegatedEventSchema.safeParse({
      type: "assistant.message",
      sessionId: "s1",
      text: "full message",
    })
    expect(result.success).toBe(true)
  })

  it("parses reasoning.note", () => {
    const result = delegatedEventSchema.safeParse({
      type: "reasoning.note",
      sessionId: "s1",
      text: "thinking...",
    })
    expect(result.success).toBe(true)
  })

  it("parses tool.start with optional input", () => {
    const withInput = delegatedEventSchema.safeParse({
      type: "tool.start",
      sessionId: "s1",
      toolName: "bash",
      input: { cmd: "ls" },
    })
    expect(withInput.success).toBe(true)

    const withoutInput = delegatedEventSchema.safeParse({
      type: "tool.start",
      sessionId: "s1",
      toolName: "bash",
    })
    expect(withoutInput.success).toBe(true)
  })

  it("parses tool.output.delta", () => {
    const result = delegatedEventSchema.safeParse({
      type: "tool.output.delta",
      sessionId: "s1",
      text: "partial output",
    })
    expect(result.success).toBe(true)
  })

  it("parses tool.end with optional exitCode", () => {
    const withCode = delegatedEventSchema.safeParse({
      type: "tool.end",
      sessionId: "s1",
      toolName: "bash",
      exitCode: 0,
    })
    expect(withCode.success).toBe(true)

    const withoutCode = delegatedEventSchema.safeParse({
      type: "tool.end",
      sessionId: "s1",
      toolName: "bash",
    })
    expect(withoutCode.success).toBe(true)
  })

  it("parses command.start", () => {
    const result = delegatedEventSchema.safeParse({
      type: "command.start",
      sessionId: "s1",
      command: "npm install",
    })
    expect(result.success).toBe(true)
  })

  it("parses command.stdout.delta", () => {
    const result = delegatedEventSchema.safeParse({
      type: "command.stdout.delta",
      sessionId: "s1",
      text: "stdout line",
    })
    expect(result.success).toBe(true)
  })

  it("parses command.stderr.delta", () => {
    const result = delegatedEventSchema.safeParse({
      type: "command.stderr.delta",
      sessionId: "s1",
      text: "stderr line",
    })
    expect(result.success).toBe(true)
  })

  it("parses file.change for each changeType", () => {
    for (const changeType of ["created", "modified", "deleted"] as const) {
      const result = delegatedEventSchema.safeParse({
        type: "file.change",
        sessionId: "s1",
        path: "/some/file.ts",
        changeType,
      })
      expect(result.success).toBe(true)
    }
  })

  it("parses patch.ready", () => {
    const result = delegatedEventSchema.safeParse({
      type: "patch.ready",
      sessionId: "s1",
      patch: "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new",
    })
    expect(result.success).toBe(true)
  })

  it("parses status.update", () => {
    const result = delegatedEventSchema.safeParse({
      type: "status.update",
      sessionId: "s1",
      message: "Working...",
    })
    expect(result.success).toBe(true)
  })

  it("parses approval.requested", () => {
    const result = delegatedEventSchema.safeParse({
      type: "approval.requested",
      sessionId: "s1",
      prompt: "Do you approve?",
    })
    expect(result.success).toBe(true)
  })

  it("parses warning", () => {
    const result = delegatedEventSchema.safeParse({
      type: "warning",
      sessionId: "s1",
      message: "something suspicious",
    })
    expect(result.success).toBe(true)
  })

  it("parses error", () => {
    const result = delegatedEventSchema.safeParse({
      type: "error",
      sessionId: "s1",
      message: "something went wrong",
    })
    expect(result.success).toBe(true)
  })

  it("parses result.final with optional changedFiles", () => {
    const withFiles = delegatedEventSchema.safeParse({
      type: "result.final",
      sessionId: "s1",
      summary: "Done",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
    })
    expect(withFiles.success).toBe(true)

    const withoutFiles = delegatedEventSchema.safeParse({
      type: "result.final",
      sessionId: "s1",
      summary: "Done",
    })
    expect(withoutFiles.success).toBe(true)
  })

  // --- Rejection cases ---

  it("rejects an invalid type", () => {
    const result = delegatedEventSchema.safeParse({
      type: "unknown.event",
      sessionId: "s1",
      text: "oops",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a missing required field (sessionId)", () => {
    const result = delegatedEventSchema.safeParse({
      type: "assistant.delta",
      text: "hello",
      // sessionId is omitted
    })
    expect(result.success).toBe(false)
  })

  it("rejects a missing required field for the specific event (text for assistant.delta)", () => {
    const result = delegatedEventSchema.safeParse({
      type: "assistant.delta",
      sessionId: "s1",
      // text is omitted
    })
    expect(result.success).toBe(false)
  })

  it("rejects file.change with an invalid changeType", () => {
    const result = delegatedEventSchema.safeParse({
      type: "file.change",
      sessionId: "s1",
      path: "/some/file.ts",
      changeType: "renamed",
    })
    expect(result.success).toBe(false)
  })

  // --- Type narrowing works correctly ---

  it("TypeScript discriminant narrowing compiles and works at runtime", () => {
    const raw: unknown = {
      type: "tool.start",
      sessionId: "s2",
      toolName: "grep",
      input: { pattern: "foo" },
    }
    const parsed = delegatedEventSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const ev = parsed.data
    if (ev.type === "tool.start") {
      // TypeScript should narrow: toolName is available here
      expect(ev.toolName).toBe("grep")
    }
  })
})
