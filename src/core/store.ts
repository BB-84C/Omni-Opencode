import { readFile, writeFile, mkdir, readdir, unlink, rename } from "fs/promises"
import { join } from "path"
import { randomUUID } from "crypto"
import type { JobRecord } from "./jobs.js"

export interface JobStore {
  save(record: JobRecord): Promise<void>
  get(jobId: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  listByBatch(batchId: string): Promise<JobRecord[]>
  remove(jobId: string): Promise<void>
}

function normalizeJobRecord(record: JobRecord): JobRecord {
  return { ...record }
}

function monitorSessionKey(record: JobRecord): string | undefined {
  return record.monitorSessionId
}

function pickCanonicalSharedMonitorRecord(sessionRecords: JobRecord[], persistedRecords: JobRecord[]): JobRecord | undefined {
  const normalizedSessionRecords = sessionRecords.map(normalizeJobRecord)
  const canonicalJobId = normalizedSessionRecords
    .map((record) => record.jobId)
    .sort((left, right) => left.localeCompare(right))[0]

  if (!canonicalJobId) {
    return undefined
  }

  return persistedRecords
    .map(normalizeJobRecord)
    .find((record) => record.jobId === canonicalJobId)
    ?? normalizedSessionRecords.find((record) => record.jobId === canonicalJobId)
}

function applyCanonicalSharedMonitorMetadata(record: JobRecord, canonical: JobRecord): JobRecord {
  const normalized = normalizeJobRecord(record)
  const keepsPerJobTranscriptTarget = normalized.transcriptCaptureTarget !== undefined

  return {
    ...normalized,
    attachTarget: canonical.attachTarget,
    attachCommand: canonical.attachCommand,
    logTailCommand: keepsPerJobTranscriptTarget ? normalized.logTailCommand : canonical.logTailCommand,
    terminalLogPath: keepsPerJobTranscriptTarget ? normalized.terminalLogPath : canonical.terminalLogPath,
  }
}

function stabilizeSharedMonitorMetadata(record: JobRecord, existingRecords: JobRecord[]): JobRecord {
  const normalized = normalizeJobRecord(record)
  const sessionKey = monitorSessionKey(normalized)

  if (!sessionKey) {
    return normalized
  }

  const sessionRecords = [
    normalized,
    ...existingRecords.filter((existing) => monitorSessionKey(existing) === sessionKey && existing.jobId !== normalized.jobId),
  ]
  const stableMonitor = pickCanonicalSharedMonitorRecord(sessionRecords, existingRecords)

  if (!stableMonitor || stableMonitor.jobId === normalized.jobId && !existingRecords.some((record) => record.jobId === normalized.jobId)) {
    return normalized
  }

  return applyCanonicalSharedMonitorMetadata(normalized, stableMonitor)
}

function reconcileSharedMonitorSessionRecords(records: JobRecord[], sessionKey: string): JobRecord[] {
  const sessionRecords = records.filter((record) => monitorSessionKey(record) === sessionKey)
  const canonical = pickCanonicalSharedMonitorRecord(sessionRecords, records)

  if (!canonical) {
    return records
  }

  return records.map((record) => monitorSessionKey(record) === sessionKey
    ? applyCanonicalSharedMonitorMetadata(record, canonical)
    : record)
}

function createInMemoryStore(): JobStore {
  const map = new Map<string, JobRecord>()

  return {
    async save(record: JobRecord): Promise<void> {
      const stabilized = stabilizeSharedMonitorMetadata(record, Array.from(map.values()))
      map.set(record.jobId, stabilized)

      const sessionKey = monitorSessionKey(stabilized)
      if (!sessionKey) {
        return
      }

      const reconciled = reconcileSharedMonitorSessionRecords(Array.from(map.values()), sessionKey)
      map.clear()
      for (const reconciledRecord of reconciled) {
        map.set(reconciledRecord.jobId, reconciledRecord)
      }
    },

    async get(jobId: string): Promise<JobRecord | undefined> {
      const record = map.get(jobId)
      return record ? normalizeJobRecord(record) : undefined
    },

    async list(): Promise<JobRecord[]> {
      return Array.from(map.values()).map(normalizeJobRecord)
    },

    async listByBatch(batchId: string): Promise<JobRecord[]> {
      return Array.from(map.values())
        .filter((record) => record.batchId === batchId)
        .map(normalizeJobRecord)
    },

    async remove(jobId: string): Promise<void> {
      map.delete(jobId)
    },
  }
}

function createFileBackedStore(stateDir: string): JobStore {
  const ensureDir = () => mkdir(stateDir, { recursive: true })

  function filePath(jobId: string): string {
    return join(stateDir, `${encodeURIComponent(jobId)}.json`)
  }

  return {
    async save(record: JobRecord): Promise<void> {
      await ensureDir()
      const existingRecords = await this.list()
      const normalized = stabilizeSharedMonitorMetadata(record, existingRecords)
      const sessionKey = monitorSessionKey(normalized)
      const recordsToPersist = sessionKey
        ? reconcileSharedMonitorSessionRecords([...existingRecords.filter((existing) => existing.jobId !== normalized.jobId), normalized], sessionKey)
        : [...existingRecords.filter((existing) => existing.jobId !== normalized.jobId), normalized]

      for (const persistedRecord of recordsToPersist) {
        const finalPath = filePath(persistedRecord.jobId)
        const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
        await writeFile(tempPath, JSON.stringify(persistedRecord, null, 2), "utf-8")
        await renameWithRetry(tempPath, finalPath)
      }
    },

    async get(jobId: string): Promise<JobRecord | undefined> {
      try {
        const content = await readFile(filePath(jobId), "utf-8")
        return normalizeJobRecord(JSON.parse(content) as JobRecord)
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
          return undefined
        }
        throw err
      }
    },

    async list(): Promise<JobRecord[]> {
      await ensureDir()
      let entries: string[]
      try {
        entries = await readdir(stateDir)
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
          return []
        }
        throw err
      }

      const jobs: JobRecord[] = []
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        try {
          const content = await readFile(join(stateDir, entry), "utf-8")
          jobs.push(normalizeJobRecord(JSON.parse(content) as JobRecord))
        } catch {
          // skip unreadable files
        }
      }
      return jobs
    },

    async listByBatch(batchId: string): Promise<JobRecord[]> {
      const jobs = await this.list()
      return jobs.filter((record) => record.batchId === batchId)
    },

    async remove(jobId: string): Promise<void> {
      try {
        await unlink(filePath(jobId))
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
          return
        }
        throw err
      }
    },
  }
}

async function renameWithRetry(tempPath: string, finalPath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tempPath, finalPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === "EPERM" || code === "EBUSY") && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}

export function createJobStore(stateDir?: string): JobStore {
  if (stateDir !== undefined) {
    return createFileBackedStore(stateDir)
  }
  return createInMemoryStore()
}
