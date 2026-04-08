import { describe, expect, it } from "vitest"

async function loadWindowsPtyProofModule() {
  return import("../scripts/windows-pty-multiplexer-proof")
}

describe("windows PTY proof renderer", () => {
  it("prints five labeled pane sections", async () => {
    const { defineWindowsPtyProof, renderWindowsPtyProofTerminal } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()
    const rendered = renderWindowsPtyProofTerminal(
      proof,
      proof.panes.map((pane: { id: string }) => ({
        paneId: pane.id,
        status: "idle",
        buffer: "",
      })),
    )

    expect(rendered).toContain("=== Codex 1 ===")
    expect(rendered).toContain("=== Codex 2 ===")
    expect(rendered).toContain("=== Codex 3 ===")
    expect(rendered).toContain("=== Claude 1 ===")
    expect(rendered).toContain("=== Claude 2 ===")
  })

  it("shows pane status in each section", async () => {
    const { defineWindowsPtyProof, renderWindowsPtyProofTerminal } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()
    const rendered = renderWindowsPtyProofTerminal(proof, [
      { paneId: "codex-1", status: "running", buffer: "" },
      { paneId: "codex-2", status: "done", buffer: "" },
      { paneId: "codex-3", status: "error", buffer: "" },
      { paneId: "claude-1", status: "idle", buffer: "" },
      { paneId: "claude-2", status: "running", buffer: "" },
    ])

    expect(rendered).toContain("Status: running")
    expect(rendered).toContain("Status: done")
    expect(rendered).toContain("Status: error")
    expect(rendered).toContain("Status: idle")
  })

  it("renders buffered output from every pane into one terminal string", async () => {
    const { defineWindowsPtyProof, renderWindowsPtyProofTerminal } = await loadWindowsPtyProofModule()

    const proof = defineWindowsPtyProof()
    const rendered = renderWindowsPtyProofTerminal(proof, [
      { paneId: "codex-1", status: "running", buffer: "architecture\nready" },
      { paneId: "codex-2", status: "running", buffer: "checkpoints" },
      { paneId: "codex-3", status: "running", buffer: "pty ownership" },
      { paneId: "claude-1", status: "running", buffer: "risks" },
      { paneId: "claude-2", status: "running", buffer: "validation" },
    ])

    expect(rendered).toContain("architecture\nready")
    expect(rendered).toContain("checkpoints")
    expect(rendered).toContain("pty ownership")
    expect(rendered).toContain("risks")
    expect(rendered).toContain("validation")
  })
})
