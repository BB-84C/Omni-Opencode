// ---------------------------------------------------------------------------
// SDK message types — mirror @anthropic-ai/claude-code streaming output
// ---------------------------------------------------------------------------

export type ClaudeSDKMessage =
  | {
      type: "assistant"
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >
      }
    }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "result"; subtype: "success" | "error"; result?: string; is_error?: boolean }
  | { type: "system"; subtype: string; session_id?: string }

export interface ClaudeClient {
  run(params: { prompt: string; cwd?: string; sessionId?: string }): AsyncIterable<ClaudeSDKMessage>
  abort(): void
}

// ---------------------------------------------------------------------------
// Factory — gracefully handles missing @anthropic-ai/claude-code package
// ---------------------------------------------------------------------------

export function createClaudeClient(): ClaudeClient {
  // We use a flag to track whether the real SDK is available.
  // The actual import is deferred to run() so the module always loads.
  let sdkAvailable: boolean | undefined = undefined
  let sdkModule: unknown = undefined

  async function tryLoadSdk(): Promise<boolean> {
    if (sdkAvailable !== undefined) return sdkAvailable
    try {
      sdkModule = await import("@anthropic-ai/claude-code")
      sdkAvailable = true
    } catch {
      sdkAvailable = false
    }
    return sdkAvailable
  }

  return {
    async *run(params: {
      prompt: string
      cwd?: string
      sessionId?: string
    }): AsyncIterable<ClaudeSDKMessage> {
      const available = await tryLoadSdk()
      if (!available) {
        throw new Error("@anthropic-ai/claude-code not available")
      }

      // Use the SDK module to run the agent
      // The @anthropic-ai/claude-code package exports a `query` function
      // that returns an async iterable of messages.
      const sdk = sdkModule as {
        query?: (opts: {
          prompt: string
          cwd?: string
          resume?: string
          options?: Record<string, unknown>
        }) => AsyncIterable<unknown>
      }

      if (typeof sdk.query !== "function") {
        throw new Error("@anthropic-ai/claude-code does not export a query function")
      }

      const iterable = sdk.query({
        prompt: params.prompt,
        cwd: params.cwd,
        resume: params.sessionId,
      })

      for await (const msg of iterable) {
        // Cast to our expected shape — the SDK may not match exactly,
        // but mapClaudeMessage handles unrecognized types gracefully.
        yield msg as ClaudeSDKMessage
      }
    },

    abort() {
      // The @anthropic-ai/claude-code SDK does not expose a standalone abort
      // on the client instance level — abort is typically done by breaking
      // out of the async iterable. This is a best-effort no-op placeholder.
    },
  }
}
