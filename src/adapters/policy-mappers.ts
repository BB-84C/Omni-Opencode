import type { DelegationPolicy } from "../core/policy.js"

export type CodexPolicySettings = {
  allowEdits: boolean
  allowShell: boolean
  allowNetwork: boolean
  sandboxed: boolean
}

export type ClaudePolicySettings = {
  allowedTools: string[]
  disableNetwork: boolean
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
  const allowedTools: string[] = ["Read", "Glob", "Grep"]

  if (policy.allowsEdits()) {
    allowedTools.push("Edit", "Write")
  }

  if (policy.allowsShell()) {
    allowedTools.push("Bash")
  }

  return {
    allowedTools,
    disableNetwork: !policy.allowsNetwork(),
  }
}
