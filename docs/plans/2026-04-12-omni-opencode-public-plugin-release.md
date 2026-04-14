# Public Plugin Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare `omni-opencode` for public dual release as an OpenCode plugin via npm and GitHub release artifacts, using one canonical packaged payload for both channels.

**Architecture:** Define one canonical package-root plugin entry contract, assemble a clean release payload containing only essential runtime files, then drive both npm publish and GitHub artifact creation from that same payload. Use OpenCode's real plugin contract: npm packages are installed by package name into config, and local/manual installs use direct plugin files. Add verification steps for npm install, GitHub artifact install, and native OpenCode plugin-manager visibility/toggling so the release is proven installable and operable in the real Plugins panel.

**Tech Stack:** TypeScript, Node.js, npm packaging, GitHub release automation, OpenCode plugin loader

---

### Task 1: Inspect the exact OpenCode plugin install contract

**Files:**
- Modify: `README.md` only if notes are needed during research
- Create: `test/release-manifest.test.ts` if a manifest contract test is added immediately

**Step 1: Identify the real OpenCode plugin install contract**

Check current OpenCode documentation, installed examples, and loader expectations to confirm:

- whether npm plugins use package-root entrypoints rather than a separate plugin manifest file
- what `opencode plugin <module>` actually writes to config
- plugin entrypoint resolution expectations for npm-installed packages
- local/unpacked plugin loading expectations

**Step 2: Write down the exact target contract**

Capture the expected manifest shape and plugin entrypoint path before writing files.

**Step 3: If useful, add a failing test that asserts required manifest fields**

Run: `npm test -- test/release-manifest.test.ts`

Expected: FAIL if the manifest does not exist yet.

### Task 2: Align the package-root plugin entry contract

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src/index.ts` only if entrypoint comments or exports need alignment
- Test: `test/release-manifest.test.ts`

**Step 1: Resolve entrypoint ambiguity**

Ensure the npm package entry contract is explicit and correct:

- `package.json` points to the real built plugin entry used by npm installs
- local development config/comments are updated so they no longer imply a nonexistent package manifest contract

**Step 2: Add or update focused tests for the package entry contract**

**Step 3: Run focused tests**

Run: `npm test -- test/release-manifest.test.ts`

Expected: PASS

### Task 3: Define a clean release payload and packaging script

**Files:**
- Create: `scripts/package-release.mjs`
- Create: `scripts/release-smoke-install.mjs` if needed later
- Modify: `package.json`
- Create: `test/release-package.test.ts`

**Step 1: Write a failing test for package contents**

Assert that the packaged payload contains only essential release files such as:

- `package.json`
- `README.md`
- `dist/**`

and excludes development clutter like tests and monitor state.

**Step 2: Implement `scripts/package-release.mjs`**

The script should:

- create a clean release directory
- copy only required files
- optionally create zip/tar artifacts from that directory

**Step 3: Add package script entries**

Examples:

- `release:pack`
- `release:smoke`

**Step 4: Run focused tests**

Run: `npm test -- test/release-package.test.ts`

Expected: PASS

### Task 4: Add npm and GitHub release workflow automation

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `README.md`

**Step 1: Add a release workflow that uses the canonical packaging script**

Required behavior:

- run tests
- run build
- assemble canonical payload
- publish npm package
- create GitHub release
- upload artifact built from the same payload

**Step 2: Ensure the workflow does not maintain separate payload logic per channel**

The same packaging script should feed both outputs.

**Step 3: Review for secret handling**

Ensure tokens are referenced through GitHub secrets and not hardcoded.

### Task 5: Add install verification for both channels

**Files:**
- Create: `test/release-install.test.ts`
- Create or modify: `scripts/release-smoke-install.mjs`
- Modify: `README.md`

**Step 1: Add failing tests or smoke harness for install verification**

Cover:

- npm-installed payload loads as an OpenCode plugin
- unpacked GitHub release artifact loads the same way
- plugin installed via `opencode plugin <module>` appears in the Plugins panel under `External`
- plugin can be toggled off and on again cleanly through OpenCode's built-in plugin manager

Use the smallest practical install/load verification that matches actual loader behavior.

**Step 2: Implement the smoke install script**

It should:

- install or unpack into a temp directory
- point OpenCode at the plugin using the real contract:
  - package name for npm path
  - direct file/path config for manual artifact path
- verify tools load
- if practical, drive the normal plugin install path and verify the installed plugin appears as an external plugin with toggleable state

**Step 3: Run focused verification**

Run: `npm test -- test/release-install.test.ts`

Expected: PASS

### Task 6: Update release docs

**Files:**
- Modify: `README.md`

**Step 1: Document both release/install paths**

Add:

- npm install instructions
- manual GitHub artifact install instructions
- expected package entrypoint contract and local/manual path contract
- note that the plugin should appear in the OpenCode Plugins panel under `External`
- note that enable/disable is owned by OpenCode's built-in plugin manager

**Step 2: Document versioning and release source of truth**

Clarify that npm version, git tag, and GitHub release tag must match.

### Task 7: Run full verification and build

**Files:**
- Test: `test/release-manifest.test.ts`
- Test: `test/release-package.test.ts`
- Test: `test/release-install.test.ts`
- Test: any existing tests touched by packaging changes

**Step 1: Run focused release verification**

Run: `npm test -- test/release-manifest.test.ts test/release-package.test.ts test/release-install.test.ts`

Expected: PASS

**Step 2: Run full suite**

Run: `npm test -- --runInBand`

Expected: PASS

**Step 3: Run build**

Run: `npm run build`

Expected: PASS

**Step 4: Run canonical packaging script**

Run: `npm run release:pack`

Expected: canonical release payload and GitHub artifact created successfully

**Step 5: Commit**

```bash
git add package.json README.md src/index.ts scripts/package-release.mjs scripts/release-smoke-install.mjs .github/workflows/release.yml test/release-manifest.test.ts test/release-package.test.ts test/release-install.test.ts docs/plans/2026-04-12-omni-opencode-public-plugin-release-design.md docs/plans/2026-04-12-omni-opencode-public-plugin-release.md
git commit -m "feat: package omni-opencode for public plugin release"
```
