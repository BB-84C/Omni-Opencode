import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DelegationCapabilities } from "./delegation-permissions.js"
import { normalizeDelegationRoot } from "./delegation-permissions.js"

export type DelegatedSessionCapability = Exclude<keyof DelegationCapabilities, "allowedRoots">

export type DelegatedSessionGrant = {
  parentSessionId: string
  backend: "claude-code" | "codex"
  agentKey: string
  permissionEnvelopeFingerprint: string
  capability: DelegatedSessionCapability
  workspaceRoot: string
  scope: "session"
  approvedAt?: number
}

type FindMatchingDelegationGrantInput = {
  grants: readonly DelegatedSessionGrant[]
  parentSessionId: string
  backend: "claude-code" | "codex"
  agentKey: string
  permissionEnvelopeFingerprint: string
  capability: DelegatedSessionCapability
  workspaceRoot: string
  scope: "session"
}

export type DelegationGrantStore = {
  get(parentSessionId: string): Promise<DelegatedSessionGrant[]>
  save(grant: DelegatedSessionGrant): Promise<void>
}

function grantDirectoryPath(stateDir: string, parentSessionId: string): string {
  return join(stateDir, encodeURIComponent(parentSessionId))
}

function normalizeGrant(grant: DelegatedSessionGrant): DelegatedSessionGrant {
  return {
    ...grant,
    workspaceRoot: normalizeDelegationRoot(grant.workspaceRoot),
  }
}

function grantFileName(grant: DelegatedSessionGrant): string {
  const normalizedGrant = normalizeGrant(grant)
  return `${encodeURIComponent(normalizedGrant.backend)}-${encodeURIComponent(normalizedGrant.agentKey)}-${encodeURIComponent(normalizedGrant.permissionEnvelopeFingerprint)}-${encodeURIComponent(normalizedGrant.capability)}-${encodeURIComponent(normalizedGrant.workspaceRoot)}-${normalizedGrant.scope}.json`
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf-8")
  return JSON.parse(content) as T
}

export function findMatchingDelegationGrant(
  input: FindMatchingDelegationGrantInput,
): DelegatedSessionGrant | undefined {
  const normalizedWorkspaceRoot = normalizeDelegationRoot(input.workspaceRoot)

  return input.grants.find((grant) => {
    const normalizedGrant = normalizeGrant(grant)
    return normalizedGrant.parentSessionId === input.parentSessionId
      && normalizedGrant.backend === input.backend
      && normalizedGrant.agentKey === input.agentKey
      && normalizedGrant.permissionEnvelopeFingerprint === input.permissionEnvelopeFingerprint
      && normalizedGrant.capability === input.capability
      && normalizedGrant.workspaceRoot === normalizedWorkspaceRoot
      && normalizedGrant.scope === input.scope
  })
}

export function createDelegationGrantStore(stateDir: string): DelegationGrantStore {
  return {
    async get(parentSessionId) {
      const directoryPath = grantDirectoryPath(stateDir, parentSessionId)

      try {
        const entryNames = await readdir(directoryPath)
        const grants = await Promise.all(
          entryNames
            .filter((entryName) => entryName.endsWith(".json"))
            .map((entryName) => readJsonFile<DelegatedSessionGrant>(join(directoryPath, entryName))),
        )

        return grants.map(normalizeGrant)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return []
        }

        throw error
      }
    },
    async save(grant) {
      const normalizedGrant = normalizeGrant(grant)
      const directoryPath = grantDirectoryPath(stateDir, normalizedGrant.parentSessionId)

      await mkdir(directoryPath, { recursive: true })
      await writeFile(
        join(directoryPath, grantFileName(normalizedGrant)),
        JSON.stringify(normalizedGrant, null, 2),
        "utf-8",
      )
    },
  }
}
