import {
  DelegationJsonLineParser,
  type DelegationStreamEvent,
  type DelegationStreamRecord,
} from "./delegation-stream-types.js"

export class CodexStreamParser {
  #lastText: string | undefined
  #parser = new DelegationJsonLineParser((record) => this.#parseRecord(record))

  push(chunk: string): DelegationStreamEvent[] {
    return this.#parser.push(chunk)
  }

  #parseRecord(record: DelegationStreamRecord): DelegationStreamEvent | undefined {
    const event = parseCodexRecord(record, this.#lastText)

    if (event?.text !== undefined) {
      this.#lastText = event.text
    }

    return event
  }
}

function parseCodexRecord(
  record: DelegationStreamRecord,
  lastText?: string,
): DelegationStreamEvent | undefined {
  const eventType = typeof record.type === "string" ? record.type : undefined
  if (!eventType) {
    return undefined
  }

  if (eventType === "turn.completed") {
    const text = readCodexText(record) ?? lastText
    return {
      backend: "codex",
      kind: "completion",
      eventType,
      text,
      raw: record,
    }
  }

  const text = readCodexText(record)
  if (text !== undefined) {
    return {
      backend: "codex",
      kind: "message",
      eventType,
      text,
      raw: record,
    }
  }

  return {
    backend: "codex",
    kind: "status",
    eventType,
    raw: record,
  }
}

function readCodexText(record: DelegationStreamRecord): string | undefined {
  if (typeof record.delta === "string") {
    return record.delta
  }

  if (typeof record.text === "string") {
    return record.text
  }

  const item = record.item
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const itemRecord = item as Record<string, unknown>
    if (typeof itemRecord.text === "string") {
      return itemRecord.text
    }
  }

  return undefined
}
