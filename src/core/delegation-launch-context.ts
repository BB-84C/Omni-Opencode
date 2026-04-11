import { createHash } from "node:crypto"
import type { DelegationPermissionInput, DelegatedCapabilityDecision } from "./delegation-permissions.js"

type DelegationLaunchContextLike = {
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
  permissions?: unknown
  externalDirectories?: unknown
  allowedRoots?: unknown
  directory?: unknown
  worktree?: unknown
}

export type ResolvedDelegationLaunchContext = {
  agentKey: string
  workspaceRoot: string
  runtimeCwd?: string
  permissionInput: DelegationPermissionInput
}

function normalizeDecision(value: unknown): DelegatedCapabilityDecision {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : "deny"
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(entry => normalizeString(entry))
    .filter((entry): entry is string => entry !== undefined)
}

function canonicalizeFallbackPermissions(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, decision]) => typeof decision === "string")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, decision]) => [key, decision]),
  )
}

function buildLaunchScopedFallback(prefix: string, context: DelegationLaunchContextLike): string {
  const sessionID = normalizeString(context.sessionID)
  const messageID = normalizeString(context.messageID)

  if (sessionID && messageID) {
    return `${prefix}:${sessionID}:${messageID}`
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    sessionID,
    messageID,
    directory: normalizeString(context.directory),
    worktree: normalizeString(context.worktree),
    externalDirectories: normalizeStringArray(context.externalDirectories ?? context.allowedRoots),
    permissions: canonicalizeFallbackPermissions(context.permissions),
  })).digest("hex")
  return `${prefix}:${fingerprint}`
}

export async function readDelegationLaunchContext(
  context: DelegationLaunchContextLike,
): Promise<ResolvedDelegationLaunchContext> {
  const permissions = (context.permissions ?? {}) as {
    edit?: unknown
    bash?: unknown
    webfetch?: unknown
    task?: unknown
  }

  const runtimeCwd = normalizeString(context.worktree)
    ?? normalizeString(context.directory)

  return {
    agentKey: normalizeString(context.agent) ?? buildLaunchScopedFallback("missing-agent", context),
    workspaceRoot: runtimeCwd
      ?? buildLaunchScopedFallback("missing-workspace", context),
    runtimeCwd,
    permissionInput: {
      permissions: {
        edit: normalizeDecision(permissions.edit),
        bash: normalizeDecision(permissions.bash),
        webfetch: normalizeDecision(permissions.webfetch),
        task: normalizeDecision(permissions.task),
      },
      externalDirectories: normalizeStringArray(context.externalDirectories ?? context.allowedRoots),
    },
  }
}
