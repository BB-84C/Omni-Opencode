import { execFile as execFileCallback } from "node:child_process"
import { access, mkdir as nodeMkdir, writeFile as nodeWriteFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const RELEASE_REPOSITORY = "psmux/psmux"

export const WINDOWS_PSMUX_MANAGED_VERSION = "3.3.1"

export function resolveManagedWindowsPsmuxPaths(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const version = options.version ?? WINDOWS_PSMUX_MANAGED_VERSION
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const cacheRoot = normalizeWindowsPsmuxManagedPath(join(cwd, ".omni-tools", "psmux"))
  const versionRoot = normalizeWindowsPsmuxManagedPath(join(cacheRoot, version))
  const platformCacheRoot = normalizeWindowsPsmuxManagedPath(join(versionRoot, `${platform}-${arch}`))

  return {
    cacheRoot,
    manifestPath: normalizeWindowsPsmuxManagedPath(join(cacheRoot, "manifest.json")),
    versionRoot,
    platformCacheRoot,
    binaryPath: normalizeWindowsPsmuxManagedPath(join(platformCacheRoot, "psmux.exe")),
  }
}

export async function ensureManagedWindowsPsmuxInstalled(options = {}) {
  const version = options.version ?? WINDOWS_PSMUX_MANAGED_VERSION
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const releaseUrl = options.releaseUrl ?? resolveManagedWindowsPsmuxReleaseUrl({ version, platform, arch })
  const paths = resolveManagedWindowsPsmuxPaths({
    cwd: options.cwd,
    version,
    platform,
    arch,
  })
  const fileExists = options.fileExists ?? defaultFileExists

  if (await fileExists(paths.binaryPath)) {
    return {
      binaryPath: paths.binaryPath,
      manifestPath: paths.manifestPath,
      installed: false,
    }
  }

  const mkdir = options.mkdir ?? nodeMkdir
  const writeFile = options.writeFile ?? nodeWriteFile
  const runPowerShellCommand = options.runPowerShellCommand ?? defaultRunPowerShellCommand
  const execFileImpl = options.execFile ?? execFile
  const download = options.download ?? createDefaultManagedWindowsPsmuxDownload(runPowerShellCommand)
  const extract = options.extract ?? createDefaultManagedWindowsPsmuxExtract(runPowerShellCommand)
  const verify = options.verify ?? createDefaultManagedWindowsPsmuxVerify(execFileImpl, version)
  const archivePath = normalizeWindowsPsmuxManagedPath(join(paths.cacheRoot, "psmux.zip"))

  await mkdir(paths.cacheRoot, { recursive: true })
  await mkdir(paths.platformCacheRoot, { recursive: true })
  const downloadedArchivePath = (await download({
    version,
    platform,
    arch,
    releaseUrl,
    destinationPath: archivePath,
    paths,
  })) ?? archivePath

  const extractedBinaryPath = (await extract({
    archivePath: downloadedArchivePath,
    destinationPath: paths.platformCacheRoot,
    version,
    platform,
    arch,
    releaseUrl,
    paths,
  })) ?? paths.binaryPath

  await verify(extractedBinaryPath, paths)

  await writeFile(
    paths.manifestPath,
    JSON.stringify(
      {
        version,
        platform,
        arch,
        binaryPath: extractedBinaryPath,
        installedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
      null,
      2,
    ),
    "utf-8",
  )

  return {
    binaryPath: extractedBinaryPath,
    manifestPath: paths.manifestPath,
    installed: true,
  }
}

function normalizeWindowsPsmuxManagedPath(value) {
  return value.replace(/\\/g, "/")
}

async function defaultFileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function createDefaultManagedWindowsPsmuxDownload(runPowerShellCommand) {
  return async ({ destinationPath, releaseUrl }) => {
    await runPowerShellCommand(
      `Invoke-WebRequest -Uri '${escapePowerShell(releaseUrl)}' -OutFile '${escapePowerShell(destinationPath)}'`,
    )
    return destinationPath
  }
}

function createDefaultManagedWindowsPsmuxExtract(runPowerShellCommand) {
  return async ({ archivePath, destinationPath, paths }) => {
    await runPowerShellCommand(
      `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(destinationPath)}' -Force`,
    )
    return paths.binaryPath
  }
}

function createDefaultManagedWindowsPsmuxVerify(execFileImpl, version) {
  return async (binaryPath) => {
    const result = await execFileImpl(binaryPath, ["-V"], { windowsHide: true })
    assertPinnedVersion(version, firstNonEmptyLine(result.stdout, result.stderr))
  }
}

function resolveManagedWindowsPsmuxReleaseUrl({ version, arch }) {
  const releaseAssetName = `psmux-v${version}-windows-${mapReleaseArch(arch)}.zip`
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${releaseAssetName}`
}

function mapReleaseArch(value) {
  if (value === "x64" || value === "arm64") {
    return value
  }

  if (value === "ia32") {
    return "x86"
  }

  throw new Error(`Unsupported Windows psmux architecture '${value}'.`)
}

function assertPinnedVersion(version, versionLine) {
  if (!versionLine) {
    throw new Error(`expected psmux ${version} but version output was empty.`)
  }

  const expectedVersionPattern = new RegExp(`^psmux v?${escapeRegExp(version)}(?:\\s|$)`, "u")
  if (!expectedVersionPattern.test(versionLine.trim())) {
    throw new Error(`expected psmux ${version} but received '${versionLine.trim()}'.`)
  }
}

function firstNonEmptyLine(...values) {
  for (const value of values) {
    const line = value
      ?.split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean)

    if (line) {
      return line
    }
  }

  return undefined
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function defaultRunPowerShellCommand(command) {
  await execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true },
  )
}
