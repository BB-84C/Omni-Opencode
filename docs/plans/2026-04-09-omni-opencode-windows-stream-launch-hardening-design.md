# Windows Stream Launch Hardening Design

## Goal

Harden the Windows `psmux` delegated stream-json launch path so Codex and Claude both start reliably in `psmux` job windows while preserving the existing renderer and dashboard architecture.

## Problem

The current Windows stream-json path passes a resolved backend executable plus argv into the Node-based renderer process. In practice, the fragile boundary is not the renderer itself but the backend launch handoff across Windows PowerShell and `psmux`.

Observed failures showed that:

- stale or mismatched generated artifacts could end up passing `codex.ps1` into `spawn(..., { shell: false })`, producing `spawn EFTYPE`
- raw `psmux` validation succeeded when the pane launch used `powershell.exe -File <script>` with the backend invocation embedded inside the script
- direct backend execution for both Codex and Claude worked once PowerShell argument parsing was removed from the `psmux` boundary

## Chosen Approach

Keep the current renderer architecture and add a second generated backend-specific `.ps1` file for each delegated stream-json job.

The main job script remains the entrypoint for the `psmux` window. For delegated stream-json jobs it will still launch the renderer. The renderer contract changes so that it runs a backend PowerShell script via:

`powershell.exe -NoLogo -NoProfile -File <backend-script>`

instead of directly spawning the backend executable with a JSON args file.

## Alternatives Considered

### 1. Keep renderer and add backend script

This is the selected approach.

Pros:

- smallest fix to the proven failing boundary
- preserves current dashboard, transcript, and parser flow
- matches the raw `psmux` launch shape that was validated successfully

Cons:

- adds one more generated artifact per delegated job

### 2. Move more backend launch logic into the main job script

Pros:

- fewer moving parts between script layers

Cons:

- broadens the change beyond the known failure boundary
- mixes renderer orchestration and backend launch responsibilities

### 3. Remove renderer involvement from backend startup

Pros:

- could simplify the final architecture later

Cons:

- unnecessary refactor for the current defect
- risks destabilizing transcript and dashboard behavior while the launch path is still being re-established

## Design

### Runtime launch flow

For delegated stream-json jobs:

1. Resolve backend executable paths exactly as today.
2. Build backend-specific launch content:
   - Codex: `node.exe` plus `codex.js exec --json <prompt>`
   - Claude: `claude.exe -p <prompt> --output-format stream-json --verbose --include-partial-messages`
3. Write a generated backend PowerShell script under `.omni-monitors`.
4. Pass that backend script path to the renderer command.
5. Renderer spawns `powershell.exe -NoLogo -NoProfile -File <backend-script>` with `shell: false`.

The main `psmux` job window still starts via `powershell.exe -NoLogo -NoProfile -File <job-script>`.

### Script responsibilities

#### Main job script

- owns window entrypoint
- launches renderer
- appends the existing `__OMNI_OPENCODE_PSMUX_EXIT__` marker to transcript log

#### Backend script

- owns backend-specific command line only
- contains no transcript logic
- avoids extra PowerShell argv parsing at the `psmux` boundary

#### Renderer

- continues to own stdout/stderr capture
- continues to append structured stream logs
- continues to render stream records into transcript output
- changes from `spawn(backendCommand, backendArgs)` to `spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath])`

## File Changes

Primary file:

- `src/runtime/windows-psmux.ts`

Likely supporting updates:

- `test/windows-psmux.test.ts`
- possibly `test/windows-psmux-dashboard.test.ts` if any launch metadata assumptions change there

No dashboard or parser design changes are intended in this step.

## Testing Strategy

Update and extend the Windows runtime tests so they assert the new boundary directly.

Key checks:

- delegated Codex launch still creates the main job script and launches the `psmux` window the same way
- delegated Claude launch still creates the main job script and launches the `psmux` window the same way
- generated backend script contains the resolved executable path and expected command shape
- renderer script now launches `powershell.exe -NoLogo -NoProfile -File <backend-script>`
- old backend args file expectations are removed or replaced where no longer applicable

After code changes, run targeted Windows runtime tests and then rerun the build.

## Risks

- changing the renderer interface may require updates in multiple tests
- backend script quoting must preserve prompts exactly, including the correlation marker suffix
- stale `.omni-monitors` artifacts can still confuse manual inspection, so verification should use fresh generated files

## Non-Goals

- changing dashboard semantics
- changing parser behavior
- changing permission policy
- refactoring the renderer into a different architecture
