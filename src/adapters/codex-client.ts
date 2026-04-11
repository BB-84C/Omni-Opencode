import { spawn } from "child_process"
import { createInterface } from "readline"
import type { CodexCapabilityPolicy } from "../core/codex-policy.js"

// ---------------------------------------------------------------------------
// Real Codex app-server v2 notification types (from `codex app-server generate-ts`)
// ---------------------------------------------------------------------------

export type CodexNotification =
  | {
      method: "turn/started"
      params: { threadId: string; turn: { id: string; status: string; error: unknown } }
    }
  | {
      method: "turn/completed"
      params: { threadId: string; turn: { id: string; status: string; error: unknown } }
    }
  | {
      method: "item/agentMessage/delta"
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | {
      method: "item/commandExecution/outputDelta"
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | {
      method: "item/fileChange/outputDelta"
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | { method: "error"; params: { message: string } }

export interface CodexClient {
  startThread(params: { prompt: string; cwd?: string; policy?: CodexCapabilityPolicy }): Promise<{ threadId: string }>
  cancelThread(threadId: string): Promise<void>
  subscribeNotifications(threadId: string): AsyncIterable<CodexNotification>
  close(): void
}

// ---------------------------------------------------------------------------
// Async queue — buffers pushed items until consumed by an async iterator.
// A null push signals end-of-stream.
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  private buffer: (T | null)[] = []
  private waiters: Array<() => void> = []
  private ended = false

  push(item: T | null): void {
    if (this.ended) return
    if (item === null) this.ended = true
    this.buffer.push(item)
    this.waiters.shift()?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        const item = this.buffer.shift()!
        if (item === null) return
        yield item
      } else {
        await new Promise<void>(r => {
          this.waiters.push(r)
        })
      }
    }
  }
}

// Notification methods we track; others are silently dropped to keep the
// queue clean and mapCodexEvent's switch exhaustive.
const TRACKED_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
])

// ---------------------------------------------------------------------------
// Factory — spawns codex app-server and speaks JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

export function createCodexClient(): CodexClient {
  const proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    shell: true, // required on Windows to resolve npm global binaries via PATH
  })

  let requestId = 0
  const pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  const threadQueues = new Map<string, AsyncQueue<CodexNotification>>()

  function getOrCreateQueue(threadId: string): AsyncQueue<CodexNotification> {
    if (!threadQueues.has(threadId)) {
      threadQueues.set(threadId, new AsyncQueue())
    }
    return threadQueues.get(threadId)!
  }

  const rl = createInterface({ input: proc.stdout! })

  rl.on("line", line => {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    // Response to a client request — numeric id, no method
    if (typeof msg.id === "number" && !("method" in msg)) {
      const pending = pendingRequests.get(msg.id)
      if (pending) {
        if (msg.error) {
          const err = msg.error as Record<string, unknown>
          pending.reject(new Error(String(err.message ?? JSON.stringify(err))))
        } else {
          pending.resolve(msg.result)
        }
        pendingRequests.delete(msg.id)
      }
      return
    }

    // Server-initiated request (has id + method) — auto-approve all
    if ("id" in msg && "method" in msg) {
      const method = msg.method as string
      let result: unknown = null
      if (method === "item/commandExecution/requestApproval") result = { decision: "accept" }
      else if (method === "item/fileChange/requestApproval") result = { decision: "accept" }
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")
      return
    }

    // Notification (method only, no id) — only enqueue tracked types with a threadId
    if ("method" in msg && !("id" in msg)) {
      const method = msg.method as string
      const params = (msg.params ?? {}) as Record<string, unknown>
      const threadId = params.threadId as string | undefined

      if (threadId && TRACKED_METHODS.has(method)) {
        const notification = msg as unknown as CodexNotification
        const queue = getOrCreateQueue(threadId)
        queue.push(notification)
        // End the stream on terminal events
        if (method === "turn/completed") {
          queue.push(null)
        }
      }
    }
  })

  // When the process exits, unblock all waiting consumers
  rl.on("close", () => {
    for (const queue of threadQueues.values()) queue.push(null)
    for (const { reject } of pendingRequests.values()) {
      reject(new Error("codex app-server process exited"))
    }
    pendingRequests.clear()
  })

  proc.on("error", err => {
    for (const { reject } of pendingRequests.values()) reject(err)
    pendingRequests.clear()
  })

  function send(method: string, params: unknown): Promise<unknown> {
    const id = ++requestId
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })
    })
  }

  // Initialize the connection immediately
  const initPromise = send("initialize", {
    clientInfo: { name: "omni-opencode", title: null, version: "0.1.0" },
    capabilities: null,
  })

  return {
    async startThread({ prompt, cwd, policy }) {
      await initPromise

      // Create a thread — response is { thread: { id, ... } }
      const threadResult = (await send("thread/start", {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        cwd: cwd ?? null,
        ...(policy ? { ...policy } : {}),
      })) as { thread: { id: string } }

      const threadId = threadResult.thread.id

      // Pre-create queue so no notifications are dropped before subscribeNotifications is called
      getOrCreateQueue(threadId)

      // Fire turn/start without awaiting — the AI response arrives as notifications
      send("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }).catch(() => {
        // Errors will surface as error notifications or process exit
      })

      return { threadId }
    },

    async cancelThread(threadId) {
      await initPromise
      await send("turn/interrupt", { threadId })
    },

    async *subscribeNotifications(threadId) {
      yield* getOrCreateQueue(threadId)
    },

    close() {
      proc.kill()
    },
  }
}
