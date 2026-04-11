import { createHash } from "node:crypto"
import path from "node:path"

export type DelegatedCapabilityDecision = "allow" | "ask" | "deny"

export type DelegationCapabilities = {
  workspaceWrite: DelegatedCapabilityDecision
  shell: DelegatedCapabilityDecision
  network: DelegatedCapabilityDecision
  subagentLaunch: DelegatedCapabilityDecision
  // Canonical roots: normalized, deduped, and sorted for stable grant keys.
  allowedRoots: string[]
}

type OpenCodeDelegationPermissionState = Record<
  "edit" | "bash" | "webfetch" | "task",
  DelegatedCapabilityDecision
>

export type DelegationPermissionInput = {
  permissions: OpenCodeDelegationPermissionState
  externalDirectories: string[]
}

export function canonicalizeDelegationCapabilities(
  capabilities: DelegationCapabilities,
): DelegationCapabilities {
  return {
    workspaceWrite: capabilities.workspaceWrite,
    shell: capabilities.shell,
    network: capabilities.network,
    subagentLaunch: capabilities.subagentLaunch,
    allowedRoots: canonicalizeAllowedRoots(capabilities.allowedRoots),
  }
}

export function normalizeDelegationRoot(root: string): string {
  const isUncPath = /^[/\\]{2}[^/\\]/.test(root)
  const useWindowsPath = isUncPath || /^[A-Za-z]:/.test(root)
  let normalized = useWindowsPath ? path.win32.normalize(root) : path.posix.normalize(root.replace(/\\/g, "/"))

  normalized = normalized.replace(/\\/g, "/")

  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = normalized.toLowerCase()
  }

  if (isUncPath && normalized.startsWith("/") && !normalized.startsWith("//")) {
    normalized = `/${normalized}`
  }

  if (normalized.length > 1 && normalized !== "/" && !/^[a-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, "")
  }

  return normalized
}

function canonicalizeAllowedRoots(roots: string[]): string[] {
  return [...new Set(roots.map(normalizeDelegationRoot))].sort()
}

export function deriveDelegationCapabilities(
  input: DelegationPermissionInput,
): DelegationCapabilities {
  return canonicalizeDelegationCapabilities({
    workspaceWrite: input.permissions.edit,
    shell: input.permissions.bash,
    network: input.permissions.webfetch,
    subagentLaunch: input.permissions.task,
    allowedRoots: input.externalDirectories,
  })
}

export function fingerprintDelegationPermissions(
  input: DelegationPermissionInput,
): string {
  return fingerprintDelegationCapabilities(deriveDelegationCapabilities(input))
}

export function fingerprintDelegationCapabilities(
  capabilities: DelegationCapabilities,
): string {
  const canonicalCapabilities = canonicalizeDelegationCapabilities(capabilities)
  const normalizedPayload = {
    workspaceWrite: canonicalCapabilities.workspaceWrite,
    shell: canonicalCapabilities.shell,
    network: canonicalCapabilities.network,
    subagentLaunch: canonicalCapabilities.subagentLaunch,
    allowedRoots: canonicalCapabilities.allowedRoots,
  }

  return createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex")
}
