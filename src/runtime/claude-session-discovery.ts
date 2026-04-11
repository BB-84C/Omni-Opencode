export type ClaudeSessionCorrelation = {
  jobId: string
  sessionId?: string
  resumeSessionId?: string
}

type NormalizeClaudeSessionCorrelationInput = {
  jobId: string
  sessionId?: string | null
  resumeSessionId?: string | null
}

export function normalizeClaudeSessionCorrelation(
  input: NormalizeClaudeSessionCorrelationInput,
): ClaudeSessionCorrelation {
  const sessionId = normalizeClaudeSessionId(input.sessionId)
  const resumeSessionId = normalizeClaudeSessionId(input.resumeSessionId) ?? sessionId

  return {
    jobId: input.jobId,
    sessionId,
    resumeSessionId,
  }
}

export function toClaudeResumeSessionId(correlation: ClaudeSessionCorrelation): string | undefined {
  return correlation.resumeSessionId ?? correlation.sessionId
}

function normalizeClaudeSessionId(sessionId: string | null | undefined): string | undefined {
  const normalized = sessionId?.trim()
  return normalized ? normalized : undefined
}
