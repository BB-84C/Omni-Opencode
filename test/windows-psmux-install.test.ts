import { describe, expect, it, vi } from "vitest"
import { createMissingWindowsPsmuxError, createWindowsPsmuxRuntime } from "../src/runtime/windows-psmux.js"

const MANAGED_VERSION = "3.3.1"
const MANAGED_CACHE_ROOT = "D:/Omni-Opencode/.omni-tools/psmux"
const MANAGED_VERSION_ROOT = `${MANAGED_CACHE_ROOT}/${MANAGED_VERSION}`
const MANAGED_PLATFORM_CACHE_ROOT = `${MANAGED_VERSION_ROOT}/win32-x64`
const MANAGED_MANIFEST_PATH = `${MANAGED_CACHE_ROOT}/manifest.json`
const MANAGED_BINARY_PATH = `${MANAGED_PLATFORM_CACHE_ROOT}/psmux.exe`

function createMockPty() {
  const dataListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []

  return {
    pid: 1,
    kill() {},
    onData(listener: (chunk: string) => void) {
      dataListeners.push(listener)
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListeners.push(listener)
    },
  }
}

function createRuntime(options: Record<string, unknown> = {}) {
  return createWindowsPsmuxRuntime({
    platform: "win32",
    cwd: "D:/Omni-Opencode",
    ensureManagedPsmuxInstalled: async () => ({
      binaryPath: MANAGED_BINARY_PATH,
      manifestPath: MANAGED_MANIFEST_PATH,
      installed: false,
    }),
    hasSharedSession: async () => false,
    runPsmuxCommand: async () => undefined,
    runPsmuxQuery: async (command: string) => {
      if (command.includes('list-panes') && command.includes(':dashboard')) {
        return [
          '%11 0 0 0 120 60',
          '%12 1 120 0 80 60',
        ].join('\n')
      }

      if (command.includes('new-window -P -F "#{window_index} #{pane_id}"')) {
        return '1 %21'
      }

      throw new Error(`Unexpected query: ${command}`)
    },
    ...options,
  })
}

function createDashboardQueryStub(binaryPath = MANAGED_BINARY_PATH) {
  return vi.fn(async (command: string) => {
    if (command.includes(`list-panes -t parent-session-first-use:dashboard`) || command.includes(`list-panes -t parent-session-attach:dashboard`) || command.includes(`list-panes -t parent-session-managed:dashboard`)) {
      return [
        "%11 0 0 0 120 60",
        "%12 1 120 0 80 60",
      ].join("\n")
    }

    if (command.includes('new-window -P -F "#{window_index} #{pane_id}"')) {
      return '1 %21'
    }

    throw new Error(`Unexpected query: ${command}`)
  })
}

function expectManagedAttachCommand(job: Awaited<ReturnType<ReturnType<typeof createWindowsPsmuxRuntime>["start"]>>, sessionId: string) {
  expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t ${sessionId}`)
  expect(job.monitor.launch.command).toBe(`${MANAGED_BINARY_PATH} attach -t ${sessionId}`)
}

describe("Windows managed psmux install contract", () => {
  it("resolves a deterministic pinned managed binary path for the current windows platform", async () => {
    const { WINDOWS_PSMUX_MANAGED_VERSION, resolveManagedWindowsPsmuxPaths } = await import("../src/runtime/windows-psmux-managed.js")

    const paths = resolveManagedWindowsPsmuxPaths({
      cwd: "D:/Omni-Opencode",
      platform: "win32",
      arch: "x64",
    })

    expect(WINDOWS_PSMUX_MANAGED_VERSION).toBe(MANAGED_VERSION)
    expect(paths.cacheRoot).toBe(MANAGED_CACHE_ROOT)
    expect(paths.versionRoot).toBe(MANAGED_VERSION_ROOT)
    expect(paths.platformCacheRoot).toBe(MANAGED_PLATFORM_CACHE_ROOT)
    expect(paths.binaryPath).toBe(MANAGED_BINARY_PATH)
  })

  it("builds deterministic manifest and cache paths", async () => {
    const { resolveManagedWindowsPsmuxPaths } = await import("../src/runtime/windows-psmux-managed.js")

    const first = resolveManagedWindowsPsmuxPaths({
      cwd: "D:/Omni-Opencode",
      platform: "win32",
      arch: "x64",
    })
    const second = resolveManagedWindowsPsmuxPaths({
      cwd: "D:/Omni-Opencode",
      platform: "win32",
      arch: "x64",
    })

    expect(first.manifestPath).toBe(MANAGED_MANIFEST_PATH)
    expect(second.manifestPath).toBe(MANAGED_MANIFEST_PATH)
    expect(second.platformCacheRoot).toBe(first.platformCacheRoot)
    expect(second.binaryPath).toBe(first.binaryPath)
  })

  it("downloads, extracts, verifies, and records manifest metadata when the managed version is missing", async () => {
    const { ensureManagedWindowsPsmuxInstalled } = await import("../src/runtime/windows-psmux-managed.js")
    const extractedBinaryPath = `${MANAGED_PLATFORM_CACHE_ROOT}/bin/psmux.exe`
    const downloadedArchivePath = `${MANAGED_CACHE_ROOT}/downloads/psmux-win32-x64.zip`
    const download = vi.fn(async () => downloadedArchivePath)
    const extract = vi.fn(async () => extractedBinaryPath)
    const verify = vi.fn(async () => undefined)
    const mkdir = vi.fn(async () => undefined)
    const writeFile = vi.fn(async () => undefined)

    const install = await ensureManagedWindowsPsmuxInstalled({
      cwd: "D:/Omni-Opencode",
      platform: "win32",
      arch: "x64",
      fileExists: async () => false,
      download,
      extract,
      verify,
      mkdir,
      writeFile,
      now: () => "2026-04-07T00:00:00.000Z",
    })

    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith({
      version: MANAGED_VERSION,
      platform: "win32",
      arch: "x64",
      destinationPath: `${MANAGED_CACHE_ROOT}/psmux.zip`,
      releaseUrl: "https://github.com/psmux/psmux/releases/download/v3.3.1/psmux-v3.3.1-windows-x64.zip",
      paths: expect.objectContaining({
        binaryPath: MANAGED_BINARY_PATH,
        manifestPath: MANAGED_MANIFEST_PATH,
      }),
    })
    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract).toHaveBeenCalledWith({
      archivePath: downloadedArchivePath,
      destinationPath: MANAGED_PLATFORM_CACHE_ROOT,
      version: MANAGED_VERSION,
      platform: "win32",
      arch: "x64",
      releaseUrl: "https://github.com/psmux/psmux/releases/download/v3.3.1/psmux-v3.3.1-windows-x64.zip",
      paths: expect.objectContaining({
        platformCacheRoot: MANAGED_PLATFORM_CACHE_ROOT,
      }),
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledWith(extractedBinaryPath, expect.objectContaining({
      binaryPath: MANAGED_BINARY_PATH,
    }))
    expect(writeFile).toHaveBeenCalledWith(
      MANAGED_MANIFEST_PATH,
      JSON.stringify({
        version: MANAGED_VERSION,
        platform: "win32",
        arch: "x64",
        binaryPath: extractedBinaryPath,
        installedAt: "2026-04-07T00:00:00.000Z",
      }, null, 2),
      "utf-8",
    )
    expect(install).toEqual({
      binaryPath: extractedBinaryPath,
      manifestPath: MANAGED_MANIFEST_PATH,
      installed: true,
    })
  })

  it("auto-installs managed psmux on first runtime use when the cache is empty", async () => {
    const mkdir = vi.fn(async () => undefined)
    const writeFile = vi.fn(async () => undefined)
    const runPowerShellCommand = vi.fn(async () => undefined)
    const execFile = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe(MANAGED_BINARY_PATH)
      expect(args).toEqual(["-V"])

      return {
        stdout: `psmux ${MANAGED_VERSION}\n`,
        stderr: "",
      }
    })

    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      hasSharedSession: async () => false,
      runPsmuxCommand: async () => undefined,
      runPsmuxQuery: createDashboardQueryStub(),
      managedPsmuxInstallOptions: {
        fileExists: async () => false,
        mkdir,
        writeFile,
        runPowerShellCommand,
        execFile,
        now: () => "2026-04-07T00:00:00.000Z",
      },
    })

    const job = await runtime.start({
      backend: "codex",
      command: "codex run",
      monitorSessionId: "parent-session-first-use",
    })

    expectManagedAttachCommand(job, "parent-session-first-use")
    expect(runPowerShellCommand).toHaveBeenCalledTimes(2)
    expect(runPowerShellCommand).toHaveBeenNthCalledWith(
      1,
      "Invoke-WebRequest -Uri 'https://github.com/psmux/psmux/releases/download/v3.3.1/psmux-v3.3.1-windows-x64.zip' -OutFile 'D:/Omni-Opencode/.omni-tools/psmux/psmux.zip'",
    )
    expect(runPowerShellCommand).toHaveBeenNthCalledWith(
      2,
      "Expand-Archive -LiteralPath 'D:/Omni-Opencode/.omni-tools/psmux/psmux.zip' -DestinationPath 'D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64' -Force",
    )
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith(
      MANAGED_MANIFEST_PATH,
      JSON.stringify({
        version: MANAGED_VERSION,
        platform: "win32",
        arch: "x64",
        binaryPath: MANAGED_BINARY_PATH,
        installedAt: "2026-04-07T00:00:00.000Z",
      }, null, 2),
      "utf-8",
    )
    expect(mkdir).toHaveBeenCalledWith(MANAGED_CACHE_ROOT, { recursive: true })
    expect(mkdir).toHaveBeenCalledWith(MANAGED_PLATFORM_CACHE_ROOT, { recursive: true })
  })

  it("returns managed attach commands instead of invoking bare psmux", async () => {
    const runtime = createRuntime({
      runPsmuxQuery: createDashboardQueryStub(),
    })

    const job = await runtime.start({
      backend: "codex",
      command: "codex run",
      monitorSessionId: "parent-session-attach",
    })

    expectManagedAttachCommand(job, "parent-session-attach")
    expect(job.monitor.attachCommand).not.toContain("C:/tools/psmux.exe")
    expect(job.monitor.attachCommand).not.toBe("psmux attach -t parent-session-attach")
  })

  it("reports managed-cache guidance when the pinned binary is unavailable", () => {
    expect(createMissingWindowsPsmuxError(MANAGED_BINARY_PATH).message).toBe(
      `Windows psmux runtime requires the managed psmux binary at '${MANAGED_BINARY_PATH}'. Run 'npm run bootstrap:windows-psmux' to provision the plugin-managed cache before launching delegated jobs.`,
    )
  })
})
