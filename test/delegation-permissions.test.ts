import { describe, expect, it } from "vitest"

async function loadDelegationPermissionsModule() {
  return import("../src/core/delegation-permissions.js")
}

async function loadSessionApprovalStateModule() {
  return import("../src/core/session-approval-state.js")
}

async function loadDelegationGrantsModule() {
  return import("../src/core/delegation-grants.js")
}

async function loadDelegationLaunchContextModule() {
  return import("../src/core/delegation-launch-context.js")
}

function permissions(overrides: Partial<Record<"edit" | "bash" | "webfetch" | "task", "allow" | "ask" | "deny">> = {}) {
  return {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    task: "deny",
    ...overrides,
  } as const
}

function delegationGrant(overrides: Partial<{
  parentSessionId: string
  backend: "claude-code" | "codex"
  agentKey: string
  permissionEnvelopeFingerprint: string
  capability: "workspaceWrite" | "shell" | "network" | "subagentLaunch"
  workspaceRoot: string
  scope: "session"
}> = {}) {
  return {
    parentSessionId: "parent-session-1",
    backend: "codex",
    agentKey: "codex:gpt-5.4",
    permissionEnvelopeFingerprint: "fingerprint-a",
    capability: "shell",
    workspaceRoot: "D:/Omni-Opencode",
    scope: "session",
    ...overrides,
  } as const
}

describe("deriveDelegationCapabilities", () => {
  it("maps edit allow/ask/deny to workspaceWrite", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ edit: "allow" }),
        externalDirectories: [],
      }).workspaceWrite,
    ).toBe("allow")

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ edit: "ask" }),
        externalDirectories: [],
      }).workspaceWrite,
    ).toBe("ask")

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ edit: "deny" }),
        externalDirectories: [],
      }).workspaceWrite,
    ).toBe("deny")
  })

  it("maps bash to shell", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ bash: "allow" }),
        externalDirectories: [],
      }).shell,
    ).toBe("allow")
  })

  it("maps webfetch to network", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ webfetch: "ask" }),
        externalDirectories: [],
      }).network,
    ).toBe("ask")
  })

  it("maps task to subagentLaunch", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions({ task: "allow" }),
        externalDirectories: [],
      }).subagentLaunch,
    ).toBe("allow")
  })

  it("includes external directories in allowedRoots", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions(),
        externalDirectories: ["/workspace", "/shared-fixtures"],
      }).allowedRoots,
    ).toEqual(["/shared-fixtures", "/workspace"])
  })

  it("returns canonical allowedRoots", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions(),
        externalDirectories: [
          "D:/Shared//",
          "C:\\Workspace\\src\\..\\",
          "c:/workspace/./",
          "/repo/./fixtures/../shared/",
        ],
      }).allowedRoots,
    ).toEqual(["/repo/shared", "c:/workspace", "d:/shared"])
  })

  it("preserves UNC and absolute root identity while canonicalizing", async () => {
    const { deriveDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      deriveDelegationCapabilities({
        permissions: permissions(),
        externalDirectories: ["\\\\server\\share\\folder\\..\\", "//server/share/", "/", "C:\\"],
      }).allowedRoots,
    ).toEqual(["/", "//server/share", "c:/"])
  })
})

describe("fingerprintDelegationPermissions", () => {
  it("is stable for semantically equivalent permission envelopes", async () => {
    const { fingerprintDelegationPermissions } = await loadDelegationPermissionsModule()

    const fingerprintA = fingerprintDelegationPermissions({
      permissions: permissions({ edit: "allow", bash: "ask", task: "allow" }),
      externalDirectories: ["/workspace", "/shared"],
    })

    const fingerprintB = fingerprintDelegationPermissions({
      permissions: permissions({ task: "allow", bash: "ask", edit: "allow" }),
      externalDirectories: ["/shared", "/workspace"],
    })

    expect(fingerprintA).toBe(fingerprintB)
  })

  it("changes when a delegation-relevant permission changes", async () => {
    const { fingerprintDelegationPermissions } = await loadDelegationPermissionsModule()

    const fingerprintA = fingerprintDelegationPermissions({
      permissions: permissions({ edit: "allow", bash: "ask", task: "allow" }),
      externalDirectories: ["/workspace", "/shared"],
    })

    const fingerprintChanged = fingerprintDelegationPermissions({
      permissions: permissions({ edit: "allow", bash: "allow", task: "allow" }),
      externalDirectories: ["/workspace", "/shared"],
    })

    expect(fingerprintChanged).not.toBe(fingerprintA)
  })

  it("normalizes equivalent Windows roots before fingerprinting", async () => {
    const { fingerprintDelegationPermissions } = await loadDelegationPermissionsModule()

    const fingerprintA = fingerprintDelegationPermissions({
      permissions: permissions({ edit: "allow" }),
      externalDirectories: ["C:\\Workspace\\", "D:/Shared//"],
    })

    const fingerprintB = fingerprintDelegationPermissions({
      permissions: permissions({ edit: "allow" }),
      externalDirectories: ["c:/workspace", "d:\\Shared"],
    })

    expect(fingerprintA).toBe(fingerprintB)
  })

  it("matches the fingerprint of the canonical delegation envelope", async () => {
    const {
      deriveDelegationCapabilities,
      fingerprintDelegationCapabilities,
      fingerprintDelegationPermissions,
    } = await loadDelegationPermissionsModule()

    const input = {
      permissions: permissions({ edit: "allow", bash: "ask" }),
      externalDirectories: ["D:/Shared//", "c:/workspace/./"],
    }

    expect(fingerprintDelegationPermissions(input)).toBe(
      fingerprintDelegationCapabilities(deriveDelegationCapabilities(input)),
    )
  })

  it("canonicalizes capability envelopes before fingerprinting", async () => {
    const { fingerprintDelegationCapabilities } = await loadDelegationPermissionsModule()

    expect(
      fingerprintDelegationCapabilities({
        workspaceWrite: "allow",
        shell: "ask",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["D:/Shared//", "c:/workspace/./", "d:\\Shared"],
      }),
    ).toBe(
      fingerprintDelegationCapabilities({
        workspaceWrite: "allow",
        shell: "ask",
        network: "deny",
        subagentLaunch: "deny",
        allowedRoots: ["c:/workspace", "d:/shared"],
      }),
    )
  })
})

describe("delegated session grant memory", () => {
  it("matches a stored grant when parent session, agent, fingerprint, capability, workspace root, and scope all match", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant()

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: grant.workspaceRoot,
        scope: grant.scope,
      }),
    ).toEqual(grant)
  })

  it("does not match a stored grant when the agent changes", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant()

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: "claude:sonnet",
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: grant.workspaceRoot,
        scope: grant.scope,
      }),
    ).toBeUndefined()
  })

  it("does not match a stored grant when the permission fingerprint changes", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant()

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: "fingerprint-b",
        capability: grant.capability,
        workspaceRoot: grant.workspaceRoot,
        scope: grant.scope,
      }),
    ).toBeUndefined()
  })

  it("does not match a stored grant when the workspace root changes", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant()

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: "D:/Other-Workspace",
        scope: grant.scope,
      }),
    ).toBeUndefined()
  })

  it("normalizes workspace roots before matching grant keys", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant({ capability: "workspaceWrite" })

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: "d:\\omni-opencode\\.\\",
        scope: grant.scope,
      }),
    ).toEqual(grant)
  })

  it("matches purely on grant keys without embedding decision precedence", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant({ capability: "workspaceWrite" })

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: grant.backend,
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: grant.workspaceRoot,
        scope: grant.scope,
      }),
    ).toEqual(grant)
  })

  it("does not match a stored grant when the delegated backend changes", async () => {
    const { findMatchingDelegationGrant } = await loadDelegationGrantsModule()
    const grant = delegationGrant({ backend: "claude-code" })

    expect(
      findMatchingDelegationGrant({
        grants: [grant],
        parentSessionId: grant.parentSessionId,
        backend: "codex",
        agentKey: grant.agentKey,
        permissionEnvelopeFingerprint: grant.permissionEnvelopeFingerprint,
        capability: grant.capability,
        workspaceRoot: grant.workspaceRoot,
        scope: grant.scope,
      }),
    ).toBeUndefined()
  })
})

describe("readDelegationLaunchContext", () => {
  it("uses launch-scoped fallback keys when agent and workspace root are missing", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext({
      sessionID: "parent-session-1",
      messageID: "message-1",
      permissions: {},
    })).resolves.toMatchObject({
      agentKey: "missing-agent:parent-session-1:message-1",
      workspaceRoot: "missing-workspace:parent-session-1:message-1",
      runtimeCwd: undefined,
    })
  })

  it("changes fallback keys when the launch context changes", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    const first = await readDelegationLaunchContext({
      sessionID: "parent-session-1",
      messageID: "message-1",
      permissions: {},
    })

    const second = await readDelegationLaunchContext({
      sessionID: "parent-session-1",
      messageID: "message-2",
      permissions: {},
    })

    expect(second.agentKey).not.toBe(first.agentKey)
    expect(second.workspaceRoot).not.toBe(first.workspaceRoot)
  })

  it("canonicalizes fallback hash inputs so permission object key order does not change fallback keys", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    const first = await readDelegationLaunchContext({
      permissions: { edit: "allow", bash: "deny" },
      directory: "D:/Omni-Opencode",
      externalDirectories: ["D:/Shared"],
    })

    const second = await readDelegationLaunchContext({
      permissions: { bash: "deny", edit: "allow" },
      directory: "D:/Omni-Opencode",
      externalDirectories: ["D:/Shared"],
    })

    expect(second.agentKey).toBe(first.agentKey)
    expect(second.workspaceRoot).toBe(first.workspaceRoot)
  })
})
