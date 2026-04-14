import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const execFile = promisify(execFileCallback)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const tempDirs: string[] = []

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = join(root, relativePath)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, "utf-8")
}

async function collectFiles(root: string, current = "."): Promise<string[]> {
  const directory = current === "." ? root : join(root, current)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const relativePath = current === "." ? entry.name : join(current, entry.name)
    if (entry.isDirectory()) {
      return collectFiles(root, relativePath)
    }

    return [relativePath.replace(/\\/g, "/")]
  }))

  return files.flat().sort()
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("release package script", () => {
  it("copies only the canonical release payload", async () => {
    const sourceDir = await makeTempDir("omni-release-source-")
    const outputDir = await makeTempDir("omni-release-output-")
    const artifactDir = await makeTempDir("omni-release-artifacts-")

    await writeFixtureFile(sourceDir, "package.json", JSON.stringify({
      name: "fixture-plugin",
      version: "1.2.3",
      main: "dist/index.js",
      exports: {
        ".": "./dist/index.js",
        "./server": { import: "./dist/plugin.js", config: { enabled: true } },
        "./tui": { import: "./dist/tui.js", config: { enabled: true } },
      },
    }, null, 2))
    await writeFixtureFile(sourceDir, "README.md", "# Fixture\n")
    await writeFixtureFile(sourceDir, "LICENSE", "fixture license\n")
    await writeFixtureFile(sourceDir, "dist/index.js", "export * from './plugin.js'\n")
    await writeFixtureFile(sourceDir, "dist/plugin.js", "export default {}\n")
    await writeFixtureFile(sourceDir, "dist/tui.js", "export default {}\n")
    await writeFixtureFile(sourceDir, "dist/scripts/package-release.mjs", "console.log('dev only')\n")
    await writeFixtureFile(sourceDir, "test/release-package.test.ts", "should stay out\n")
    await writeFixtureFile(sourceDir, ".opencode/monitor/state.json", "{}\n")
    await writeFixtureFile(sourceDir, "docs/dev-notes.md", "dev only\n")

    await execFile(process.execPath, ["./scripts/package-release.mjs", "--source", sourceDir, "--output", outputDir, "--artifact-dir", artifactDir], {
      cwd: repoRoot,
      windowsHide: true,
    })

    await expect(readFile(join(outputDir, "package.json"), "utf-8")).resolves.toContain("fixture-plugin")
    await expect(collectFiles(outputDir)).resolves.toEqual([
      "LICENSE",
      "README.md",
      "dist/index.js",
      "dist/plugin.js",
      "dist/tui.js",
      "package.json",
    ])
    await expect(stat(join(artifactDir, "fixture-plugin-1.2.3.tgz"))).resolves.toMatchObject({ isFile: expect.any(Function) })
    await expect(stat(join(artifactDir, "fixture-plugin-1.2.3-plugin.tar.gz"))).resolves.toMatchObject({ isFile: expect.any(Function) })
  })

  it("registers the packaging script in package.json", async () => {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url))
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.["release:pack"]).toBe("node ./scripts/package-release.mjs")
  })
})
