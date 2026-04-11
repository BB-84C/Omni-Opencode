import { describe, expect, it } from "vitest"
import {
  normalizeClaudeSessionCorrelation,
  toClaudeResumeSessionId,
} from "../src/runtime/claude-session-discovery"

describe("claude session discovery", () => {
  it("represents a known session id when explicitly provided", () => {
    expect(normalizeClaudeSessionCorrelation({
      jobId: "job-1",
      sessionId: "claude-session-123",
    })).toEqual({
      jobId: "job-1",
      sessionId: "claude-session-123",
      resumeSessionId: "claude-session-123",
    })
  })

  it("preserves a stable mapping from delegated job to backend session id", () => {
    expect(normalizeClaudeSessionCorrelation({
      jobId: "job-7",
      sessionId: "claude-session-abc",
      resumeSessionId: "claude-session-abc",
    })).toEqual({
      jobId: "job-7",
      sessionId: "claude-session-abc",
      resumeSessionId: "claude-session-abc",
    })
  })

  it("supports explicit resume data instead of last-session heuristics", () => {
    const correlation = normalizeClaudeSessionCorrelation({
      jobId: "job-9",
      resumeSessionId: "claude-session-resume-9",
    })

    expect(correlation).toEqual({
      jobId: "job-9",
      sessionId: undefined,
      resumeSessionId: "claude-session-resume-9",
    })
    expect(toClaudeResumeSessionId(correlation)).toBe("claude-session-resume-9")
  })
})
