import {
  type DelegationStreamEvent,
  type DelegationStreamRecord,
} from "./delegation-stream-types.js"

export class ClaudeStreamParser {
  #buffer = ""
  #streamedText = ""
  #fallbackFinalText: string | undefined
  #pendingMessageStart: DelegationStreamEvent | undefined
  #pendingCompletionRaw: DelegationStreamRecord | undefined
  #sawIncrementalToolUse = false
  #emittedFinalCompletion = false

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

      events.push(...this.#parseRecord(record))
    }

    return events
  }

  #parseRecord(record: DelegationStreamRecord): DelegationStreamEvent[] {
    const topLevelType = typeof record.type === "string" ? record.type : undefined

    if (!topLevelType) {
      return []
    }

    if (topLevelType === "assistant") {
      this.#rememberFallbackText(readAssistantFallbackText(record))
      return [
        ...readClaudeMessageContentEvents(topLevelType, record, this.#sawIncrementalToolUse),
        ...this.#flushPendingCompletionIfReady(),
      ]
    }

    if (topLevelType === "result") {
      this.#rememberFallbackText(readResultFallbackText(record))
      const pendingCompletionEvents = this.#flushPendingCompletionIfReady()
      const resultStatus = readClaudeResultStatus(record)
      if (pendingCompletionEvents.length > 0) {
        return resultStatus ? [...pendingCompletionEvents, resultStatus] : pendingCompletionEvents
      }

      const resultCompletion = this.#emittedFinalCompletion
        ? undefined
        : readClaudeResultCompletion(record)
      if (!resultCompletion) {
        return resultStatus ? [resultStatus] : []
      }

      const events = this.#flushPendingMessageStartArray()
      events.push(resultCompletion)
      return events
    }

    if (topLevelType === "user") {
      return readClaudeMessageContentEvents(topLevelType, record, this.#sawIncrementalToolUse)
    }

    if (isIgnoredClaudeProtocolRecord(topLevelType)) {
      return []
    }

    const eventRecord = unwrapClaudeEventRecord(record)
    const eventType = typeof eventRecord.type === "string" ? eventRecord.type : undefined
    if (!eventType) {
      return []
    }

    if (eventType === "message_start") {
      this.#streamedText = ""
      this.#fallbackFinalText = undefined
      this.#sawIncrementalToolUse = false
      this.#emittedFinalCompletion = false
      this.#pendingMessageStart = {
        backend: "claude",
        kind: "status",
        eventType,
        raw: eventRecord,
      }

      return topLevelType === "stream_event" ? [] : [this.#flushPendingMessageStart()]
    }

    if (eventType === "content_block_start") {
      const contentBlock = readClaudeContentBlock(eventRecord)
      if (contentBlock?.type === "tool_use") {
        this.#sawIncrementalToolUse = true
        const toolName = typeof contentBlock.name === "string" ? contentBlock.name : "unknown"
        return [{
          backend: "claude",
          kind: "status",
          eventType: `tool_use.${toolName}`,
          raw: contentBlock,
        }]
      }

      return []
    }

    const text = eventType === "content_block_delta"
      ? readClaudeText(eventRecord)
      : undefined
    if (text !== undefined) {
      this.#streamedText += text
      const events = this.#flushPendingMessageStartArray()
      events.push({
        backend: "claude",
        kind: "message",
        eventType,
        text,
        raw: eventRecord,
      })
      return events
    }

    const stopReason = readClaudeStopReason(eventRecord)
    if (eventType === "message_delta" && stopReason === "tool_use") {
      if (this.#sawIncrementalToolUse) {
        return []
      }

      return [{
        backend: "claude",
        kind: "status",
        eventType,
        raw: eventRecord,
      }]
    }

    if (eventType === "message_delta" && stopReason === "end_turn") {
      const completionText = this.#streamedText || this.#fallbackFinalText
      if (completionText === undefined && topLevelType === "stream_event") {
        this.#pendingCompletionRaw = eventRecord
        return this.#flushPendingMessageStartArray()
      }
      const events = this.#flushPendingMessageStartArray()
      const completion: DelegationStreamEvent = {
        backend: "claude",
        kind: "completion",
        eventType,
        raw: eventRecord,
      }

      if (completionText !== undefined) {
        completion.text = completionText
      }

      this.#streamedText = ""
      this.#fallbackFinalText = undefined
      this.#emittedFinalCompletion = true
      events.push(completion)
      return events
    }

    if (eventType === "message_delta" && topLevelType !== "stream_event") {
      return [{
        backend: "claude",
        kind: "status",
        eventType,
        raw: eventRecord,
      }]
    }

    return []
  }

  #rememberFallbackText(text: string | undefined) {
    if (this.#streamedText || text === undefined) {
      return
    }

    this.#fallbackFinalText = text
  }

  #flushPendingCompletionIfReady(): DelegationStreamEvent[] {
    if (!this.#pendingCompletionRaw) {
      return []
    }

    const completionText = this.#streamedText || this.#fallbackFinalText
    if (completionText === undefined) {
      return []
    }

    const completion: DelegationStreamEvent = {
      backend: "claude",
      kind: "completion",
      eventType: typeof this.#pendingCompletionRaw.type === "string"
        ? this.#pendingCompletionRaw.type
        : "message_delta",
      raw: this.#pendingCompletionRaw,
      text: completionText,
    }

    this.#pendingCompletionRaw = undefined
    this.#streamedText = ""
    this.#fallbackFinalText = undefined
    this.#emittedFinalCompletion = true

    return [completion]
  }

  #flushPendingMessageStart(): DelegationStreamEvent {
    const pendingMessageStart = this.#pendingMessageStart
    this.#pendingMessageStart = undefined
    return pendingMessageStart as DelegationStreamEvent
  }

  #flushPendingMessageStartArray(): DelegationStreamEvent[] {
    if (!this.#pendingMessageStart) {
      return []
    }

    return [this.#flushPendingMessageStart()]
  }
}

function isIgnoredClaudeProtocolRecord(eventType: string): boolean {
  return (
    eventType === "system"
    || eventType === "user"
    || eventType === "rate_limit_event"
  )
}

function unwrapClaudeEventRecord(
  record: DelegationStreamRecord,
): DelegationStreamRecord {
  if (record.type !== "stream_event") {
    return record
  }

  const event = record.event
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return record
  }

  return event as DelegationStreamRecord
}

function readClaudeStopReason(record: DelegationStreamRecord): string | undefined {
  const delta = record.delta
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return undefined
  }

  const deltaRecord = delta as Record<string, unknown>
  return typeof deltaRecord.stop_reason === "string" ? deltaRecord.stop_reason : undefined
}

function readClaudeText(record: DelegationStreamRecord): string | undefined {
  const delta = record.delta
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return undefined
  }

  const deltaRecord = delta as Record<string, unknown>
  if (deltaRecord.type !== "text_delta") {
    return undefined
  }

  return typeof deltaRecord.text === "string" ? deltaRecord.text : undefined
}

function readAssistantFallbackText(record: DelegationStreamRecord): string | undefined {
  const message = record.message
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined
  }

  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) {
    return undefined
  }

  const text = content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return undefined
      }

      const blockRecord = block as Record<string, unknown>
      return blockRecord.type === "text" && typeof blockRecord.text === "string"
        ? blockRecord.text
        : undefined
    })
    .filter((value): value is string => value !== undefined)
    .join("")

  return text || undefined
}

function readResultFallbackText(record: DelegationStreamRecord): string | undefined {
  return typeof record.result === "string" ? record.result : undefined
}

function readClaudeMessageContentEvents(
  topLevelType: string,
  record: DelegationStreamRecord,
  sawIncrementalToolUse: boolean,
): DelegationStreamEvent[] {
  const message = record.message
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return []
  }

  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) {
    return []
  }

  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return []
    }

    const blockRecord = block as DelegationStreamRecord
    const blockType = typeof blockRecord.type === "string" ? blockRecord.type : undefined
    if (!blockType) {
      return []
    }

    if (sawIncrementalToolUse && topLevelType === "assistant" && blockType === "tool_use") {
      return []
    }

    if (topLevelType === "assistant" && blockType === "tool_use") {
      const toolName = typeof blockRecord.name === "string" ? blockRecord.name : "unknown"
      return [{
        backend: "claude",
        kind: "status",
        eventType: `tool_use.${toolName}`,
        raw: blockRecord,
      }]
    }

    if (topLevelType === "user" && blockType === "tool_result") {
      const toolResultType = blockRecord.is_error === true ? "error" : "ok"
      return [{
        backend: "claude",
        kind: "status",
        eventType: `tool_result.${toolResultType}`,
        raw: blockRecord,
      }]
    }

    return []
  })
}

function readClaudeResultCompletion(
  record: DelegationStreamRecord,
): DelegationStreamEvent | undefined {
  if (record.subtype !== "success") {
    return undefined
  }

  const text = readResultFallbackText(record)
  return {
    backend: "claude",
    kind: "completion",
    eventType: "result.success",
    raw: record,
    ...(text === undefined ? {} : { text }),
  }
}

function readClaudeResultStatus(
  record: DelegationStreamRecord,
): DelegationStreamEvent | undefined {
  if (record.subtype !== "success") {
    return undefined
  }

  return {
    backend: "claude",
    kind: "status",
    eventType: "result.success",
    raw: record,
  }
}

function readClaudeContentBlock(
  record: DelegationStreamRecord,
): DelegationStreamRecord | undefined {
  const contentBlock = record.content_block
  if (!contentBlock || typeof contentBlock !== "object" || Array.isArray(contentBlock)) {
    return undefined
  }

  return contentBlock as DelegationStreamRecord
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
