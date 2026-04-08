import {
  WINDOWS_PSMUX_MANAGED_VERSION,
  ensureManagedWindowsPsmuxInstalled as ensureManagedWindowsPsmuxInstalledShared,
  resolveManagedWindowsPsmuxPaths as resolveManagedWindowsPsmuxPathsShared,
} from "./windows-psmux-managed-shared.js"

export { WINDOWS_PSMUX_MANAGED_VERSION }

export type ResolveManagedWindowsPsmuxPathsOptions = {
  cwd?: string
  version?: string
  platform?: NodeJS.Platform
  arch?: string
}

export type ManagedWindowsPsmuxPaths = {
  cacheRoot: string
  manifestPath: string
  versionRoot: string
  platformCacheRoot: string
  binaryPath: string
}

export type ManagedWindowsPsmuxManifest = {
  version: string
  platform: NodeJS.Platform
  arch: string
  binaryPath: string
  installedAt: string
}

export type EnsureManagedWindowsPsmuxInstalledOptions = ResolveManagedWindowsPsmuxPathsOptions & {
  releaseUrl?: string
  fileExists?: (path: string) => Promise<boolean> | boolean
  runPowerShellCommand?: (command: string) => Promise<void> | void
  execFile?: (
    command: string,
    args: string[],
    options?: { windowsHide?: boolean },
  ) => Promise<{ stdout?: string; stderr?: string }> | { stdout?: string; stderr?: string }
  download?: (params: {
    version: string
    platform: NodeJS.Platform
    arch: string
    releaseUrl?: string
    destinationPath: string
    paths: ManagedWindowsPsmuxPaths
  }) => Promise<string | void> | string | void
  extract?: (params: {
    archivePath: string
    destinationPath: string
    version: string
    platform: NodeJS.Platform
    arch: string
    releaseUrl?: string
    paths: ManagedWindowsPsmuxPaths
  }) => Promise<string | void> | string | void
  verify?: (binaryPath: string, paths: ManagedWindowsPsmuxPaths) => Promise<void> | void
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void> | void
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void> | void
  now?: () => string
}

export type ManagedWindowsPsmuxInstallResult = {
  binaryPath: string
  manifestPath: string
  installed: boolean
}

export function resolveManagedWindowsPsmuxPaths(
  options: ResolveManagedWindowsPsmuxPathsOptions = {},
): ManagedWindowsPsmuxPaths {
  return resolveManagedWindowsPsmuxPathsShared(options)
}

export async function ensureManagedWindowsPsmuxInstalled(
  options: EnsureManagedWindowsPsmuxInstalledOptions = {},
): Promise<ManagedWindowsPsmuxInstallResult> {
  return ensureManagedWindowsPsmuxInstalledShared(options)
}
