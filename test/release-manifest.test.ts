import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

type PackageJson = {
  main?: string
  exports?: string | Record<string, unknown>
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as PackageJson
}

describe("package-root plugin entry", () => {
  it("publishes separate server and tui plugin entrypoints for OpenCode", async () => {
    const packageJson = await readPackageJson()

    expect(packageJson.main).toBe("dist/index.js")
    expect(packageJson.exports).toEqual({
      ".": "./dist/index.js",
      "./server": {
        import: "./dist/plugin.js",
        config: {
          enabled: true,
        },
      },
      "./tui": {
        import: "./dist/tui.js",
        config: {
          enabled: true,
        },
      },
    })
  })
})
