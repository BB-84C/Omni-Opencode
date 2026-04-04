import { describe, it, expect } from "vitest"
import { mapClaudeMessage, createClaudeAdapter } from "../src/adapters/claude-adapter.js"
import type { ClaudeSDKMessage, ClaudeClient } from "../src/adapters/claude-client.js"

// ---------------------------------------------------------------------------
// Mock client helper
// ---------------------------------------------------------------------------

function createMockClaudeClient(messages: ClaudeSDKMessage[]): ClaudeClient {
  return {
    async *run() {
      yield* messages
    },
    abort() {},
  }
}

// ---------------------------------------------------------------------------
// mapClaudeMessage unit tests
// ---------------------------------------------------------------------------

describe("mapClaudeMessage", () => {
  const sessionId = "test-session-1"

  it("maps assistant text content → assistant.delta", () => {
    const msg: ClaudeSDKMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, world!" }],
      },
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "assistant.delta",
      sessionId,
      text: "Hello, world!",
    })
  })

  it("maps assistant tool_use content → tool.start with toolName", () => {
    const msg: ClaudeSDKMessage = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-abc",
            name: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "tool.start",
      sessionId,
      toolName: "read_file",
      input: { path: "src/index.ts" },
    })
  })

  it("maps result success → result.final", () => {
    const msg: ClaudeSDKMessage = {
      type: "result",
      subtype: "success",
      result: "Task completed successfully",
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "result.final",
      sessionId,
      summary: "Task completed successfully",
    })
  })

  it("maps result success with no result field → result.final with default summary", () => {
    const msg: ClaudeSDKMessage = {
      type: "result",
      subtype: "success",
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "result.final",
      sessionId,
      summary: "completed",
    })
  })

  it("maps result error → error", () => {
    const msg: ClaudeSDKMessage = {
      type: "result",
      subtype: "error",
      result: "Something went wrong",
      is_error: true,
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "error",
      sessionId,
      message: "Something went wrong",
    })
  })

  it("maps result error with no result field → error with default message", () => {
    const msg: ClaudeSDKMessage = {
      type: "result",
      subtype: "error",
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "error",
      sessionId,
      message: "unknown error",
    })
  })

  it("maps system → status.update", () => {
    const msg: ClaudeSDKMessage = {
      type: "system",
      subtype: "session_started",
      session_id: "abc123",
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "status.update",
      sessionId,
      message: "system: session_started",
    })
  })

  it("maps tool_result → tool.end", () => {
    const msg: ClaudeSDKMessage = {
      type: "tool_result",
      tool_use_id: "tool-abc",
      content: "file contents here",
    }
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toEqual({
      type: "tool.end",
      sessionId,
      toolName: "unknown",
    })
  })

  it("returns null for unrecognized type", () => {
    // Cast to bypass TS type checking for the unrecognized type test
    const msg = { type: "unrecognized_type", data: "something" } as unknown as ClaudeSDKMessage
    const event = mapClaudeMessage(msg, sessionId)
    expect(event).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Full adapter integration tests
// ---------------------------------------------------------------------------

describe("createClaudeAdapter", () => {
  const childSessionId = "child-session-1"

  it("startJob returns a handle with id and childSessionId", async () => {
    const client = createMockClaudeClient([])
    const adapter = createClaudeAdapter(client)
    const handle = await adapter.startJob({
      childSessionId,
      prompt: "write a test",
    })
    expect(handle.childSessionId).toBe(childSessionId)
    expect(typeof handle.id).toBe("string")
    expect(handle.id.length).toBeGreaterThan(0)
  })

  it("subscribeEvents yields canonical events and ends with result.final", async () => {
    const messages: ClaudeSDKMessage[] = [
      {
        type: "system",
        subtype: "session_started",
        session_id: "sdk-session-1",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I'll help you with that." }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          ],
        },
      },
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "export default {}",
      },
      {
        type: "result",
        subtype: "success",
        result: "Done writing the test",
      },
    ]

    const client = createMockClaudeClient(messages)
    const adapter = createClaudeAdapter(client)
    const handle = await adapter.startJob({ childSessionId, prompt: "write a test" })

    const events: import("../src/core/events.js").DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(handle.id)) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThan(0)

    // Last event must be result.final
    const last = events[events.length - 1]
    expect(last.type).toBe("result.final")
    if (last.type === "result.final") {
      expect(last.summary).toBe("Done writing the test")
    }

    // Should contain an assistant.delta
    const hasAssistantDelta = events.some((e) => e.type === "assistant.delta")
    expect(hasAssistantDelta).toBe(true)

    // Should contain a tool.start
    const hasToolStart = events.some((e) => e.type === "tool.start")
    expect(hasToolStart).toBe(true)

    // Should contain a status.update from system message
    const hasStatusUpdate = events.some((e) => e.type === "status.update")
    expect(hasStatusUpdate).toBe(true)
  })
})
