import { createHash } from "node:crypto"
import type { DelegationPermissionInput, DelegatedCapabilityDecision } from "./delegation-permissions.js"

type DelegationLaunchContextLike = {
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
  permissions?: unknown
  authoritativeDelegationPermissions?: unknown
  externalDirectories?: unknown
  allowedRoots?: unknown
  directory?: unknown
  worktree?: unknown
}

type ClientAgentPermissionConfigLike = {
  edit?: unknown
  bash?: unknown
  webfetch?: unknown
  task?: unknown
  external_directory?: unknown
}

type PermissionRuleLike = {
  permission?: unknown
  action?: unknown
  pattern?: unknown
}

type ClientAgentLike = {
  name?: unknown
  permission?: ClientAgentPermissionConfigLike
}

type DelegationAuthorityClientLike = {
  app?: {
    agents?: unknown
  }
}

type ClientAgentsResultLike = {
  data?: unknown
}

export type ResolvedDelegationLaunchContext = {
  agentKey: string
  workspaceRoot: string
  runtimeCwd?: string
  permissionInput: DelegationPermissionInput
}

type DelegationPermissionEnvelopeLike = {
  permissions?: unknown
  externalDirectories?: unknown
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

function normalizePermissionInput(envelope: DelegationPermissionEnvelopeLike): DelegationPermissionInput {
  const permissions = (envelope.permissions ?? {}) as {
    edit?: unknown
    bash?: unknown
    webfetch?: unknown
    task?: unknown
  }

  return {
    permissions: {
      edit: normalizeDecision(permissions.edit),
      bash: normalizeDecision(permissions.bash),
      webfetch: normalizeDecision(permissions.webfetch),
      task: normalizeDecision(permissions.task),
    },
    externalDirectories: normalizeStringArray(envelope.externalDirectories),
  }
}

function normalizeBashDecision(value: unknown): DelegatedCapabilityDecision {
  if (typeof value === "string") {
    return normalizeDecision(value)
  }

  if (typeof value !== "object" || value === null) {
    return "deny"
  }

  const bashPermissions = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(bashPermissions, "*")) {
    return normalizeDecision(bashPermissions["*"])
  }

  return "deny"
}

function normalizeRulesetDecision(
  rules: PermissionRuleLike[],
  permission: string,
): DelegatedCapabilityDecision {
  let decision: DelegatedCapabilityDecision = "deny"

  for (const rule of rules) {
    const rulePermission = normalizeString(rule.permission)
    const rulePattern = normalizeString(rule.pattern)

    if (!rulePermission || rulePattern !== "*") {
      continue
    }

    if (rulePermission === "*" || rulePermission === permission) {
      decision = normalizeDecision(rule.action)
    }
  }

  return decision
}

function normalizeRulesetBashDecision(rules: PermissionRuleLike[]): DelegatedCapabilityDecision {
  let hasSpecificBashRule = false
  let explicitBroadBashDecision: DelegatedCapabilityDecision | undefined

  for (const rule of rules) {
    const rulePermission = normalizeString(rule.permission)
    if (rulePermission !== "bash") {
      continue
    }

    const rulePattern = normalizeString(rule.pattern)
    if (rulePattern === "*") {
      explicitBroadBashDecision = normalizeDecision(rule.action)
      continue
    }

    hasSpecificBashRule = true
  }

  if (explicitBroadBashDecision) {
    return explicitBroadBashDecision
  }

  if (hasSpecificBashRule) {
    return "deny"
  }

  return normalizeRulesetDecision(rules, "bash")
}

function normalizeRulesetExternalDirectories(rules: PermissionRuleLike[]): string[] {
  const roots = new Set<string>()

  for (const rule of rules) {
    const rulePermission = normalizeString(rule.permission)
    if (rulePermission !== "external_directory") {
      continue
    }

    const ruleAction = normalizeDecision(rule.action)
    const rulePattern = normalizeString(rule.pattern)

    if (!rulePattern) {
      continue
    }

    if (rulePattern === "*") {
      if (ruleAction === "allow") {
        throw new Error("Unable to resolve delegated agent permissions: authoritative external directory roots are too broad")
      }

      continue
    }

    if (ruleAction === "allow") {
      roots.add(rulePattern)
    }
  }

  return Array.from(roots)
}

function normalizeRulesetPermissionInput(rules: PermissionRuleLike[]): DelegationPermissionInput {
  return {
    permissions: {
      edit: normalizeRulesetDecision(rules, "edit"),
      bash: normalizeRulesetBashDecision(rules),
      webfetch: normalizeRulesetDecision(rules, "webfetch"),
      task: normalizeRulesetDecision(rules, "task"),
    },
    externalDirectories: normalizeRulesetExternalDirectories(rules),
  }
}

function normalizeAgentPermissionInput(
  permission: ClientAgentPermissionConfigLike | PermissionRuleLike[],
): DelegationPermissionInput {
  if (Array.isArray(permission)) {
    return normalizeRulesetPermissionInput(permission)
  }

  if (
    permission.external_directory !== undefined
    && permission.external_directory !== null
    && permission.external_directory !== "deny"
  ) {
    throw new Error("Unable to resolve delegated agent permissions: authoritative external directory roots are unavailable")
  }

  return {
    permissions: {
      edit: normalizeDecision(permission.edit),
      bash: normalizeBashDecision(permission.bash),
      webfetch: normalizeDecision(permission.webfetch),
      task: normalizeDecision(permission.task),
    },
    externalDirectories: [],
  }
}

async function resolveAuthoritativePermissionInputFromClient(
  context: DelegationLaunchContextLike,
  client: DelegationAuthorityClientLike,
): Promise<DelegationPermissionInput | null> {
  const app = client.app
  const agentsFn = app?.agents
  if (typeof agentsFn !== "function") {
    return null
  }

  const currentAgent = normalizeString(context.agent)
  if (!currentAgent) {
    throw new Error("Unable to resolve delegated agent permissions: current agent is unavailable")
  }

  let agentsResult: unknown
  try {
    agentsResult = await (agentsFn as (this: unknown, input?: unknown) => Promise<unknown>).call(app, {
      directory: normalizeString(context.directory),
      workspace: normalizeString(context.worktree),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to resolve delegated agent permissions: ${detail}`)
  }

  const agents: unknown[] | null = Array.isArray(agentsResult)
    ? agentsResult
    : (typeof agentsResult === "object" && agentsResult !== null && Array.isArray((agentsResult as ClientAgentsResultLike).data)
        ? (agentsResult as ClientAgentsResultLike).data as unknown[]
        : null)

  if (!agents) {
    throw new Error("Unable to resolve delegated agent permissions: agents api did not return an agent list")
  }

  const resolvedAgent = agents.find((agent): agent is ClientAgentLike => {
    if (typeof agent !== "object" || agent === null) {
      return false
    }

    return normalizeString((agent as ClientAgentLike).name) === currentAgent
  })

  if (!resolvedAgent) {
    throw new Error(`Unable to resolve delegated agent permissions: current agent \"${currentAgent}\" was not found`)
  }

  if (typeof resolvedAgent.permission !== "object" || resolvedAgent.permission === null) {
    throw new Error(`Unable to resolve delegated agent permissions: current agent \"${currentAgent}\" did not provide a usable permission payload`)
  }

  return normalizeAgentPermissionInput(resolvedAgent.permission)
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
  })).digest("hex")
  return `${prefix}:${fingerprint}`
}

export async function readDelegationLaunchContext(
  context: DelegationLaunchContextLike,
  authorityClient?: DelegationAuthorityClientLike,
): Promise<ResolvedDelegationLaunchContext> {
  const authoritativePermissionInput = await resolveAuthoritativeDelegationPermissionInput(context, authorityClient)

  if (!authoritativePermissionInput) {
    throw new Error("Authoritative permission resolution is unavailable for this delegated launch")
  }

  const runtimeCwd = normalizeString(context.worktree)
    ?? normalizeString(context.directory)

  return {
    agentKey: normalizeString(context.agent) ?? buildLaunchScopedFallback("missing-agent", context),
    workspaceRoot: runtimeCwd
      ?? buildLaunchScopedFallback("missing-workspace", context),
    runtimeCwd,
    permissionInput: authoritativePermissionInput,
  }
}

export function resolveAuthoritativeDelegationPermissionFallback(
  context: DelegationLaunchContextLike,
): DelegationPermissionInput | null {
  if (!Object.prototype.hasOwnProperty.call(context, "authoritativeDelegationPermissions")) {
    return null
  }

  const authoritativePermissions = context.authoritativeDelegationPermissions

  if (typeof authoritativePermissions !== "object" || authoritativePermissions === null) {
    return null
  }

  return normalizePermissionInput(authoritativePermissions as DelegationPermissionEnvelopeLike)
}

export async function resolveAuthoritativeDelegationPermissionInput(
  context: DelegationLaunchContextLike,
  authorityClient?: DelegationAuthorityClientLike,
): Promise<DelegationPermissionInput | null> {
  if (authorityClient !== undefined) {
    return resolveAuthoritativePermissionInputFromClient(context, authorityClient)
  }

  return resolveAuthoritativeDelegationPermissionFallback(context)
}
