import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ApprovalMode, DelegationTaskClass, PermissionProfile } from "./jobs.js"
import { createDelegationGrantStore } from "./delegation-grants.js"
export {
  createDelegationGrantStore,
  findMatchingDelegationGrant,
  type DelegatedSessionCapability,
  type DelegatedSessionGrant,
  type DelegationGrantStore,
} from "./delegation-grants.js"

export type SessionApprovalRecord = {
  parentSessionId: string
  permissionProfile: PermissionProfile
  scope: "session"
  approvedAt: number
}

export type SessionApprovalStore = {
  get(parentSessionId: string, permissionProfile: PermissionProfile): Promise<SessionApprovalRecord | undefined>
  save(record: SessionApprovalRecord): Promise<void>
}

type DelegationApprovalChoice = Extract<ApprovalMode, "once" | "session"> | "deny"

const SAFE_INTENT_PREFIX = /^(?:please\s+|can you\s+|could you\s+)?(?:review|explain|summarize|investigate|analyze|read|inspect|research|look into)\b/i
const DANGEROUS_INTENT_PREFIX = /^(?:please\s+|can you\s+|could you\s+)?(?:edit|modify|write|create|delete|remove|rename|move|patch|update|implement|fix|run|execute)\b/i
const DANGEROUS_FOLLOWUP_ACTION = /\b(?:and|then|by)\s+(?:edit|modify|write|create|delete|remove|rename|move|patch|update|implement|fix|run|execute)\b/i
const READ_ONLY_GUARD = /\b(?:without|do not|don't)\s+(?:changing|change|modifying|modify|editing|edit|writing|write|running|run|executing|execute)\b/i

function filePath(stateDir: string, parentSessionId: string, permissionProfile: PermissionProfile): string {
  return join(stateDir, `${encodeURIComponent(parentSessionId)}-${permissionProfile}.json`)
}

async function readJsonFileOrDefault<T>(file: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(file, "utf-8")
    return JSON.parse(content) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback
    }

    throw error
  }
}

export function classifyDelegationTask(prompt: string): {
  taskClass: DelegationTaskClass
  permissionProfile: PermissionProfile
} {
  const normalizedPrompt = prompt.trim()

  if (SAFE_INTENT_PREFIX.test(normalizedPrompt)) {
    return DANGEROUS_FOLLOWUP_ACTION.test(normalizedPrompt) && !READ_ONLY_GUARD.test(normalizedPrompt)
      ? { taskClass: "workspace-write", permissionProfile: "dangerous" }
      : { taskClass: "review", permissionProfile: "safe" }
  }

  return DANGEROUS_INTENT_PREFIX.test(normalizedPrompt)
    ? { taskClass: "workspace-write", permissionProfile: "dangerous" }
    : { taskClass: "review", permissionProfile: "safe" }
}

export function createSessionApprovalStore(stateDir: string): SessionApprovalStore {
  const ensureDir = () => mkdir(stateDir, { recursive: true })

  return {
    async get(parentSessionId, permissionProfile) {
      return readJsonFileOrDefault(filePath(stateDir, parentSessionId, permissionProfile), undefined)
    },
    async save(record) {
      await ensureDir()
      await writeFile(
        filePath(stateDir, record.parentSessionId, record.permissionProfile),
        JSON.stringify(record, null, 2),
        "utf-8",
      )
    },
  }
}

export function normalizeDelegationApprovalChoice(value: unknown): DelegationApprovalChoice {
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "allow-once":
      case "once":
        return "once"
      case "allow-session":
      case "session":
        return "session"
      default:
        return "deny"
    }
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as {
      choice?: unknown
      status?: unknown
      scope?: unknown
      approved?: unknown
    }

    if (candidate.approved === true && candidate.scope === "session") {
      return "session"
    }

    if (candidate.approved === true) {
      return "once"
    }

    if (typeof candidate.choice === "string") {
      return normalizeDelegationApprovalChoice(candidate.choice)
    }

    if (typeof candidate.status === "string") {
      return normalizeDelegationApprovalChoice(candidate.status)
    }
  }

  return "deny"
}
