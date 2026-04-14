import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import pty from "node-pty"

const execFile = promisify(execFileCallback)

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function resolveOpencodeExecutable() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe")
  }

  return "opencode"
}

function npmCommand() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath],
    }
  }

  return {
    command: process.execPath,
    args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
  }
}

async function extractTarball(archivePath, outputRoot) {
  await mkdir(outputRoot, { recursive: true })
  await execFile(process.platform === "win32" ? "tar.exe" : "tar", [
    "-xzf",
    archivePath,
    "-C",
    outputRoot,
  ], {
    windowsHide: true,
  })
}

function sandboxEnv(homeRoot) {
  const drive = homeRoot.slice(0, 2)
  const homePath = homeRoot.slice(2)
  return {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    HOMEDRIVE: drive,
    HOMEPATH: homePath,
    XDG_CONFIG_HOME: join(homeRoot, ".config"),
  }
}

async function loadPluginModuleByName(moduleName, cwd) {
  const loader = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `const mod = await import(${JSON.stringify(moduleName)}); const plugin = mod.default; if (!plugin || typeof plugin.id !== 'string' || typeof plugin.server !== 'function') throw new Error('invalid plugin shape'); process.stdout.write(JSON.stringify({ id: plugin.id }))`,
  ], {
    cwd,
    windowsHide: true,
  })

  return JSON.parse(loader.stdout)
}

async function readResolvedConfig(configFilePath, cwd, homeRoot) {
  const result = await execFile(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "opencode", process.platform === "win32"
    ? ["/d", "/s", "/c", "opencode debug config"]
    : ["debug", "config"], {
    cwd,
    windowsHide: true,
    env: {
      ...sandboxEnv(homeRoot),
      OPENCODE_CONFIG: configFilePath,
      OPENCODE_CONFIG_DIR: dirname(configFilePath),
    },
  })

  return JSON.parse(result.stdout)
}

function findPluginOrigin(config, spec) {
  const origins = Array.isArray(config.plugin_origins) ? config.plugin_origins : []
  return origins.find((origin) => {
    if (typeof origin?.spec === "string") return origin.spec === spec
    return Array.isArray(origin?.spec) && origin.spec[0] === spec
  })
}

function findPluginEntry(config, spec) {
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  return plugins.find((entry) => {
    if (typeof entry === "string") return entry === spec
    return Array.isArray(entry) && entry[0] === spec
  })
}

async function installPluginSpec(opencodeExecutable, spec, homeRoot, cwd) {
  await execFile(opencodeExecutable, ["plugin", "--global", "--force", spec], {
    cwd,
    windowsHide: true,
    env: {
      ...sandboxEnv(homeRoot),
      PATH: `${dirname(opencodeExecutable)}${delimiter}${process.env.PATH ?? ""}`,
    },
  })
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(filePath)
      return true
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
  }
  return false
}

async function createHelperPackage(root, targetId, resultPath) {
  const packageRoot = join(root, "release-smoke-helper")
  const distRoot = join(packageRoot, "dist")
  await mkdir(distRoot, { recursive: true })

  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "release-smoke-helper",
    version: "0.0.0",
    type: "module",
    exports: {
      "./server": {
        import: "./dist/server.js",
        config: { enabled: true },
      },
      "./tui": {
        import: "./dist/tui.js",
        config: { enabled: true },
      },
    },
  }, null, 2))

  await writeFile(join(distRoot, "server.js"), [
    "export default {",
    '  id: "release-smoke-helper",',
    "  server: async () => ({}),",
    "}",
    "",
  ].join("\n"))

  await writeFile(join(distRoot, "tui.js"), [
    'import { writeFile } from "node:fs/promises"',
    "",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))",
    "",
    "async function waitForPlugin(api, targetId) {",
    "  for (let attempt = 0; attempt < 100; attempt += 1) {",
    "    const plugin = api.plugins.list().find((entry) => entry.id === targetId)",
    "    if (plugin) return plugin",
    "    await sleep(500)",
    "  }",
    "  return null",
    "}",
    "",
    "export default {",
    '  id: "release-smoke-helper",',
    "  tui: async (api) => {",
    `    const plugin = await waitForPlugin(api, ${JSON.stringify(targetId)})`,
    "    let transitions = null",
    "    if (plugin) {",
    `      await api.plugins.deactivate(${JSON.stringify(targetId)})`,
    "      await sleep(500)",
    "      const afterDeactivate = api.plugins.list().find((entry) => entry.id === plugin.id) ?? null",
    `      await api.plugins.activate(${JSON.stringify(targetId)})`,
    "      await sleep(500)",
    "      const afterReactivate = api.plugins.list().find((entry) => entry.id === plugin.id) ?? null",
    "      transitions = { afterDeactivate, afterReactivate }",
    "    }",
    `    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ plugin, transitions }, null, 2))`,
    "    process.exit(0)",
    "  },",
    "}",
    "",
  ].join("\n"))

  return packageRoot
}

async function runTuiProbe(opencodeExecutable, workspaceRoot, homeRoot, resultPath) {
  const proc = pty.spawn(opencodeExecutable, [workspaceRoot], {
    cwd: workspaceRoot,
    env: {
      ...sandboxEnv(homeRoot),
      PATH: `${dirname(opencodeExecutable)}${delimiter}${process.env.PATH ?? ""}`,
    },
    cols: 140,
    rows: 50,
    name: "xterm-256color",
  })

  let output = ""
  proc.onData((chunk) => {
    output += chunk
  })

  try {
    const ready = await waitForFile(resultPath, 70000)
    if (!ready) {
      throw new Error(`Timed out waiting for TUI plugin-manager probe. Output tail:\n${output.slice(-4000)}`)
    }

    return JSON.parse(await readFile(resultPath, "utf8"))
  } finally {
    if (proc.exitCode === undefined || proc.exitCode === null) {
      proc.kill()
    }
  }
}

async function runNpmScenario(manifest, opencodeExecutable, tempRoot) {
  const scenarioRoot = join(tempRoot, "npm")
  const workspaceRoot = join(scenarioRoot, "workspace")
  const configRoot = join(scenarioRoot, "config")
  const homeRoot = join(scenarioRoot, "home")
  const installedPackageRoot = join(scenarioRoot, "node_modules", manifest.name)

  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await mkdir(homeRoot, { recursive: true })

  const npm = npmCommand()
  await writeFile(join(scenarioRoot, "package.json"), JSON.stringify({
    name: "release-smoke-npm-install",
    private: true,
  }, null, 2))
  await execFile(npm.command, [
    ...npm.args,
    "install",
    "--omit=dev",
    manifest.npmTarball,
  ], {
    cwd: scenarioRoot,
    windowsHide: true,
  })

  const npmPlugin = await loadPluginModuleByName(`${manifest.name}/server`, scenarioRoot)

  const npmConfigPath = join(configRoot, "npm-opencode.json")
  await writeFile(npmConfigPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [manifest.name],
  }, null, 2))

  const npmConfig = await readResolvedConfig(npmConfigPath, workspaceRoot, homeRoot)
  const npmOrigin = findPluginOrigin(npmConfig, manifest.name)
  const npmEntry = findPluginEntry(npmConfig, manifest.name)

  if (!npmOrigin || typeof npmEntry !== "string") {
    throw new Error(`Resolved OpenCode config did not retain npm plugin spec ${manifest.name}`)
  }

  return {
    packageName: manifest.name,
    loadedPluginId: npmPlugin.id,
    resolvedPluginSpec: npmEntry,
    pluginOriginSpec: npmOrigin.spec,
    moduleRoot: installedPackageRoot,
  }
}

async function runManualScenario(manifest, opencodeExecutable, tempRoot) {
  const scenarioRoot = join(tempRoot, "manual")
  const workspaceRoot = join(scenarioRoot, "workspace")
  const homeRoot = join(scenarioRoot, "home")
  const resultPath = join(scenarioRoot, "result.json")
  const extractRoot = join(scenarioRoot, "extract")
  const helperRoot = await createHelperPackage(scenarioRoot, manifest.name, resultPath)

  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true })
  await mkdir(homeRoot, { recursive: true })

  await extractTarball(resolve(manifest.manualArchive), extractRoot)
  const omniRoot = join(extractRoot, `${manifest.name}-${manifest.version}`)

  await installPluginSpec(opencodeExecutable, helperRoot, homeRoot, workspaceRoot)
  await installPluginSpec(opencodeExecutable, omniRoot, homeRoot, workspaceRoot)

  await writeFile(join(workspaceRoot, ".opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [],
  }, null, 2))
  await writeFile(join(workspaceRoot, ".opencode", "tui.json"), JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    plugin_enabled: {
      [pathToFileURL(helperRoot).href]: true,
      [pathToFileURL(omniRoot).href]: true,
    },
  }, null, 2))

  return await runTuiProbe(opencodeExecutable, workspaceRoot, homeRoot, resultPath)
}

const manifestPath = readOption("--manifest")

if (!manifestPath) {
  throw new Error("Missing required option: --manifest")
}

const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"))
const tempRoot = await mkdtemp(join(tmpdir(), "omni-release-install-"))
const opencodeExecutable = resolveOpencodeExecutable()

try {
  const npm = await runNpmScenario(manifest, opencodeExecutable, tempRoot)
  const manual = await runManualScenario(manifest, opencodeExecutable, tempRoot)

  process.stdout.write(JSON.stringify({ npm, manual }, null, 2))
  process.stdout.write("\n")
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
