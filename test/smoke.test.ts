import { describe, expect, it } from "vitest"

describe("repo bootstrap", () => {
  it("loads the plugin entry module", async () => {
    const mod = await import("../src/index.js")
    expect(mod).toBeTruthy()
  })

  it("exports an OpenCode plugin module shape", async () => {
    const mod = await import("../src/plugin.js") as typeof import("../src/plugin.js") & {
      default?: { id?: unknown; server?: unknown }
    }
    expect(mod.default).toBeTruthy()
    expect(mod.id).toBe("omni-opencode")
    expect(mod.default?.id).toBe("omni-opencode")
    expect(mod.default?.server).toBe(mod.OmniOpencodePlugin)
    expect(mod.server).toBe(mod.OmniOpencodePlugin)
  })
})
