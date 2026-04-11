import type {
  DelegationStreamBackend,
  DelegationStreamEvent,
  DelegationStreamRecord,
} from "./delegation-stream-types.js"

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const

export function renderDelegationEvent(event: DelegationStreamEvent): string {
  switch (event.kind) {
    case "message":
      return renderMarkdownLikeText(event.text ?? "")
    case "completion":
      return event.text
        ? `${ANSI.green}[${event.backend}] final result${ANSI.reset}\n${renderMarkdownLikeText(event.text)}`
        : `${ANSI.green}[${event.backend}] final result${ANSI.reset}`
    case "status":
      return renderStatus(event)
    default:
      return assertNever(event.kind)
  }
}

export function renderDelegationTranscriptEvents(events: DelegationStreamEvent[]): string[] {
  const rendered: string[] = []

  for (const event of events) {
    const output = renderDelegationTranscriptEvent(event)
    if (output !== undefined) {
      rendered.push(output)
    }

    if (event.backend === "claude" && event.kind === "completion" && !event.text) {
      rendered.push("[claude] final result")
    }
  }

  return rendered
}

export function renderDelegationTranscriptEvent(
  event: DelegationStreamEvent,
): string | undefined {
  if (event.kind === "status") {
    const codexProgress = summarizeCodexTranscriptStatus(event)
    if (codexProgress) {
      return codexProgress
    }

    const claudeToolSummary = summarizeClaudeTranscriptStatus(event)
    if (claudeToolSummary) {
      return claudeToolSummary
    }

    return undefined
  }

  if (event.backend === "claude") {
    if (event.kind === "message") {
      return undefined
    }

    return event.text ? renderMarkdownLikeText(event.text) : undefined
  }

  if (event.kind === "message") {
    return renderMarkdownLikeText(event.text ?? "")
  }

  return event.text ? renderMarkdownLikeText(event.text) : `[${event.backend}] final result`
}

export function renderDelegationBackendNoise(
  backend: DelegationStreamBackend,
  text: string,
): string | undefined {
  const lines = normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return undefined
  }

  return lines.map((line) => `[${backend}] progress: ${line}`).join("\n")
}

function assertNever(value: never): never {
  throw new Error(`Unhandled delegation event kind: ${String(value)}`)
}

function renderStatus(event: DelegationStreamEvent): string {
  const detail = readMessage(event.raw)

  if (event.eventType === "error") {
    return `${ANSI.red}[${event.backend}] error: ${detail ?? event.eventType}${ANSI.reset}`
  }

  if (event.eventType === "warning") {
    return `${ANSI.yellow}[${event.backend}] warning: ${detail ?? event.eventType}${ANSI.reset}`
  }

  if (isProgressEvent(event.eventType)) {
    return `${ANSI.yellow}[${event.backend}] progress: ${event.eventType}${ANSI.reset}`
  }

  return `${ANSI.yellow}[${event.backend}] status: ${event.eventType}${ANSI.reset}`
}

function renderMarkdownLikeText(text: string): string {
  const lines = normalizeLineEndings(text).split("\n")
  const rendered: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      rendered.push(`${ANSI.dim}${line}${ANSI.reset}`)
      continue
    }

    if (inCodeBlock) {
      rendered.push(line)
      continue
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      rendered.push(`${ANSI.bold}${ANSI.cyan}${formatInline(heading[1])}${ANSI.reset}`)
      continue
    }

    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      rendered.push(`  • ${formatInline(bullet[1])}`)
      continue
    }

    const ordered = line.match(/^\d+\.\s+(.*)$/)
    if (ordered) {
      rendered.push(`  ${formatInline(line)}`)
      continue
    }

    rendered.push(formatInline(line))
  }

  return rendered.join("\n")
}

function formatInline(text: string): string {
  return text.replace(/`([^`]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`)
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

function isProgressEvent(eventType: string): boolean {
  return eventType.endsWith(".started") || eventType.includes("progress")
}

function summarizeClaudeTranscriptStatus(
  event: DelegationStreamEvent,
): string | undefined {
  if (event.backend !== "claude") {
    return undefined
  }

  if (event.eventType.startsWith("tool_use")) {
    const toolName = typeof event.raw.name === "string"
      ? event.raw.name
      : readClaudeToolNameFromEventType(event.eventType)
    return toolName ? `[claude] tool_use: ${toolName}` : "[claude] tool_use"
  }

  if (event.eventType.startsWith("tool_result")) {
    return event.eventType.endsWith(".error")
      ? "[claude] tool_result: error"
      : "[claude] tool_result: ok"
  }

  return undefined
}

function summarizeCodexTranscriptStatus(
  event: DelegationStreamEvent,
): string | undefined {
  if (event.backend !== "codex") {
    return undefined
  }

  if (!isProgressEvent(event.eventType)) {
    return undefined
  }

  const detail = readMessage(event.raw)
  return detail ? `[codex] progress: ${detail}` : undefined
}

function readClaudeToolNameFromEventType(eventType: string): string | undefined {
  const separatorIndex = eventType.indexOf(".")
  if (separatorIndex < 0 || separatorIndex === eventType.length - 1) {
    return undefined
  }

  return eventType.slice(separatorIndex + 1)
}

function readMessage(raw: DelegationStreamRecord): string | undefined {
  return typeof raw.message === "string" ? raw.message : undefined
}
