// Minimal OpenCode client interface (we mock this in tests)
export interface OpenCodeClient {
  session: {
    create(params: { parentId: string; title: string; metadata?: Record<string, unknown> }): Promise<{ data: { id: string } }>
    get(id: string): Promise<{ data: { id: string; metadata?: Record<string, unknown> } }>
  }
  message: {
    create(params: { sessionId: string; role: string; content: string }): Promise<void>
  }
}

export type DelegatedChildOptions = {
  parentSessionId: string
  title: string
  backend: "codex" | "claude-code"
  brokerJobId?: string
  cwd?: string
}

export interface SessionManager {
  createDelegatedChild(opts: DelegatedChildOptions): Promise<string>
  postMessage(childSessionId: string, content: string, role?: string): Promise<void>
  getSession(id: string): Promise<{ id: string; metadata?: Record<string, unknown> }>
}

export function createSessionManager(client: OpenCodeClient): SessionManager {
  return {
    async createDelegatedChild(opts: DelegatedChildOptions): Promise<string> {
      const metadata: Record<string, unknown> = {
        backend: opts.backend,
      }
      if (opts.brokerJobId !== undefined) {
        metadata["brokerJobId"] = opts.brokerJobId
      }
      if (opts.cwd !== undefined) {
        metadata["cwd"] = opts.cwd
      }

      const result = await client.session.create({
        parentId: opts.parentSessionId,
        title: opts.title,
        metadata,
      })

      return result.data.id
    },

    async postMessage(childSessionId: string, content: string, role = "assistant"): Promise<void> {
      await client.message.create({
        sessionId: childSessionId,
        role,
        content,
      })
    },

    async getSession(id: string): Promise<{ id: string; metadata?: Record<string, unknown> }> {
      const result = await client.session.get(id)
      return result.data
    },
  }
}
