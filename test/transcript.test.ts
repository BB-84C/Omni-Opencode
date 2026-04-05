import { describe, expect, it } from "vitest"
import { appendTranscriptChunk, createTranscript } from "../src/runtime/transcript.js"
import { extractFinalReport } from "../src/runtime/extract-report.js"

describe("runtime transcript", () => {
  it("stores chunks in arrival order and exposes the joined text", () => {
    const transcript = createTranscript()

    appendTranscriptChunk(transcript, "Running tests\n")
    appendTranscriptChunk(transcript, "All green\n")

    expect(transcript.chunks).toEqual(["Running tests\n", "All green\n"])
    expect(transcript.text).toBe("Running tests\nAll green\n")
  })
})

describe("extractFinalReport", () => {
  it("prefers structured final output when present", () => {
    const transcript = createTranscript()

    appendTranscriptChunk(transcript, "Working...\n")
    appendTranscriptChunk(transcript, JSON.stringify({
      finalReport: {
        summary: "Completed successfully",
        changedFiles: ["src/runtime/transcript.ts"],
      },
    }))

    expect(extractFinalReport(transcript)).toEqual({
      summary: "Completed successfully",
      changedFiles: ["src/runtime/transcript.ts"],
      source: "structured",
    })
  })

  it("extracts structured final output from trailing streamed json after plain text", () => {
    const transcript = createTranscript()

    appendTranscriptChunk(transcript, "progress update\n")
    appendTranscriptChunk(transcript, '{"finalReport":{')
    appendTranscriptChunk(transcript, '"summary":"Completed successfully",')
    appendTranscriptChunk(transcript, '"changedFiles":["src/runtime/transcript.ts"]')
    appendTranscriptChunk(transcript, "}}")

    expect(extractFinalReport(transcript)).toEqual({
      summary: "Completed successfully",
      changedFiles: ["src/runtime/transcript.ts"],
      source: "structured",
    })
  })

  it("falls back to conservative parsing from plain text", () => {
    const transcript = createTranscript()

    appendTranscriptChunk(transcript, "progress update\n")
    appendTranscriptChunk(transcript, "Summary: Completed successfully\n")
    appendTranscriptChunk(transcript, "Changed files:\n")
    appendTranscriptChunk(transcript, "- src/runtime/transcript.ts\n")
    appendTranscriptChunk(transcript, "- src/runtime/extract-report.ts\n")

    expect(extractFinalReport(transcript)).toEqual({
      summary: "Completed successfully",
      changedFiles: ["src/runtime/transcript.ts", "src/runtime/extract-report.ts"],
      source: "parsed",
    })
  })
})
