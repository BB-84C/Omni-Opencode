import { describe, it, expect, vi, beforeEach } from "vitest"
import { createSessionManager } from "../src/plugin/session-manager.js"
import type { OpenCodeClient } from "../src/plugin/session-manager.js"

function makeMockClient(): OpenCodeClient {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-session-abc" } }),
      get: vi.fn().mockResolvedValue({ data: { id: "child-session-abc", metadata: { backend: "codex" } } }),
    },
    message: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe("createSessionManager", () => {
  let client: OpenCodeClient

  beforeEach(() => {
    client = makeMockClient()
  })

  it("createDelegatedChild calls session.create with correct params and returns child ID", async () => {
    const manager = createSessionManager(client)
    const childId = await manager.createDelegatedChild({
      parentSessionId: "parent-123",
      title: "Fix the tests",
      backend: "codex",
      brokerJobId: "broker-job-1",
      cwd: "/workspace",
    })

    expect(childId).toBe("child-session-abc")
    expect(client.session.create).toHaveBeenCalledOnce()
    expect(client.session.create).toHaveBeenCalledWith({
      parentId: "parent-123",
      title: "Fix the tests",
      metadata: {
        backend: "codex",
        brokerJobId: "broker-job-1",
        cwd: "/workspace",
      },
    })
  })

  it("createDelegatedChild works without optional fields", async () => {
    const manager = createSessionManager(client)
    const childId = await manager.createDelegatedChild({
      parentSessionId: "parent-456",
      title: "Do something",
      backend: "claude-code",
    })

    expect(childId).toBe("child-session-abc")
    expect(client.session.create).toHaveBeenCalledWith({
      parentId: "parent-456",
      title: "Do something",
      metadata: {
        backend: "claude-code",
      },
    })
  })

  it("postMessage calls message.create with correct sessionId and content", async () => {
    const manager = createSessionManager(client)
    await manager.postMessage("child-session-abc", "Hello from broker", "assistant")

    expect(client.message.create).toHaveBeenCalledOnce()
    expect(client.message.create).toHaveBeenCalledWith({
      sessionId: "child-session-abc",
      role: "assistant",
      content: "Hello from broker",
    })
  })

  it("postMessage defaults role to 'assistant' when not specified", async () => {
    const manager = createSessionManager(client)
    await manager.postMessage("child-session-abc", "Some content")

    expect(client.message.create).toHaveBeenCalledWith({
      sessionId: "child-session-abc",
      role: "assistant",
      content: "Some content",
    })
  })

  it("getSession returns the session data from the client", async () => {
    const manager = createSessionManager(client)
    const session = await manager.getSession("child-session-abc")

    expect(session).toEqual({ id: "child-session-abc", metadata: { backend: "codex" } })
    expect(client.session.get).toHaveBeenCalledOnce()
    expect(client.session.get).toHaveBeenCalledWith("child-session-abc")
  })
})
