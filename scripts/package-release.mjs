import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return undefined
  }

  return process.argv[index + 1]
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function findLicenseFile(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const licenseEntry = entries.find((entry) => entry.isFile() && /^LICENSE(?:\..+)?$/i.test(entry.name))
  return licenseEntry?.name
}

function npmCommand() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath],
    }
  }

  const npmCliPath = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  return {
    command: process.execPath,
    args: [npmCliPath],
  }
}

async function readPackageMetadata(root) {
  const packageJsonPath = resolve(root, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"))

  if (typeof packageJson.name !== "string" || !packageJson.name) {
    throw new Error("Missing required package.json field: name")
  }

  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("Missing required package.json field: version")
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
  }
}

const sourceRoot = resolve(readOption("--source") ?? process.cwd())
const outputRoot = resolve(readOption("--output") ?? ".release/package")
const artifactRoot = resolve(readOption("--artifact-dir") ?? ".release")
const requiredEntries = ["package.json", "README.md", "dist"]

for (const entry of requiredEntries) {
  if (!(await pathExists(resolve(sourceRoot, entry)))) {
    throw new Error(`Missing required release entry: ${entry}`)
  }
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await mkdir(artifactRoot, { recursive: true })

const releaseEntries = [...requiredEntries]
const licenseFile = await findLicenseFile(sourceRoot)
if (licenseFile) {
  releaseEntries.splice(2, 0, licenseFile)
}

for (const entry of releaseEntries) {
  await cp(resolve(sourceRoot, entry), resolve(outputRoot, entry), { recursive: true })
}

await rm(resolve(outputRoot, "dist", "scripts"), { recursive: true, force: true })

const packageMetadata = await readPackageMetadata(outputRoot)
const npm = npmCommand()
const npmPackResult = await execFile(npm.command, [
  ...npm.args,
  "pack",
  outputRoot,
  "--pack-destination",
  artifactRoot,
], {
  cwd: sourceRoot,
  windowsHide: true,
})

const npmTarball = npmPackResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)

if (!npmTarball) {
  throw new Error("npm pack did not produce a tarball name")
}

const manualArchiveName = `${packageMetadata.name}-${packageMetadata.version}-plugin.tar.gz`
const manualArchivePath = resolve(artifactRoot, manualArchiveName)
const packageDirName = `${packageMetadata.name}-${packageMetadata.version}`
const stagingRoot = resolve(artifactRoot, ".staging")
const stagedPackageRoot = resolve(stagingRoot, packageDirName)

await rm(stagingRoot, { recursive: true, force: true })
await mkdir(stagedPackageRoot, { recursive: true })
await cp(outputRoot, stagedPackageRoot, { recursive: true })
await execFile(process.platform === "win32" ? "tar.exe" : "tar", [
  "-czf",
  manualArchivePath,
  "-C",
  stagingRoot,
  packageDirName,
], {
  cwd: sourceRoot,
  windowsHide: true,
})
await rm(stagingRoot, { recursive: true, force: true })

const manifest = {
  packageDir: outputRoot,
  npmTarball: resolve(artifactRoot, npmTarball),
  manualArchive: manualArchivePath,
  name: packageMetadata.name,
  version: packageMetadata.version,
}

const manifestPath = resolve(artifactRoot, "release-manifest.json")
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

process.stdout.write(JSON.stringify({
  outputRoot,
  artifactRoot,
  manifestPath,
  ...manifest,
}, null, 2))
process.stdout.write("\n")
