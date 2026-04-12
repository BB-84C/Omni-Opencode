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
  it("uses authoritative permission input when legacy context permissions disagree", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext({
      permissions: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        task: "allow",
      },
      authoritativeDelegationPermissions: {
        permissions: {
          edit: "ask",
          bash: "deny",
          webfetch: "deny",
          task: "deny",
        },
        externalDirectories: ["D:/Authoritative-Only"],
      },
    })).resolves.toMatchObject({
      permissionInput: {
        permissions: {
          edit: "ask",
          bash: "deny",
          webfetch: "deny",
          task: "deny",
        },
        externalDirectories: ["D:/Authoritative-Only"],
      },
    })
  })

  it("uses launch-scoped fallback keys when agent and workspace root are missing", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext({
      sessionID: "parent-session-1",
      messageID: "message-1",
      authoritativeDelegationPermissions: {
        permissions: permissions(),
        externalDirectories: [],
      },
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
      authoritativeDelegationPermissions: {
        permissions: permissions(),
        externalDirectories: [],
      },
    })

    const second = await readDelegationLaunchContext({
      sessionID: "parent-session-1",
      messageID: "message-2",
      authoritativeDelegationPermissions: {
        permissions: permissions(),
        externalDirectories: [],
      },
    })

    expect(second.agentKey).not.toBe(first.agentKey)
    expect(second.workspaceRoot).not.toBe(first.workspaceRoot)
  })

  it("fails closed when authoritative delegation permissions are unavailable", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext({
      directory: "D:/Omni-Opencode",
      externalDirectories: ["D:/Shared"],
    })).rejects.toThrow(/authoritative permission/i)
  })

  it("fails closed when the current agent has no usable permission payload", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
        externalDirectories: ["D:/Leaked-Root"],
      },
      {
        app: {
          agents: async () => [{ name: "build" }],
        },
      },
    )).rejects.toThrow(/agent permission|authoritative permission/i)
  })

  it("supports host client agents methods that require the app receiver binding", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          _client: {},
          async agents(this: { _client?: unknown }) {
            if (!this._client) {
              throw new Error("missing bound app client")
            }

            return {
              data: [{
                name: "build",
                permission: {
                  edit: "allow",
                  bash: "allow",
                  webfetch: "deny",
                },
              }],
            }
          },
        },
      },
    )).resolves.toMatchObject({
      permissionInput: {
        permissions: {
          edit: "allow",
          bash: "allow",
          webfetch: "deny",
          task: "deny",
        },
      },
    })
  })

  it("does not fall back to explicit context authority when a live authority client is provided", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
        authoritativeDelegationPermissions: {
          permissions: {
            edit: "allow",
            bash: "allow",
            webfetch: "allow",
            task: "allow",
          },
          externalDirectories: ["D:/Fallback-Only"],
        },
      },
      {
        app: {
          agents: async () => [{ name: "build" }],
        },
      },
    )).rejects.toThrow(/agent permission|authoritative permission/i)
  })

  it("does not source delegated roots from raw context fields on the client authority path", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
        externalDirectories: ["D:/Leaked-Root"],
        allowedRoots: ["D:/Also-Leaked"],
      },
      {
        app: {
          agents: async () => [{
            name: "build",
            permission: {
              edit: "allow",
              bash: { "*": "deny" },
              webfetch: "deny",
            },
          }],
        },
      },
    )).resolves.toMatchObject({
      permissionInput: {
        externalDirectories: [],
      },
    })
  })

  it("accepts the real host client agent list envelope when agents() resolves to a data array", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => ({
            data: [{
              name: "build",
              permission: {
                edit: "allow",
                bash: { "*": "deny" },
                webfetch: "deny",
              },
            }],
          }),
        },
      },
    )).resolves.toMatchObject({
      agentKey: "build",
      workspaceRoot: "D:/Omni-Opencode",
      permissionInput: {
        permissions: {
          edit: "allow",
          bash: "deny",
          webfetch: "deny",
          task: "deny",
        },
        externalDirectories: [],
      },
    })
  })

  it("derives broad build permissions from a live PermissionRuleset array", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => ({
            data: [{
              name: "build",
              permission: [
                { permission: "*", action: "allow", pattern: "*" },
                { permission: "doom_loop", action: "ask", pattern: "*" },
                { permission: "external_directory", action: "deny", pattern: "*" },
              ],
            }],
          }),
        },
      },
    )).resolves.toMatchObject({
      permissionInput: {
        permissions: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          task: "allow",
        },
      },
    })
  })

  it("derives broad plan permissions from a live PermissionRuleset array conservatively", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "plan",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => ({
            data: [{
              name: "plan",
              permission: [
                { permission: "*", action: "allow", pattern: "*" },
                { permission: "edit", action: "deny", pattern: "*" },
                { permission: "edit", action: "allow", pattern: "C:/Users/Administrator/.local/share/opencode/plans/*.md" },
                { permission: "external_directory", action: "deny", pattern: "*" },
              ],
            }],
          }),
        },
      },
    )).resolves.toMatchObject({
      permissionInput: {
        permissions: {
          edit: "deny",
          bash: "allow",
          webfetch: "allow",
          task: "allow",
        },
      },
    })
  })

  it("fails closed when live agent permissions indicate external directory access without authoritative roots", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => [{
            name: "build",
            permission: {
              edit: "deny",
              bash: { "*": "deny" },
              webfetch: "deny",
              external_directory: "allow",
            },
          }],
        },
      },
    )).rejects.toThrow(/external directory|authoritative permission/i)
  })

  it("fails closed when live agent permissions provide a malformed external directory payload", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => [{
            name: "build",
            permission: {
              edit: "deny",
              bash: { "*": "deny" },
              webfetch: "deny",
              external_directory: { root: "D:/Shared" },
            },
          }],
        },
      },
    )).rejects.toThrow(/external directory|authoritative permission/i)
  })

  it("does not widen broad shell access from partial bash pattern permissions", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    await expect(readDelegationLaunchContext(
      {
        agent: "build",
        directory: "D:/Omni-Opencode",
        worktree: "D:/Omni-Opencode",
      },
      {
        app: {
          agents: async () => [{
            name: "build",
            permission: {
              edit: "deny",
              bash: { npm: "allow" },
              webfetch: "deny",
            },
          }],
        },
      },
    )).resolves.toMatchObject({
      permissionInput: {
        permissions: {
          bash: "deny",
        },
      },
    })
  })

  it("keeps fallback keys stable even when legacy permission snapshots differ", async () => {
    const { readDelegationLaunchContext } = await loadDelegationLaunchContextModule()

    const first = await readDelegationLaunchContext({
      permissions: { edit: "allow", bash: "deny" },
      authoritativeDelegationPermissions: {
        permissions: permissions(),
        externalDirectories: [],
      },
      directory: "D:/Omni-Opencode",
      externalDirectories: ["D:/Shared"],
    })

    const second = await readDelegationLaunchContext({
      permissions: { edit: "deny", bash: "allow", task: "allow" },
      authoritativeDelegationPermissions: {
        permissions: permissions(),
        externalDirectories: [],
      },
      directory: "D:/Omni-Opencode",
      externalDirectories: ["D:/Shared"],
    })

    expect(second.agentKey).toBe(first.agentKey)
    expect(second.workspaceRoot).toBe(first.workspaceRoot)
  })
})
