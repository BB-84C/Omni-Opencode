import { describe, expect, it } from "vitest"
import {
  discoverCodexSessionFromHistory,
  parseCodexHistoryEntries,
} from "../src/runtime/codex-session-discovery"

describe("codex session discovery", () => {
  it("parses history.jsonl-style entries", () => {
    const history = [
      JSON.stringify({
        session_id: "session-alpha",
        ts: "2026-04-09T10:00:00.000Z",
        text: "first prompt",
      }),
      JSON.stringify({
        session_id: "session-beta",
        ts: "2026-04-09T10:00:00.050Z",
        text: "second prompt",
      }),
    ].join("\n")

    expect(parseCodexHistoryEntries(history)).toEqual([
      {
        sessionId: "session-alpha",
        timestamp: "2026-04-09T10:00:00.000Z",
        text: "first prompt",
      },
      {
        sessionId: "session-beta",
        timestamp: "2026-04-09T10:00:00.050Z",
        text: "second prompt",
      },
    ])
  })

  it("finds the session created for a specific first-prompt correlation marker and ignores unrelated simultaneous sessions", () => {
    const marker = "omni-opencode:parent-session-1:message-7:codex"
    const similarMarker = `${marker}-lookalike`
    const history = [
      JSON.stringify({
        session_id: "session-unrelated-1",
        ts: "2026-04-09T10:00:00.000Z",
        text: "Investigate runtime logs [marker: omni-opencode:parent-session-2:message-3:codex]",
      }),
      JSON.stringify({
        session_id: "session-similar-marker",
        ts: "2026-04-09T10:00:00.005Z",
        text: `Inspect dashboard redraw path [marker: ${similarMarker}]`,
      }),
      JSON.stringify({
        session_id: "session-target",
        ts: "2026-04-09T10:00:00.010Z",
        text: `Inspect dashboard redraw path [marker: ${marker}]`,
      }),
      JSON.stringify({
        session_id: "session-unrelated-2",
        ts: "2026-04-09T10:00:00.015Z",
        text: "Inspect dashboard redraw path without delegated marker",
      }),
      JSON.stringify({
        session_id: "session-target",
        ts: "2026-04-09T10:00:01.000Z",
        text: "Follow-up exchange in the same session",
      }),
    ].join("\n")

    expect(discoverCodexSessionFromHistory(history, marker)).toEqual({
      sessionId: "session-target",
      timestamp: "2026-04-09T10:00:00.010Z",
      text: `Inspect dashboard redraw path [marker: ${marker}]`,
    })
  })

  it("skips malformed history lines and still discovers the matching session", () => {
    const marker = "omni-opencode:parent-session-9:message-2:codex"
    const history = [
      JSON.stringify({
        session_id: "session-unrelated-1",
        ts: "2026-04-09T10:00:00.000Z",
        text: "Investigate runtime logs [marker: omni-opencode:parent-session-8:message-2:codex]",
      }),
      '{"session_id":"session-truncated","ts":"2026-04-09T10:00:00.005Z","text":"partial prompt',
      JSON.stringify({
        session_id: "session-target",
        ts: "2026-04-09T10:00:00.010Z",
        text: `Inspect dashboard redraw path [marker: ${marker}]`,
      }),
    ].join("\n")

    expect(discoverCodexSessionFromHistory(history, marker)).toEqual({
      sessionId: "session-target",
      timestamp: "2026-04-09T10:00:00.010Z",
      text: `Inspect dashboard redraw path [marker: ${marker}]`,
    })
  })
})
