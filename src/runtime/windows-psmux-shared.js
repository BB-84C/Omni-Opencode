import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const WINDOWS_PSMUX_BOOTSTRAP_SCRIPT = "bootstrap:windows-psmux"
export const WINDOWS_PSMUX_INSTALL_DOCS_URL = "https://github.com/search?q=psmux&type=repositories"

export async function detectWindowsPsmux(options = {}) {
  const platform = options.platform ?? process.platform
  const command = options.command ?? "psmux"

  if (platform !== "win32") {
    return { available: false, command }
  }

  const resolvedPath = await (options.which ?? resolveCommandOnPath)(command)
  if (!resolvedPath) {
    return { available: false, command, reason: "missing-on-path" }
  }

  const versionResult = await (options.runVersion ?? runVersionCommand)(resolvedPath, ["-V"])
  if (versionResult.exitCode !== 0) {
    return {
      available: true,
      command,
      resolvedPath,
      reason: "version-check-failed",
      error: firstNonEmptyLine(versionResult.stderr, versionResult.stdout) ?? `psmux version probe exited with code ${versionResult.exitCode}`,
    }
  }

  return {
    available: true,
    command,
    resolvedPath,
    version: firstNonEmptyLine(versionResult.stdout, versionResult.stderr),
  }
}

export function createWindowsPsmuxBootstrapReport(detection) {
  const status = detection.reason ?? (detection.available ? "available" : "missing-on-path")
  const lines = ["psmux bootstrap check", `status: ${status}`]

  if (detection.resolvedPath) {
    lines.push(`path: ${detection.resolvedPath}`)
  }

  if (detection.version) {
    lines.push(`version: ${detection.version}`)
  }

  if (detection.error) {
    lines.push(`error: ${detection.error}`)
  }

  lines.push("install help: install psmux and ensure psmux.exe is available on PATH.")
  lines.push(`docs: ${WINDOWS_PSMUX_INSTALL_DOCS_URL}`)

  return `${lines.join("\n")}\n`
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

async function resolveCommandOnPath(command) {
  try {
    const result = await execFileAsync("where.exe", [command], { windowsHide: true })
    return firstNonEmptyLine(result.stdout)
  } catch {
    return undefined
  }
}

async function runVersionCommand(command, args) {
  try {
    const result = await execFileAsync(command, args, { windowsHide: true })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout,
      stderr: error?.stderr,
    }
  }
}
