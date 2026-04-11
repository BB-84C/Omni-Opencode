export type CodexCapabilityPolicy = {
  sandboxMode: "read-only" | "workspace-write"
  writableRoots: string[]
  networkAccess: boolean
  approvalPolicy: "never"
}

export function defaultCodexLaunchPolicy(): CodexCapabilityPolicy {
  return {
    sandboxMode: "read-only",
    writableRoots: [],
    networkAccess: false,
    approvalPolicy: "never",
  }
}
