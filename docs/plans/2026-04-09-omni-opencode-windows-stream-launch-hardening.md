# Windows Stream Launch Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the Windows `psmux` delegated stream-json launch path by generating backend-specific PowerShell scripts and having the renderer invoke those scripts with `powershell.exe -File`.

**Architecture:** Keep the existing renderer and dashboard flow intact. Replace the fragile renderer-to-backend executable/argv handoff with a generated backend `.ps1` script per delegated job, so the `psmux` window still launches the main job script and the renderer launches a backend script using the same PowerShell file-based shape proven in raw `psmux` probes.

**Tech Stack:** TypeScript, Node.js, PowerShell, Vitest, Windows `psmux`

---

### Task 1: Update failing tests to the new backend-script contract

**Files:**
- Modify: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Write the failing test expectations**

Update the delegated Codex and Claude tests so they expect:

- a generated backend PowerShell script path instead of relying on backend args passed to the renderer
- renderer script content that spawns `powershell.exe` with `-NoLogo`, `-NoProfile`, and `-File`
- the generated backend script content to include the resolved backend command shape

Concrete expectations to add or replace:

```ts
expect(jobScript).toContain("delegation-renderer.cjs")
expect(jobScript).toContain("runtime-1.backend.ps1")
expect(rendererScript).toContain("const backendScriptPath = process.argv[5];")
expect(rendererScript).toContain("const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath]",
)
expect(backendScript).toContain('& "C:/Program Files/nodejs/node.exe"')
expect(backendScript).toContain('codex.js" exec --json "inspect the vault door')
```

and for Claude:

```ts
expect(backendScript).toContain('& "C:/tools/claude.exe" -p "inspect the overseer terminal')
expect(backendScript).toContain('--output-format stream-json --verbose --include-partial-messages')
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: FAIL in the delegated Codex/Claude runtime tests because the runtime still generates args-json based renderer launch artifacts.

**Step 3: Keep only minimal failing coverage**

Ensure the updated assertions only cover the new launch boundary and do not add unrelated behavioral expectations.

**Step 4: Run test again to verify the same failures are stable**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: Same focused failures.

### Task 2: Change renderer launch inputs from backend command+args to backend script path

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Introduce the minimal new launch type**

Replace the structured backend launch shape with a backend-script-oriented shape.

Minimal target:

```ts
type WindowsPsmuxStructuredBackendLaunch = {
  scriptPath: string
}
```

or inline this responsibility if a separate type is no longer useful.

**Step 2: Write a helper that creates the backend PowerShell script**

Add a helper near the existing script-writing helpers that writes a backend script under `.omni-monitors`.

Suggested shape:

```ts
async function writeWindowsPsmuxDelegatedBackendScript(
  logDir: string,
  jobKey: string,
  content: string,
): Promise<string>
```

The helper should:

- create the directory
- write `<jobKey>.backend.ps1`
- return the normalized path

**Step 3: Build backend script content for Codex and Claude**

Implement a minimal builder that returns full script content, not an argv array.

Codex target:

```ts
& "<node>" "<codex.js>" exec --json "<prompt>"
```

Claude target:

```ts
& "<claude.exe>" -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
```

Use PowerShell-safe escaping for embedded double quotes in prompt text.

**Step 4: Generate backend script in delegated launch planning**

In `buildWindowsPsmuxLaunchPlan`, replace the args-json flow:

- remove backend args file generation for delegated stream-json jobs
- create the backend script instead
- pass the returned backend script path into the renderer command builder

**Step 5: Run focused tests**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: the updated delegated runtime tests move closer to green, with any remaining failures isolated to renderer expectations.

### Task 3: Update the renderer script to spawn PowerShell with `-File`

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Change renderer script argument parsing**

Update the embedded `DELEGATION_RENDERER_PROCESS_SCRIPT` so it accepts:

- `backend`
- `transcriptPath`
- `streamPath`
- `backendScriptPath`

instead of backend command plus args file.

Minimal target:

```js
const backendScriptPath = process.argv[5];
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-File', backendScriptPath], {
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

**Step 2: Remove obsolete args-file assumptions**

Delete the renderer logic that reads `process.argv[6]` and parses JSON args.

**Step 3: Update renderer command builder**

Change `buildWindowsPsmuxDelegatedRendererCommand(...)` so it passes the backend script path instead of backend command and args path.

**Step 4: Run focused tests**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: delegated Codex and Claude launch tests pass.

### Task 4: Remove obsolete args-file generation and keep artifacts coherent

**Files:**
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Remove unused args-file helper from the delegated path**

If `writeDelegationRendererArgsFile(...)` becomes unused after the renderer update, remove it and any dead call sites.

**Step 2: Ensure backend script naming is session-scoped**

Use the same naming discipline as other artifacts, for example:

```ts
`${monitorSessionId}-${jobId}.backend.ps1`
```

**Step 3: Verify the main job script still appends the exit marker**

Do not change `writeJobScript(...)` behavior beyond the delegated launch command string it wraps.

**Step 4: Run focused tests**

Run: `npm test -- test/windows-psmux.test.ts`

Expected: green for the targeted runtime test file.

### Task 5: Verify surrounding runtime coverage and build

**Files:**
- Test: `test/windows-psmux.test.ts`
- Test: `test/windows-psmux-dashboard.test.ts`
- Test: `test/completion-reporting.test.ts`
- Test: `test/delegation-tools.test.ts`

**Step 1: Run the most relevant runtime suite**

Run: `npm test -- test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/completion-reporting.test.ts test/delegation-tools.test.ts`

Expected: PASS

**Step 2: Run the build**

Run: `npm run build`

Expected: exit code 0

**Step 3: Review generated diff for scope control**

Run: `git diff -- src/runtime/windows-psmux.ts test/windows-psmux.test.ts test/windows-psmux-dashboard.test.ts test/completion-reporting.test.ts test/delegation-tools.test.ts docs/plans/2026-04-09-omni-opencode-windows-stream-launch-hardening-design.md docs/plans/2026-04-09-omni-opencode-windows-stream-launch-hardening.md`

Expected: diff limited to the launch-boundary hardening and related test updates.

### Task 6: Manual runtime smoke follow-up

**Files:**
- Use existing inspection scripts under `scripts/`

**Step 1: Rebuild fresh artifacts**

Run: `npm run build`

Expected: PASS

**Step 2: Run the existing inspection seed script**

Run: `node scripts/seed-windows-psmux-inspection.mjs`

Expected: a fresh inspection session is created.

**Step 3: Inspect generated monitor artifacts**

Verify that the new run produces:

- main job script `.ps1`
- backend script `.backend.ps1`
- transcript `.log`
- structured stream `.stream.jsonl`

**Step 4: Confirm dashboard status expectations manually**

Expected minimum outcome:

- Codex no longer fails with `spawn EFTYPE`
- Claude no longer shows a blank immediate-exit window caused by the old backend launch boundary
