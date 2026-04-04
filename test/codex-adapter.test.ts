import { describe, it, expect } from "vitest"
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
  }
}

describe("mapCodexEvent", () => {
  it("maps turn/started → status.update", () => {
    const notification: CodexNotification = {
      method: "turn/started",
      params: { threadId: "t1", turnId: "turn-1" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("status.update")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "status.update") {
      expect(event.message).toBe("Turn started: t1")
    }
  })

  it("maps turn/delta → assistant.delta with correct text", () => {
    const notification: CodexNotification = {
      method: "turn/delta",
      params: { threadId: "t1", text: "Hello, world!" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("assistant.delta")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "assistant.delta") {
      expect(event.text).toBe("Hello, world!")
    }
  })

  it("maps turn/completed → result.final with changedFiles", () => {
    const notification: CodexNotification = {
      method: "turn/completed",
      params: { threadId: "t1", summary: "Done!", changedFiles: ["foo.ts", "bar.ts"] },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("result.final")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "result.final") {
      expect(event.summary).toBe("Done!")
      expect(event.changedFiles).toEqual(["foo.ts", "bar.ts"])
    }
  })

  it("maps tool/start → tool.start", () => {
    const notification: CodexNotification = {
      method: "tool/start",
      params: { threadId: "t1", name: "bash", input: { command: "ls" } },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("tool.start")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "tool.start") {
      expect(event.toolName).toBe("bash")
      expect(event.input).toEqual({ command: "ls" })
    }
  })

  it("maps command/start → command.start", () => {
    const notification: CodexNotification = {
      method: "command/start",
      params: { threadId: "t1", command: "npm test" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("command.start")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "command.start") {
      expect(event.command).toBe("npm test")
    }
  })

  it("maps file/changed → file.change", () => {
    const notification: CodexNotification = {
      method: "file/changed",
      params: { threadId: "t1", path: "src/foo.ts", type: "modified" },
    }
    const event = mapCodexEvent(notification, "session-1")
    expect(event.type).toBe("file.change")
    expect(event.sessionId).toBe("session-1")
    if (event.type === "file.change") {
      expect(event.path).toBe("src/foo.ts")
      expect(event.changeType).toBe("modified")
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
      { method: "turn/delta", params: { threadId: "t1", text: "Hello" } },
      { method: "turn/completed", params: { threadId: "t1", summary: "All done" } },
    ]
    const client = createMockCodexClient(notifications)
    const adapter = createCodexAdapter(client)
    const params: JobStartParams = {
      childSessionId: "child-2",
      prompt: "Do something",
    }
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
