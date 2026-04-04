import { describe, expect, it } from "vitest"
import { mapCodexEvent, createCodexAdapter } from "../src/adapters/codex-adapter.js"
import type { CodexNotification, CodexClient } from "../src/adapters/codex-client.js"
import type { JobStartParams } from "../src/adapters/types.js"

function createMockCodexClient(notifications: CodexNotification[]): CodexClient {
  return {
    async startThread() {
      return { threadId: "t1" }
    },
    async cancelThread() {},
    async *subscribeNotifications() {
      yield* notifications
    },
    close() {},
  }
}

describe("mapCodexEvent (v2 protocol)", () => {
  it("maps turn/started → status.update", () => {
    const notification: CodexNotification = {
      method: "turn/started",
      params: { threadId: "t1", turnId: "turn-1" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("status.update")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "status.update") {
      expect(event.message).toBe("Turn started")
    }
  })

  it("maps item/agentMessage/delta → assistant.delta with delta text", () => {
    const notification: CodexNotification = {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", delta: "Hello, world!" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("assistant.delta")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "assistant.delta") {
      expect(event.text).toBe("Hello, world!")
    }
  })

  it("maps turn/completed (status=completed) → result.final", () => {
    const notification: CodexNotification = {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed", error: null } },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("result.final")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "result.final") {
      expect(event.summary).toBe("Turn completed")
    }
  })

  it("maps turn/completed (status=failed) → error", () => {
    const notification: CodexNotification = {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "failed", error: { message: "oops" } } },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("error")
  })

  it("maps item/commandExecution/outputDelta → command.stdout.delta", () => {
    const notification: CodexNotification = {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", delta: "test output" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("command.stdout.delta")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "command.stdout.delta") {
      expect(event.text).toBe("test output")
    }
  })

  it("maps item/fileChange/outputDelta → status.update", () => {
    const notification: CodexNotification = {
      method: "item/fileChange/outputDelta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", delta: "Modified src/foo.ts" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("status.update")
  })

  it("maps error notification → error event", () => {
    const notification: CodexNotification = {
      method: "error",
      params: { message: "something went wrong" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("error")
    if (event.type === "error") {
      expect(event.message).toBe("something went wrong")
    }
  })
})

describe("createCodexAdapter", () => {
  it("startJob with mock client returns a handle", async () => {
    const client = createMockCodexClient([])
    const adapter = createCodexAdapter(client)
    const params: JobStartParams = {
      childSessionId: "child-1",
      prompt: "Do something",
      cwd: "/tmp",
    }
    const handle = await adapter.startJob(params)
    expect(handle).toBeDefined()
    expect(handle.childSessionId).toBe("child-1")
    expect(typeof handle.id).toBe("string")
  })

  it("subscribeEvents yields mapped canonical events from mock client notifications", async () => {
    const notifications: CodexNotification[] = [
      { method: "turn/started", params: { threadId: "t1", turnId: "turn-1" } },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
      },
      {
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn-1", status: "completed", error: null } },
      },
    ]
    const client = createMockCodexClient(notifications)
    const adapter = createCodexAdapter(client)
    const params: JobStartParams = { childSessionId: "child-2", prompt: "Do something" }
    const handle = await adapter.startJob(params)
    const events: unknown[] = []
    for await (const event of adapter.subscribeEvents(handle.id)) {
      events.push(event)
    }
    expect(events).toHaveLength(3)
    expect((events[0] as { type: string }).type).toBe("status.update")
    expect((events[1] as { type: string }).type).toBe("assistant.delta")
    expect((events[2] as { type: string }).type).toBe("result.final")
  })
})
