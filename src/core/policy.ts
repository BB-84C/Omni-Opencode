import { posix } from "path"
import type { Backend } from "./jobs.js"

export type DelegationPolicyOptions = {
  allowEdits: boolean
  allowShell: boolean
  allowNetwork: boolean
  projectRoot: string
  allowedBackends?: Backend[]
  maxConcurrentJobs?: number
  timeoutMs?: number
}

export type DelegationPolicy = {
  allowsPath(absolutePath: string): boolean
  allowsBackend(backend: Backend): boolean
  allowsShell(): boolean
  allowsNetwork(): boolean
  allowsEdits(): boolean
  maxConcurrentJobs: number
  timeoutMs: number
}

export function buildDelegationPolicy(opts: DelegationPolicyOptions): DelegationPolicy {
  const normalizedRoot = posix.resolve(opts.projectRoot)
  const allowedBackends: Backend[] = opts.allowedBackends ?? ["codex", "claude-code"]
  const maxConcurrentJobs = opts.maxConcurrentJobs ?? 3
  const timeoutMs = opts.timeoutMs ?? 300_000

  return {
    allowsPath(absolutePath: string): boolean {
      const normalizedPath = posix.resolve(absolutePath)
      return normalizedPath.startsWith(normalizedRoot + "/") || normalizedPath === normalizedRoot
    },
    allowsBackend(backend: Backend): boolean {
      return allowedBackends.includes(backend)
    },
    allowsShell(): boolean {
      return opts.allowShell
    },
    allowsNetwork(): boolean {
      return opts.allowNetwork
    },
    allowsEdits(): boolean {
      return opts.allowEdits
    },
    maxConcurrentJobs,
    timeoutMs,
  }
}
