import { describe, it, expect } from "vitest"
import { buildDelegationPolicy } from "../src/core/policy.js"
import { toCodexPolicy, toClaudePolicy } from "../src/adapters/policy-mappers.js"

describe("DelegationPolicy - allowsPath", () => {
  it("returns true for path inside projectRoot", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: true,
      allowNetwork: true,
      projectRoot: "/repo",
    })
    expect(policy.allowsPath("/repo/src/index.ts")).toBe(true)
  })

  it("returns false for path outside projectRoot", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: true,
      allowNetwork: true,
      projectRoot: "/repo",
    })
    expect(policy.allowsPath("/etc/passwd")).toBe(false)
  })

  it("handles path normalization (trailing slash, .. segments)", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: true,
      allowNetwork: true,
      projectRoot: "/repo/",
    })
    // Path with .. that resolves inside the root
    expect(policy.allowsPath("/repo/src/../src/index.ts")).toBe(true)
    // Path with .. that escapes the root
    expect(policy.allowsPath("/repo/../etc/passwd")).toBe(false)
  })
})

describe("DelegationPolicy - allowsBackend", () => {
  it("blocks a backend not in allowedBackends", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: false,
      allowNetwork: false,
      projectRoot: "/repo",
      allowedBackends: ["claude-code"],
    })
    expect(policy.allowsBackend("codex")).toBe(false)
  })

  it("allows when no restriction set (defaults to both)", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: false,
      allowNetwork: false,
      projectRoot: "/repo",
    })
    expect(policy.allowsBackend("codex")).toBe(true)
    expect(policy.allowsBackend("claude-code")).toBe(true)
  })
})

describe("toCodexPolicy", () => {
  it("sets sandboxed=true when allowShell=false", () => {
    const policy = buildDelegationPolicy({
      allowEdits: true,
      allowShell: false,
      allowNetwork: true,
      projectRoot: "/repo",
    })
    const settings = toCodexPolicy(policy)
    expect(settings.sandboxed).toBe(true)
    expect(settings.allowShell).toBe(false)
    expect(settings.allowEdits).toBe(true)
    expect(settings.allowNetwork).toBe(true)
  })
})

describe("toClaudePolicy", () => {
  it("includes 'Bash' only when allowShell=true", () => {
    const policyWithShell = buildDelegationPolicy({
      allowEdits: false,
      allowShell: true,
      allowNetwork: false,
      projectRoot: "/repo",
    })
    const policyNoShell = buildDelegationPolicy({
      allowEdits: false,
      allowShell: false,
      allowNetwork: false,
      projectRoot: "/repo",
    })
    expect(toClaudePolicy(policyWithShell).allowedTools).toContain("Bash")
    expect(toClaudePolicy(policyNoShell).allowedTools).not.toContain("Bash")
  })

  it("always includes read tools", () => {
    const policy = buildDelegationPolicy({
      allowEdits: false,
      allowShell: false,
      allowNetwork: false,
      projectRoot: "/repo",
    })
    const settings = toClaudePolicy(policy)
    expect(settings.allowedTools).toContain("Read")
    expect(settings.allowedTools).toContain("Glob")
    expect(settings.allowedTools).toContain("Grep")
  })
})
