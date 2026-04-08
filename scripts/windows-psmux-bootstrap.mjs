import { execFile as execFileCallback } from "node:child_process"
import { mkdir as nodeMkdir, writeFile as nodeWriteFile } from "node:fs/promises"
import { promisify } from "node:util"
import {
  WINDOWS_PSMUX_MANAGED_VERSION,
  ensureManagedWindowsPsmuxInstalled,
  resolveManagedWindowsPsmuxPaths,
} from "../src/runtime/windows-psmux-managed-shared.js"

const execFile = promisify(execFileCallback)

const RELEASE_REPOSITORY = "psmux/psmux"
const TEST_MODE = process.env.OMNI_PSMUX_BOOTSTRAP_TEST_MODE === "1"
const bootstrapTarget = resolveBootstrapTarget()
let observedDownloadReleaseUrl

try {
  const context = await prepareBootstrapContext(bootstrapTarget)
  const result = await ensureManagedWindowsPsmuxInstalled({
    cwd: context.cwd,
    platform: context.platform,
    arch: context.arch,
    releaseUrl: context.releaseUrl,
    ...createBootstrapHooks(context),
  })

  process.stdout.write(createSuccessReport(context, result))
} catch (error) {
  const failure = normalizeBootstrapFailure(error)
  process.stdout.write(createFailureReport(failure))
  process.stderr.write(`${failure.message}\n`)
  process.exitCode = 1
}

function resolveBootstrapTarget() {
  const cwd = process.cwd()
  const platform = TEST_MODE && process.env.OMNI_PSMUX_BOOTSTRAP_TEST_PLATFORM ? process.env.OMNI_PSMUX_BOOTSTRAP_TEST_PLATFORM : process.platform
  const arch = TEST_MODE && process.env.OMNI_PSMUX_BOOTSTRAP_TEST_ARCH ? process.env.OMNI_PSMUX_BOOTSTRAP_TEST_ARCH : process.arch

  return {
    cwd,
    platform,
    arch,
    releaseUrl: undefined,
    paths: resolveManagedWindowsPsmuxPaths({ cwd, platform, arch }),
  }
}

function prepareBootstrapContext(target) {
  return runStage("prepare", () => {
    const releaseAssetName = `psmux-v${WINDOWS_PSMUX_MANAGED_VERSION}-windows-${mapReleaseArch(target.arch)}.zip`

    return {
      ...target,
      releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${WINDOWS_PSMUX_MANAGED_VERSION}/${releaseAssetName}`,
    }
  }, undefined, undefined, target.paths)
}

function createBootstrapHooks(context) {
  if (TEST_MODE) {
    return {
      fileExists: async () => process.env.OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS === "1",
      mkdir: async () => runStage("prepare", () => undefined, context.releaseUrl, context.paths),
      writeFile: async () => runTestStage("persist", context.releaseUrl, context.paths, () => undefined),
      download: async ({ destinationPath, releaseUrl }) =>
        runTestStage("download", releaseUrl, context.paths, () => {
          if (process.env.OMNI_PSMUX_BOOTSTRAP_TEST_RECORD_DOWNLOAD_URL === "1") {
            observedDownloadReleaseUrl = releaseUrl
          }

          return destinationPath
        }),
      extract: async ({ paths, releaseUrl }) =>
        runTestStage("extract", releaseUrl, paths, () => paths.binaryPath),
      verify: async (_binaryPath, paths) =>
        runTestStage("verify", context.releaseUrl, paths, () => {
          const versionLine = process.env.OMNI_PSMUX_BOOTSTRAP_TEST_VERSION_OUTPUT ?? `psmux ${WINDOWS_PSMUX_MANAGED_VERSION}`
          assertPinnedVersion(versionLine)
        }),
    }
  }

  return {
    mkdir: async (path, options) => runStage("prepare", () => nodeMkdir(path, options), context.releaseUrl, context.paths),
    writeFile: async (path, data, encoding) =>
      runStage(
        "persist",
        () => nodeWriteFile(path, data, encoding),
        context.releaseUrl,
        context.paths,
      ),
    download: async ({ destinationPath, releaseUrl }) =>
      runStage(
        "download",
        async () => {
          await runPowerShell(`Invoke-WebRequest -Uri '${escapePowerShell(releaseUrl)}' -OutFile '${escapePowerShell(destinationPath)}'`)
          return destinationPath
        },
        releaseUrl,
      ),
    extract: async ({ archivePath, destinationPath, paths, releaseUrl }) =>
      runStage(
        "extract",
        async () => {
          await runPowerShell(
            `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(destinationPath)}' -Force`,
          )
          return paths.binaryPath
        },
        releaseUrl,
      ),
    verify: async (binaryPath, paths) =>
      runStage(
        "verify",
        async () => {
          const result = await execFile(binaryPath, ["-V"], { windowsHide: true })
          const versionLine = firstNonEmptyLine(result.stdout, result.stderr)
          assertPinnedVersion(versionLine)
        },
        context.releaseUrl,
        paths,
      ),
  }
}

async function runTestStage(stage, releaseUrl, paths, callback) {
  if (process.env.OMNI_PSMUX_BOOTSTRAP_TEST_FAIL_STAGE === stage) {
    throw createStageError(stage, `${stage} test failure`, releaseUrl, paths)
  }

  return runStage(stage, callback, releaseUrl, paths)
}

async function runStage(stage, callback, releaseUrl, paths) {
  try {
    return await callback()
  } catch (error) {
    if (error?.stage) {
      throw error
    }

    throw createStageError(stage, error?.message ?? String(error), releaseUrl, paths)
  }
}

function createSuccessReport(context, result) {
  const action = result.installed ? "installed managed psmux" : "reusing cached managed psmux"
  const status = result.installed ? "installed" : "cached"

  return [
    "psmux bootstrap",
    `status: ${status}`,
    `action: ${action}`,
    `version: ${WINDOWS_PSMUX_MANAGED_VERSION}`,
    `binary: ${result.binaryPath}`,
    `manifest: ${result.manifestPath}`,
    `release-url: ${context.releaseUrl}`,
    ...(observedDownloadReleaseUrl ? [`download-release-url: ${observedDownloadReleaseUrl}`] : []),
    "",
  ].join("\n")
}

function createFailureReport(failure) {
  return [
    "psmux bootstrap",
    "status: failed",
    `stage: ${failure.stage}`,
    `version: ${WINDOWS_PSMUX_MANAGED_VERSION}`,
    `platform: ${failure.platform}`,
    `arch: ${failure.arch}`,
    `binary: ${failure.binaryPath}`,
    `manifest: ${failure.manifestPath}`,
    `release-url: ${failure.releaseUrl}`,
    `error: ${failure.message}`,
    "",
  ].join("\n")
}

function normalizeBootstrapFailure(error) {
  return {
    stage: error?.stage ?? "bootstrap",
    message: error?.message ?? String(error),
    releaseUrl: error?.releaseUrl ?? bootstrapTarget.releaseUrl ?? "unavailable",
    platform: error?.platform ?? bootstrapTarget.platform,
    arch: error?.arch ?? bootstrapTarget.arch,
    binaryPath: error?.binaryPath ?? bootstrapTarget.paths.binaryPath,
    manifestPath: error?.manifestPath ?? bootstrapTarget.paths.manifestPath,
  }
}

function createStageError(stage, detail, releaseUrl, paths = bootstrapTarget.paths) {
  const error = new Error(`psmux bootstrap failed during ${stage}: ${detail}`)
  error.stage = stage
  error.releaseUrl = releaseUrl ?? "unavailable"
  error.platform = bootstrapTarget.platform
  error.arch = bootstrapTarget.arch
  error.binaryPath = paths?.binaryPath
  error.manifestPath = paths?.manifestPath
  return error
}

function assertPinnedVersion(versionLine) {
  if (!versionLine) {
    throw new Error(`expected psmux ${WINDOWS_PSMUX_MANAGED_VERSION} but version output was empty.`)
  }

  const expectedVersionPattern = new RegExp(`^psmux v?${escapeRegExp(WINDOWS_PSMUX_MANAGED_VERSION)}(?:\\s|$)`, "u")
  if (!expectedVersionPattern.test(versionLine.trim())) {
    throw new Error(
      `expected psmux ${WINDOWS_PSMUX_MANAGED_VERSION} but received '${versionLine.trim()}'.`,
    )
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

function mapReleaseArch(value) {
  if (value === "x64" || value === "arm64") {
    return value
  }

  if (value === "ia32") {
    return "x86"
  }

  throw new Error(`Unsupported Windows psmux architecture '${value}'.`)
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function runPowerShell(command) {
  await execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true },
  )
}
