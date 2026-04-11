export type DelegationStreamBackend = "codex" | "claude"

export type DelegationStreamEventKind = "status" | "message" | "completion"

export type DelegationStreamRecord = Record<string, unknown>

export type DelegationStreamEvent = {
  backend: DelegationStreamBackend
  kind: DelegationStreamEventKind
  eventType: string
  raw: DelegationStreamRecord
  text?: string
}

type DelegationStreamMapper = (
  record: DelegationStreamRecord,
) => DelegationStreamEvent | undefined

export class DelegationJsonLineParser {
  #buffer = ""
  #mapRecord: DelegationStreamMapper

  constructor(mapRecord: DelegationStreamMapper) {
    this.#mapRecord = mapRecord
  }

  push(chunk: string): DelegationStreamEvent[] {
    this.#buffer += chunk

    const lines = this.#buffer.split(/\r?\n/)
    this.#buffer = lines.pop() ?? ""

    const events: DelegationStreamEvent[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      const record = parseDelegationStreamRecord(trimmed)
      if (!record) {
        continue
      }

      const event = this.#mapRecord(record)
      if (event) {
        events.push(event)
      }
    }

    return events
  }
}

function parseDelegationStreamRecord(
  line: string,
): DelegationStreamRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as DelegationStreamRecord
  } catch {
    return undefined
  }
}
