# Omni-Opencode Managed psmux Design

**Date:** 2026-04-06

## Goal

Extend the current Windows `psmux` runtime so the plugin can install and manage its own pinned `psmux` binary from GitHub releases, instead of requiring a preinstalled system binary on `PATH`.

## Core Principle

On Windows, `psmux` is the required primary backend.

The plugin must be able to:

- download a pinned `psmux` release on first use
- extract it into a plugin-managed cache
- verify it
- reuse it on later launches
- run all Windows `psmux` commands through the managed binary path

This should replace the current support-only bootstrap check path.

## Managed Binary Strategy

Use a plugin-managed local cache directory, not a system-wide install.

Suggested structure:

```text
.omni-tools/
  psmux/
    manifest.json
    vX.Y.Z/
      psmux.exe
      ...other extracted files...
```

The managed binary path becomes the primary Windows runtime command source.

## Versioning

Pin a single explicit `psmux` version in code/config.

Runtime startup flow:

1. check managed cache for pinned version
2. if present and valid, use it
3. if missing, download release zip
4. extract it into the versioned cache directory
5. verify `psmux.exe` runs
6. update manifest metadata

Changing the pinned version later should trigger a new managed install without overwriting older cached versions unnecessarily.

## Download / Extract / Verify Flow

1. Build the pinned Windows GitHub release URL
2. Download the archive into the managed cache root
3. Extract into `.omni-tools/psmux/vX.Y.Z/`
4. Locate `psmux.exe`
5. Verify with a lightweight invocation such as `psmux --help`
6. Persist manifest metadata

## Failure Behavior

If managed install fails:

- fail the Windows runtime start clearly
- include:
  - pinned version attempted
  - URL attempted
  - stage of failure (download/extract/verify)
  - whether any cached version exists

Do not silently mutate `PATH`.
Do not install system-wide.
Do not silently pretend the plugin is ready.

## Attach Contract

Because the plugin now owns the binary, the attach command should be explicit and honest.

User-facing Windows attach command should use the resolved managed binary path, for example:

```bash
"D:\Omni-Opencode\.omni-tools\psmux\vX.Y.Z\psmux.exe" attach -t <monitorSessionId>
```

This keeps the attach path reproducible even when `psmux` is not on `PATH`.

## Keep / Replace

### Keep

- existing `windows-psmux` runtime/session/dashboard logic
- existing `pipe-pane` bookkeeping
- existing batch resume behavior
- existing `node-pty` archive/fallback code as archive only

### Replace / Upgrade

- `detectWindowsPsmux()` as support-only check
- `bootstrap:windows-psmux` as support-only check
- runtime command building that assumes bare `psmux` on `PATH`

## Verification Standard

Do not call this complete unless a live Windows session proves:

1. No preinstalled `psmux` is required
2. First delegated Windows launch downloads and installs pinned `psmux` into managed cache
3. Second delegated launch reuses cached managed binary without redownloading
4. Attach command returned to the user uses the managed binary path
5. That managed-binary attach command works
6. Shared-session/dashboard behavior still works after managed install
7. Aggregate batch follow-up still works

## Non-Goals

This design does not change:

- Linux/macOS runtime behavior
- `psmux` dashboard/session semantics
- `pipe-pane` bookkeeping model
- archived `node-pty` fallback retention
