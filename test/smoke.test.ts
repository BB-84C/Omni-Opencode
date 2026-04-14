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
    const pluginId = await import("../src/plugin-id.js")
    expect(mod.default).toBeTruthy()
    expect(pluginId.id).toBe("omni-opencode")
    expect(mod.default?.id).toBe(pluginId.id)
    expect(mod.default?.server).toBe(mod.OmniOpencodePlugin)
    expect(mod.server).toBe(mod.OmniOpencodePlugin)
  })
})
