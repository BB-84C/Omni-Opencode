import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const tempDirs: string[] = []

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("release install smoke script", () => {
  it("verifies both release install channels and plugin manager config state", async () => {
    const outputDir = await makeTempDir("omni-release-install-output-")
    const artifactDir = await makeTempDir("omni-release-install-artifacts-")

    execFileSync(process.execPath, ["./scripts/package-release.mjs", "--output", outputDir, "--artifact-dir", artifactDir], {
      cwd: repoRoot,
      windowsHide: true,
    })

    const manifestPath = join(artifactDir, "release-manifest.json")
    const result = execFileSync(process.execPath, ["./scripts/release-smoke-install.mjs", "--manifest", manifestPath], {
      cwd: repoRoot,
      windowsHide: true,
      encoding: "utf8",
    })
    const summary = JSON.parse(result) as {
      npm: {
        packageName: string
        loadedPluginId: string
        resolvedPluginSpec: string
        pluginOriginSpec: string
        plugin: {
          id: string
          source: string
          spec: string
          enabled: boolean
          active: boolean
        } | null
        transitions: {
          afterDeactivate: {
            enabled: boolean
            active: boolean
          } | null
          afterReactivate: {
            enabled: boolean
            active: boolean
          } | null
        } | null
      }
      manual: {
        plugin: {
          id: string
          source: string
          spec: string
          enabled: boolean
          active: boolean
        } | null
        transitions: {
          afterDeactivate: {
            enabled: boolean
            active: boolean
          } | null
          afterReactivate: {
            enabled: boolean
            active: boolean
          } | null
        } | null
      }
    }

    expect(summary.npm).toEqual({
      packageName: "omni-opencode",
      loadedPluginId: "omni-opencode",
      resolvedPluginSpec: "omni-opencode",
      pluginOriginSpec: "omni-opencode",
      plugin: {
        id: "omni-opencode",
        source: "npm",
        spec: "omni-opencode",
        enabled: true,
        active: false,
      },
      transitions: {
        afterDeactivate: expect.objectContaining({
          id: "omni-opencode",
          enabled: false,
          active: false,
        }),
        afterReactivate: expect.objectContaining({
          id: "omni-opencode",
          enabled: true,
          active: true,
        }),
      },
    })

    expect(summary.manual.plugin).toEqual({
      id: "omni-opencode",
      source: "file",
      spec: expect.stringMatching(/^file:\/\//),
      target: expect.stringMatching(/^file:\/\//),
      enabled: true,
      active: false,
    })
    expect(summary.manual.transitions).toEqual({
      afterDeactivate: expect.objectContaining({
        id: "omni-opencode",
        enabled: false,
        active: false,
      }),
      afterReactivate: expect.objectContaining({
        id: "omni-opencode",
        enabled: true,
        active: true,
      }),
    })
  }, 180000)
})
