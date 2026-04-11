import type { DelegationCapabilities } from "../core/delegation-permissions.js"
import type { ClaudeCapabilityPolicy } from "../core/claude-policy.js"
import type { CodexCapabilityPolicy } from "../core/codex-policy.js"
import type { DelegationPolicy } from "../core/policy.js"

export type CodexPolicySettings = {
  allowEdits: boolean
  allowShell: boolean
  allowNetwork: boolean
  sandboxed: boolean
}

export type ClaudePolicySettings = {
  allowedTools: string[]
  disallowedTools: string[]
  permissionMode: string
  disableNetwork: boolean
}

export function toClaudeCapabilityPolicy(capabilities: DelegationCapabilities): ClaudeCapabilityPolicy {
  const allowedTools: string[] = ["Read", "Glob", "Grep"]

  if (capabilities.workspaceWrite === "allow") {
    allowedTools.push("Edit", "Write")
  }

  if (capabilities.shell === "allow") {
    allowedTools.push("Bash")
  }

  if (capabilities.network === "allow") {
    allowedTools.push("WebFetch", "WebSearch")
  }

  return {
    allowedTools,
    disallowedTools: capabilities.network === "deny" ? ["WebFetch", "WebSearch"] : [],
    permissionMode: "bypassPermissions",
  }
}

export function toCodexCapabilityPolicy(capabilities: DelegationCapabilities): CodexCapabilityPolicy {
  const canUseWorkspaceWriteSandbox = capabilities.workspaceWrite === "allow" && capabilities.shell === "allow"

  return {
    sandboxMode: canUseWorkspaceWriteSandbox ? "workspace-write" : "read-only",
    writableRoots: capabilities.allowedRoots,
    networkAccess: capabilities.network === "allow",
    approvalPolicy: "never",
  }
}

export function toCodexPolicy(policy: DelegationPolicy): CodexPolicySettings {
  return {
    allowEdits: policy.allowsEdits(),
    allowShell: policy.allowsShell(),
    allowNetwork: policy.allowsNetwork(),
    sandboxed: !policy.allowsShell(),
  }
}

export function toClaudePolicy(policy: DelegationPolicy): ClaudePolicySettings {
  const mapped = toClaudeCapabilityPolicy({
    workspaceWrite: policy.allowsEdits() ? "allow" : "deny",
    shell: policy.allowsShell() ? "allow" : "deny",
    network: policy.allowsNetwork() ? "allow" : "deny",
    subagentLaunch: "deny",
    allowedRoots: [],
  })

  return {
    ...mapped,
    disableNetwork: !policy.allowsNetwork(),
  }
}
