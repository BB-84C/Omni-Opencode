# Public Plugin Release Design

## Goal

Release `omni-opencode` as a public OpenCode plugin through two synchronized channels:

- npm package
- GitHub release artifact

Both channels must distribute the exact same built plugin payload.

## Problem

The repository already builds a plugin-shaped package, but it does not yet define a complete public release contract.

Current gaps include:

- no canonical packaged payload definition
- no release automation for npm + GitHub from the same build output
- no documented install contract for users
- no release verification path proving both npm and manual artifact installs work

Without those pieces, a package can be built but still fail to install cleanly as an OpenCode plugin.

## Desired Outcome

- one canonical plugin package layout
- one canonical built entrypoint
- one explicit OpenCode package entry contract
- one release workflow that publishes the same payload to npm and GitHub
- one verification workflow that proves both install paths work
- plugin appears in the OpenCode Plugins panel under `External`
- plugin can be enabled and disabled through OpenCode's built-in plugin manager

## Chosen Approach

Use a **dual-release model built from one canonical package payload**.

Release once, distribute twice:

1. build and verify the plugin
2. assemble one clean release payload with only essential runtime files
3. publish that payload to npm
4. create a Git tag and GitHub release
5. attach a zip/tar artifact built from the exact same payload

This avoids maintaining separate npm-only and GitHub-only layouts.

## Alternatives Considered

### 1. npm-only release

Pros:

- simplest public distribution path
- good default user experience

Cons:

- no manual fallback channel
- less convenient for direct testing and offline/manual install

### 2. GitHub artifact-only release

Pros:

- simpler than full package publication in some cases
- works even without npm publishing

Cons:

- worse install/upgrade story for most users
- more manual steps

### 3. Dual release from one canonical payload

Selected.

Pros:

- covers both common install paths
- no payload drift if both channels come from one build artifact
- better operational fallback

Cons:

- more release automation than single-channel publishing

## Canonical Package Layout

Define one official release payload and use it for both channels.

The payload should include only files required to install and run the plugin:

- `package.json`
- `README.md`
- `LICENSE` if present
- compiled runtime files under `dist/`
- any runtime assets actually required by the plugin after install

The payload should not include:

- tests
- local monitor state
- repository-only development docs unrelated to installation
- ad hoc validation files

Example shape:

```text
package/
  package.json
  README.md
  LICENSE
  dist/
    index.js
    plugin.js
    ...
```

## Entry Point Contract

OpenCode's npm plugin contract is package-root based, not manifest-file based.

For npm-installed plugins:

- `opencode plugin <module>` adds the package name to the `plugin` array in OpenCode config
- OpenCode resolves the package through normal Node package resolution
- the package must expose its plugin entry through normal package entrypoints such as `main` and/or `exports`

For local/unpacked plugins:

- OpenCode can load direct `.js`/`.ts` plugin files from local config paths or plugin directories

Release work must therefore resolve the repository's entry ambiguity so the public package has one clear package-root entry contract.

Current repository hints show:

- `package.json` points to `dist/index.js`
- local development config points to `dist/plugin.js`

The release must make the npm package self-contained and package-root loadable without relying on repository-relative config paths.

## Distribution Channels

### npm package

- primary install path
- semver versioned
- published from the canonical assembled payload, not from an ad hoc repository state

### GitHub release artifact

- zip/tar built from the same assembled payload
- attached to a tagged GitHub release
- intended for manual install, testing, and fallback distribution

## Plugin Manager Visibility

The public release must behave like a standard OpenCode external plugin package.

That means the correct architectural layer for visibility and toggling is OpenCode's built-in plugin manager, not custom toggle logic inside `omni-opencode`.

Release success therefore includes all of the following:

- `opencode plugin <module>` can install the package cleanly
- the installed package appears in the Plugins panel under `External`
- OpenCode shows the plugin by its intended package/plugin identity instead of a temporary or misleading label
- toggling the plugin off disables its tools and effects cleanly
- toggling the plugin back on restores it cleanly

The plugin should not implement its own parallel enable/disable mechanism for this purpose.

## Release Workflow

The dual release pipeline should be:

1. run full verification
   - tests
   - build
2. assemble a clean release directory from essential files only
3. publish the canonical payload to npm
4. create a git tag and GitHub release for the same version
5. attach the packaged artifact built from the same payload
6. run post-release verification on both install paths

Core rule:

- do not rebuild different payloads per channel
- do not maintain separate npm and GitHub layouts

## Install Contract

The release must include:

- one canonical package-root plugin entry contract
- one documented install contract for users

README install documentation should include:

1. npm install path using `opencode plugin <module>`
2. manual GitHub artifact install path
3. how OpenCode should point at the unpacked plugin for manual installs

## Verification Requirements

Every release should prove both channels work.

### npm verification

- install the packed npm artifact into a clean temporary directory
- point OpenCode at it
- verify the plugin loads and its tools are present

### GitHub artifact verification

- unzip the release artifact into a clean temporary directory
- point OpenCode at it
- verify the same plugin loads and the same tools are present

### Plugin manager verification

Every release should also verify OpenCode's native plugin management behavior:

- install the package through the normal `opencode plugin <module>` path
- confirm the plugin appears in the Plugins panel under `External`
- confirm it can be toggled off without leaving broken tool registrations behind
- confirm it can be toggled on again and restore its tools cleanly

This should be treated as a release requirement, not optional smoke coverage.

## Versioning

The following must align:

- `package.json` version
- git tag
- GitHub release tag

Release notes should refer to that single versioned artifact set.

## Recommended Automation

Use two layers:

1. local packaging script
   - assemble canonical payload
   - create packed archive
2. CI workflow
   - verify
   - run local packaging script
   - publish npm package
   - create GitHub release
   - upload canonical artifacts

This keeps the packaging logic reproducible locally instead of hiding it entirely inside CI YAML.

## Non-Goals

- separate npm and GitHub package layouts
- publishing directly from arbitrary repository state without a clean assembled payload
- shipping repository development clutter in public release artifacts
- implementing a custom plugin-owned toggle system separate from OpenCode's plugin manager
- introducing a package-internal OpenCode manifest file if the loader contract does not use one
