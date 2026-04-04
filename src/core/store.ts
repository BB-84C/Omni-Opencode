import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises"
import { join } from "path"
import type { JobRecord } from "./jobs.js"

export interface JobStore {
  save(record: JobRecord): Promise<void>
  get(childSessionId: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  remove(childSessionId: string): Promise<void>
}

function createInMemoryStore(): JobStore {
  const map = new Map<string, JobRecord>()

  return {
    async save(record: JobRecord): Promise<void> {
      map.set(record.childSessionId, record)
    },

    async get(childSessionId: string): Promise<JobRecord | undefined> {
      return map.get(childSessionId)
    },

    async list(): Promise<JobRecord[]> {
      return Array.from(map.values())
    },

    async remove(childSessionId: string): Promise<void> {
      map.delete(childSessionId)
    },
  }
}

function createFileBackedStore(stateDir: string): JobStore {
  const ensureDir = () => mkdir(stateDir, { recursive: true })

  function filePath(childSessionId: string): string {
    return join(stateDir, `${childSessionId}.json`)
  }

  return {
    async save(record: JobRecord): Promise<void> {
      await ensureDir()
      await writeFile(filePath(record.childSessionId), JSON.stringify(record, null, 2), "utf-8")
    },

    async get(childSessionId: string): Promise<JobRecord | undefined> {
      try {
        const content = await readFile(filePath(childSessionId), "utf-8")
        return JSON.parse(content) as JobRecord
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
          jobs.push(JSON.parse(content) as JobRecord)
        } catch {
          // skip unreadable files
        }
      }
      return jobs
    },

    async remove(childSessionId: string): Promise<void> {
      try {
        await unlink(filePath(childSessionId))
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
          return
        }
        throw err
      }
    },
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
