export type CodexHistoryEntry = {
  sessionId: string
  timestamp: string
  text: string
}

const CORRELATION_MARKER_PATTERN = /\[marker:\s*([^\]]+)\]/g

type RawCodexHistoryEntry = {
  session_id?: unknown
  ts?: unknown
  text?: unknown
}

export function parseCodexHistoryEntries(historyJsonl: string): CodexHistoryEntry[] {
  const entries: CodexHistoryEntry[] = []

  for (const line of historyJsonl.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue
    }

    const entry = parseCodexHistoryLine(line)
    if (!entry) {
      continue
    }

    entries.push(entry)
  }

  return entries
}

export function discoverCodexSessionFromHistory(
  historyJsonl: string,
  correlationMarker: string,
): CodexHistoryEntry | undefined {
  return parseCodexHistoryEntries(historyJsonl).find((entry) => hasExactCorrelationMarker(entry.text, correlationMarker))
}

function hasExactCorrelationMarker(text: string, correlationMarker: string): boolean {
  for (const match of text.matchAll(CORRELATION_MARKER_PATTERN)) {
    if (match[1] === correlationMarker) {
      return true
    }
  }

  return false
}

function parseCodexHistoryLine(line: string): CodexHistoryEntry | undefined {
  try {
    const entry = JSON.parse(line) as RawCodexHistoryEntry

    return {
      sessionId: String(entry.session_id ?? ""),
      timestamp: String(entry.ts ?? ""),
      text: String(entry.text ?? ""),
    }
  } catch {
    return undefined
  }
}
