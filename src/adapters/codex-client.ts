// Codex app-server uses JSON-RPC 2.0 notifications over stdio/HTTP

export type CodexNotification =
  | { method: "turn/started"; params: { threadId: string; turnId: string } }
  | { method: "turn/delta"; params: { threadId: string; text: string } }
  | { method: "turn/completed"; params: { threadId: string; summary: string; changedFiles?: string[] } }
  | { method: "tool/start"; params: { threadId: string; name: string; input?: unknown } }
  | { method: "tool/end"; params: { threadId: string; name: string; exitCode?: number } }
  | { method: "command/start"; params: { threadId: string; command: string } }
  | { method: "command/stdout"; params: { threadId: string; text: string } }
  | { method: "command/stderr"; params: { threadId: string; text: string } }
  | { method: "file/changed"; params: { threadId: string; path: string; type: "created" | "modified" | "deleted" } }
  | { method: "error"; params: { threadId: string; message: string } }

export interface CodexClient {
  startThread(params: { prompt: string; cwd?: string }): Promise<{ threadId: string }>
  cancelThread(threadId: string): Promise<void>
  subscribeNotifications(threadId: string): AsyncIterable<CodexNotification>
}

// Factory — in production this would connect to codex app-server process
// For now this is a stub; real connection is tested via integration tests
export function createCodexClient(_options?: { socketPath?: string }): CodexClient {
  return {
    async startThread(_params) {
      throw new Error("Codex app-server not available")
    },
    async cancelThread(_threadId) {
      throw new Error("Codex app-server not available")
    },
    async *subscribeNotifications(_threadId) {
      throw new Error("Codex app-server not available")
    },
  }
}
