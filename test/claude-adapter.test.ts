import { describe, it, expect } from "vitest"
import { mapClaudeMessage, createClaudeAdapter } from "../src/adapters/claude-adapter.js"
import type { ClaudeSDKMessage, ClaudeClient, ClaudeSDKPolicy } from "../src/adapters/claude-client.js"
import type { DelegationCapabilities } from "../src/core/delegation-permissions.js"
import * as policyMappers from "../src/adapters/policy-mappers.js"
import { loadDelegationPlugin, makeContext } from "./helpers/delegation-plugin-fixture.js"

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

function mapClaudeCapabilities(capabilities: DelegationCapabilities) {
  const mapper = (policyMappers as {
    toClaudeCapabilityPolicy?: (value: DelegationCapabilities) => {
      allowedTools: string[]
      disallowedTools: string[]
      permissionMode: string
    }
  }).toClaudeCapabilityPolicy

  if (typeof mapper !== "function") {
    throw new Error("Expected policy-mappers to export toClaudeCapabilityPolicy")
  }

  return mapper(capabilities)
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

describe("toClaudeCapabilityPolicy", () => {
  it("maps read-only capabilities to read tools with provider prompting disabled", () => {
    expect(mapClaudeCapabilities({
      workspaceWrite: "deny",
      shell: "deny",
      network: "allow",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })).toEqual({
      allowedTools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    })
  })

  it("adds write tools when workspace writes are allowed", () => {
    expect(mapClaudeCapabilities({
      workspaceWrite: "allow",
      shell: "deny",
      network: "allow",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })).toEqual({
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "WebFetch", "WebSearch"],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    })
  })

  it("adds bash tools when shell access is allowed", () => {
    expect(mapClaudeCapabilities({
      workspaceWrite: "deny",
      shell: "allow",
      network: "allow",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })).toEqual({
      allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    })
  })

  it("disallows network tools when network access is denied", () => {
    expect(mapClaudeCapabilities({
      workspaceWrite: "allow",
      shell: "allow",
      network: "deny",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })).toEqual({
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      disallowedTools: ["WebFetch", "WebSearch"],
      permissionMode: "bypassPermissions",
    })
  })

  it("adds network tools when network access is allowed", () => {
    expect(mapClaudeCapabilities({
      workspaceWrite: "allow",
      shell: "allow",
      network: "allow",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })).toEqual({
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch"],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    })
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

  it("passes mapped Claude policy through to client.run", async () => {
    const received: Array<{ prompt: string; cwd?: string; policy?: ClaudeSDKPolicy }> = []
    const client: ClaudeClient = {
      async *run(params) {
        received.push(params)
        yield {
          type: "result",
          subtype: "success",
          result: "completed",
        }
      },
      abort() {},
    }
    const adapter = createClaudeAdapter(client)
    const policy = mapClaudeCapabilities({
      workspaceWrite: "allow",
      shell: "allow",
      network: "deny",
      subagentLaunch: "deny",
      allowedRoots: ["/repo"],
    })
    const handle = await adapter.startJob({
      childSessionId,
      prompt: "write a test",
      policy,
    })

    for await (const _event of adapter.subscribeEvents(handle.id)) {
      // consume stream
    }

    expect(received).toEqual([{
      prompt: "write a test",
      cwd: undefined,
      policy,
    }])
  })

  it("launches Claude with read-only tools from the authoritative envelope", async () => {
    const { plugin, runtime } = await loadDelegationPlugin({
      stateName: "claude-authoritative-readonly",
    })
    const context = makeContext("parent-session-claude-readonly", "message-1", {
      permissions: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
      },
      authoritativeDelegationPermissions: {
        permissions: {
          edit: "deny",
          bash: "deny",
          webfetch: "deny",
          task: "deny",
        },
        externalDirectories: ["D:/Omni-Opencode/.worktrees/authoritative-readonly"],
      },
    })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect src/plugin.ts" },
      context as never,
    )

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude-code",
      launchMetadata: expect.objectContaining({
        claudePolicy: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowedTools: expect.arrayContaining(["Read", "Glob", "Grep"]),
          disallowedTools: expect.arrayContaining(["WebFetch", "WebSearch"]),
        }),
      }),
    }))
  })

  it("launches Claude with write and shell tools from the authoritative envelope", async () => {
    const { plugin, runtime } = await loadDelegationPlugin({
      stateName: "claude-authoritative-write-shell",
    })
    const context = makeContext("parent-session-claude-write-shell", "message-1", {
      permissions: {
        edit: "deny",
        bash: "deny",
      },
      authoritativeDelegationPermissions: {
        permissions: {
          edit: "allow",
          bash: "allow",
          webfetch: "deny",
          task: "deny",
        },
        externalDirectories: ["D:/Omni-Opencode/.worktrees/pty-monitor"],
      },
    })

    await plugin.tool!.delegate_to_claude.execute(
      { prompt: "edit src/plugin.ts and run npm test" },
      context as never,
    )

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude-code",
      launchMetadata: expect.objectContaining({
        claudePolicy: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowedTools: expect.arrayContaining(["Edit", "Write", "Bash"]),
          disallowedTools: expect.arrayContaining(["WebFetch", "WebSearch"]),
        }),
      }),
    }))
  })
})
