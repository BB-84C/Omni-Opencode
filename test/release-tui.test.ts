import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("tui entry isolation", () => {
  it("keeps the TUI entry independent from the server plugin module", async () => {
    const source = await readFile(new URL("../src/tui.ts", import.meta.url), "utf8")

    expect(source).not.toContain('from "./plugin.js"')
    expect(source).not.toContain("from './plugin.js'")
  })
})
