import { describe, expect, it } from "vitest"

describe("repo bootstrap", () => {
  it("loads the plugin entry module", async () => {
    const mod = await import("../src/index.js")
    expect(mod).toBeTruthy()
  })
})
