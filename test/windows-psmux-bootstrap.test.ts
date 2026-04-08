import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import {
  WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
  WINDOWS_PSMUX_INSTALL_DOCS_URL,
  createWindowsPsmuxRuntime,
  createMissingWindowsPsmuxError,
  createWindowsPsmuxBootstrapReport,
  detectWindowsPsmux,
  getWindowsPsmuxBootstrapHooks,
} from "../src/runtime/windows-psmux.js"
import type { RuntimeJob } from "../src/runtime/types.js"

const execFile = promisify(execFileCallback)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const MANAGED_BINARY_PATH = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"

async function runBootstrapScript(env: NodeJS.ProcessEnv = {}) {
  return execFile(process.execPath, ["./scripts/windows-psmux-bootstrap.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    windowsHide: true,
  })
}

describe("Windows psmux bootstrap", () => {
  function createDashboardRuntime() {
    return createWindowsPsmuxRuntime({
      platform: 'win32',
      cwd: 'D:/Omni-Opencode',
      ensureManagedPsmuxInstalled: async () => ({
        binaryPath: MANAGED_BINARY_PATH,
        manifestPath: 'D:/Omni-Opencode/.omni-tools/psmux/manifest.json',
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
    })
  }

  it("detects psmux when the command resolves successfully", async () => {
    const detected = await detectWindowsPsmux({
      platform: "win32",
      which: async (command) => {
        expect(command).toBe("psmux")
        return "C:/Program Files/psmux/psmux.exe"
      },
      runVersion: async (command, args) => {
        expect(command).toBe("C:/Program Files/psmux/psmux.exe")
        expect(args).toEqual(["-V"])
        return {
          exitCode: 0,
          stdout: "psmux 3.3.1\n",
          stderr: "",
        }
      },
    })

    expect(detected).toEqual({
      available: true,
      command: "psmux",
      resolvedPath: "C:/Program Files/psmux/psmux.exe",
      version: "psmux 3.3.1",
    })
  })

  it("distinguishes a found executable from a failed version probe", async () => {
    const detected = await detectWindowsPsmux({
      platform: "win32",
      which: async () => "C:/Program Files/psmux/psmux.exe",
      runVersion: async () => ({
        exitCode: 7,
        stdout: "",
        stderr: "psmux failed to initialize",
      }),
    })

    expect(detected).toEqual({
      available: true,
      command: "psmux",
      resolvedPath: "C:/Program Files/psmux/psmux.exe",
      reason: "version-check-failed",
      error: "psmux failed to initialize",
    })
  })

  it("produces a clear runtime error when psmux is missing on Windows", () => {
    expect(createMissingWindowsPsmuxError().message).toBe(
      "Windows psmux runtime requires the managed psmux binary at 'psmux'. Run 'npm run bootstrap:windows-psmux' to provision the plugin-managed cache before launching delegated jobs.",
    )
  })

  it("surfaces the clear missing-psmux error from the managed runtime start path", async () => {
    const runtime = createWindowsPsmuxRuntime({
      platform: "win32",
      cwd: "D:/Omni-Opencode",
      ensureManagedPsmuxInstalled: async () => {
        throw createMissingWindowsPsmuxError(MANAGED_BINARY_PATH)
      },
    })

    await expect(
      runtime.start({
        backend: "codex",
        command: "codex run",
      }),
    ).rejects.toThrow(
      `Windows psmux runtime requires the managed psmux binary at '${MANAGED_BINARY_PATH}'. Run 'npm run bootstrap:windows-psmux' to provision the plugin-managed cache before launching delegated jobs.`,
    )
  })

  it("does not require a PATH-installed psmux when the managed binary exists", async () => {
    const runtime = createDashboardRuntime()

    const job = await runtime.start({
      backend: "codex",
      command: "codex run",
      monitorSessionId: "parent-session-managed",
    })

    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-managed`)
  })

  it("ignores a PATH-installed psmux when the managed binary path differs", async () => {
    const runtime = createDashboardRuntime()

    const job = await runtime.start({
      backend: "codex",
      command: "codex run",
      monitorSessionId: "parent-session-managed",
    })

    expect(job.monitor.attachCommand).toBe(`${MANAGED_BINARY_PATH} attach -t parent-session-managed`)
  })

  it("does not block runtime start when PATH probing fails if the managed binary exists", async () => {
    const psmuxRuntime = createDashboardRuntime()

    await expect(psmuxRuntime.start({ backend: "codex", command: "codex run" })).resolves.toMatchObject({
      command: "codex run",
      status: "running",
    })
  })

  it("defines the install/bootstrap hook surface", async () => {
    const hooks = getWindowsPsmuxBootstrapHooks()
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as {
      scripts?: Record<string, string>
    }

    expect(hooks).toEqual({
      installDocsUrl: WINDOWS_PSMUX_INSTALL_DOCS_URL,
      scriptName: WINDOWS_PSMUX_BOOTSTRAP_SCRIPT,
    })
    expect(packageJson.scripts?.[WINDOWS_PSMUX_BOOTSTRAP_SCRIPT]).toBeTruthy()
  })

  it("reports cached managed psmux reuse", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as {
      scripts?: Record<string, string>
    }
    const packageScript = packageJson.scripts?.[WINDOWS_PSMUX_BOOTSTRAP_SCRIPT]

    expect(packageScript).toBe("node ./scripts/windows-psmux-bootstrap.mjs")

    const { stdout } = await runBootstrapScript({
      OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
      OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "1",
    })

    expect(stdout).toContain("psmux bootstrap")
    expect(stdout).toContain("status: cached")
    expect(stdout).toContain(`binary: ${MANAGED_BINARY_PATH}`)
    expect(stdout).toContain("action: reusing cached managed psmux")
  })

  it("triggers managed install when the cached binary is missing", async () => {
    const { stdout } = await runBootstrapScript({
      OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
      OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "0",
    })

    expect(stdout).toContain("psmux bootstrap")
    expect(stdout).toContain("status: installed")
    expect(stdout).toContain(`binary: ${MANAGED_BINARY_PATH}`)
    expect(stdout).toContain("action: installed managed psmux")
  })

  it("passes the resolved release URL into the download hook", async () => {
    const { stdout } = await runBootstrapScript({
      OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
      OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "0",
      OMNI_PSMUX_BOOTSTRAP_TEST_RECORD_DOWNLOAD_URL: "1",
    })

    expect(stdout).toContain(
        "download-release-url: https://github.com/psmux/psmux/releases/download/v3.3.1/psmux-v3.3.1-windows-x64.zip",
    )
  })

  it("fails verification when the pinned version does not match", async () => {
    await expect(
      runBootstrapScript({
        OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
        OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "0",
        OMNI_PSMUX_BOOTSTRAP_TEST_VERSION_OUTPUT: "psmux 9.9.9",
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("stage: verify"),
      stderr: expect.stringContaining("expected psmux 3.3.1"),
    })
  })

  it.each(["download", "extract", "verify", "persist"])("surfaces actionable %s failures", async (stage) => {
    await expect(
      runBootstrapScript({
        OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
        OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "0",
        OMNI_PSMUX_BOOTSTRAP_TEST_FAIL_STAGE: stage,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(`stage: ${stage}`),
      stderr: expect.stringContaining(`psmux bootstrap failed during ${stage}`),
    })
  })

  it("includes release URL context in extract-stage failure reports", async () => {
    await expect(
      runBootstrapScript({
        OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
        OMNI_PSMUX_BOOTSTRAP_TEST_FILE_EXISTS: "0",
        OMNI_PSMUX_BOOTSTRAP_TEST_FAIL_STAGE: "extract",
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        "release-url: https://github.com/psmux/psmux/releases/download/v3.3.1/psmux-v3.3.1-windows-x64.zip",
      ),
      stderr: expect.stringContaining("psmux bootstrap failed during extract"),
    })
  })

  it("surfaces prepare failures without collapsing them into unknown", async () => {
    await expect(
      runBootstrapScript({
        OMNI_PSMUX_BOOTSTRAP_TEST_MODE: "1",
        OMNI_PSMUX_BOOTSTRAP_TEST_ARCH: "sparc",
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringMatching(/stage: prepare[\s\S]*platform: win32[\s\S]*arch: sparc[\s\S]*binary: D:\/Omni-Opencode\/.omni-tools\/psmux\/3\.3\.1\/win32-sparc\/psmux\.exe/u),
      stderr: expect.stringContaining("Unsupported Windows psmux architecture 'sparc'"),
    })
  })

  it("formats the bootstrap report from shared runtime detection data", () => {
    const report = createWindowsPsmuxBootstrapReport({
      available: true,
      command: "psmux",
      resolvedPath: "C:/Program Files/psmux/psmux.exe",
      reason: "version-check-failed",
      error: "psmux failed to initialize",
    })

    expect(report).toContain("psmux bootstrap check")
    expect(report).toContain("status: version-check-failed")
    expect(report).toContain("path: C:/Program Files/psmux/psmux.exe")
    expect(report).toContain("error: psmux failed to initialize")
    expect(report).toContain(WINDOWS_PSMUX_INSTALL_DOCS_URL)
  })
})
