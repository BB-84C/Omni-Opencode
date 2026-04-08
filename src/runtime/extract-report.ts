import type { RuntimeTranscript } from "./transcript.js"

export type FinalReport = {
  summary?: string
  changedFiles: string[]
  source: "structured" | "parsed" | "none"
}

export function extractFinalReport(transcript: RuntimeTranscript): FinalReport {
  const structured = extractStructuredReport(transcript)

  if (structured) {
    return {
      summary: structured.summary,
      changedFiles: structured.changedFiles,
      source: "structured",
    }
  }

  const parsed = extractParsedReport(transcript.text)

  if (parsed.summary || parsed.changedFiles.length > 0) {
    return {
      ...parsed,
      source: "parsed",
    }
  }

  return {
    changedFiles: [],
    source: "none",
  }
}

type ReportShape = {
  summary?: string
  changedFiles: string[]
}

function extractStructuredReport(transcript: RuntimeTranscript): ReportShape | null {
  for (let index = transcript.chunks.length - 1; index >= 0; index -= 1) {
    const parsed = parseStructuredChunk(transcript.chunks[index])

    if (parsed) {
      return parsed
    }
  }

  return parseStructuredChunk(transcript.text) ?? parseTrailingStructuredChunk(transcript.text)
}

function parseStructuredChunk(value: string): ReportShape | null {
  const trimmed = value.trim()

  if (!trimmed.startsWith("{")) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      finalReport?: unknown
      summary?: unknown
      changedFiles?: unknown
    }
    return normalizeReport(parsed.finalReport ?? parsed)
  } catch {
    return null
  }
}

function parseTrailingStructuredChunk(value: string): ReportShape | null {
  const trimmed = value.trimEnd()

  if (!trimmed.endsWith("}")) {
    return null
  }

  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    const candidate = trimmed.slice(index)
    const parsed = parseStructuredChunk(candidate)

    if (parsed) {
      return parsed
    }
  }

  return null
}

function normalizeReport(value: unknown): ReportShape | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as {
    summary?: unknown
    changedFiles?: unknown
  }
  const summary = typeof candidate.summary === "string" ? candidate.summary : undefined
  const changedFiles = Array.isArray(candidate.changedFiles)
    ? candidate.changedFiles.filter((entry): entry is string => typeof entry === "string")
    : []

  if (!summary && changedFiles.length === 0) {
    return null
  }

  return { summary, changedFiles }
}

function extractParsedReport(text: string): ReportShape {
  const lines = text.split(/\r?\n/)
  const explicitSummary = lines
    .map((line) => line.match(/^Summary:\s*(.+)$/i)?.[1]?.trim())
    .find((value): value is string => Boolean(value))

  const summary = explicitSummary ?? extractFallbackSummary(lines)

  const changedFiles: string[] = []
  let inChangedFiles = false

  for (const line of lines) {
    if (/^Changed files:\s*$/i.test(line.trim())) {
      inChangedFiles = true
      continue
    }

    if (!inChangedFiles) {
      continue
    }

    const match = line.match(/^[-*]\s+(.+)$/)

    if (!match) {
      break
    }

    changedFiles.push(match[1].trim())
  }

  return { summary, changedFiles }
}

function extractFallbackSummary(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = stripAnsi(lines[index] ?? "").trim()

    if (!candidate) {
      continue
    }

    if (/^(tokens used|user|codex|exec)$/i.test(candidate)) {
      continue
    }

    if (/^OpenAI Codex v/i.test(candidate) || /^[-]{2,}$/.test(candidate)) {
      continue
    }

    if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(candidate)) {
      continue
    }

    if (/^succeeded in \d+ms:?$/i.test(candidate)) {
      continue
    }

    if (/^[\d,]+$/.test(candidate)) {
      continue
    }

    return candidate
  }

  return undefined
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9:;<=>?]*[ -/]*[@-~]/g, "")
}
