# Delegated Permission Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace regex-based delegated permission classification with a launch-time permission envelope derived from the active OpenCode agent, then map that envelope onto Claude Code and Codex with provider-enforced restrictions and plugin-owned session grant memory.

**Architecture:** Add a backend-neutral delegated capability model in the plugin layer, derive it from the active OpenCode agent plus resolved OpenCode permission state, resolve any `ask` capabilities before launch using a grouped parent-session prompt, persist `allow for session` grants bound to parent session plus active agent plus permission fingerprint, then translate the resulting envelope into Claude allowlists and Codex sandbox settings. Keep the initial implementation launch-time only; do not attempt to recreate OpenCode's mid-loop approval UX inside delegated providers.

**Tech Stack:** TypeScript, Node.js, OpenCode plugin APIs, Vitest, Windows `psmux`

---

### Task 1: Add RED tests for delegated capability derivation

**Files:**
- Create: `test/delegation-permissions.test.ts`
- Modify: `src/core/session-approval-state.ts`
- Modify: `src/core/jobs.ts`

**Step 1: Write failing tests for capability-envelope derivation**

Add tests for a new helper that converts resolved OpenCode permission/tool state into:

```ts
{
  workspaceWrite: "allow" | "ask" | "deny",
  shell: "allow" | "ask" | "deny",
  network: "allow" | "ask" | "deny",
  subagentLaunch: "allow" | "ask" | "deny",
  allowedRoots: string[],
}
```

Required cases:

- `edit=allow` -> `workspaceWrite=allow`
- `edit=ask` -> `workspaceWrite=ask`
- `edit=deny` -> `workspaceWrite=deny`
- `bash` maps to `shell`
- `webfetch` maps to `network`
- `task` maps to `subagentLaunch`
- `external_directory` contributes allowed roots

**Step 2: Add a failing test for permission-envelope fingerprint stability**

The fingerprint should stay the same for semantically equivalent inputs and change when any delegation-relevant permission changes.

**Step 3: Run the new focused test file**

Run: `npm test -- test/delegation-permissions.test.ts`

Expected: FAIL because the capability model and fingerprint helpers do not exist yet.

### Task 2: Implement the delegated capability model and fingerprint helpers

**Files:**
- Create: `src/core/delegation-permissions.ts`
- Modify: `src/core/jobs.ts`
- Test: `test/delegation-permissions.test.ts`

**Step 1: Add minimal shared types**

Define:

- `DelegatedCapabilityDecision`
- `DelegationCapabilities`
- any minimal OpenCode-permission input shape needed for tests and plugin integration

Keep the types backend-neutral.

**Step 2: Implement capability derivation**

Add a pure helper that accepts resolved OpenCode permission/tool state and returns `DelegationCapabilities`.

Do not read plugin context inside this helper.

**Step 3: Implement permission-envelope fingerprinting**

Fingerprint only the fields relevant to delegated capability decisions and allowed roots.

**Step 4: Run the focused tests**

Run: `npm test -- test/delegation-permissions.test.ts`

Expected: PASS

### Task 3: Add RED tests for plugin-owned session grant memory

**Files:**
- Modify: `test/delegation-permissions.test.ts`
- Modify: `src/core/session-approval-state.ts`

**Step 1: Write failing tests for stored delegated grants**

Add tests covering a persisted session grant record with these fields:

- `parentSessionId`
- `agentKey`
- `permissionEnvelopeFingerprint`
- `capability`
- `workspaceRoot`
- `scope`

Required behaviors:

- grant matches when all fields match
- grant does not match if agent changes
- grant does not match if fingerprint changes
- grant does not match if workspace root changes

**Step 2: Add a failing test that current `deny` beats stored grant**

Even with a matching stored grant, if current OpenCode capability is `deny`, effective delegated capability must remain denied.

**Step 3: Run focused tests to confirm RED**

Run: `npm test -- test/delegation-permissions.test.ts`

Expected: FAIL because the current approval store only handles `safe` / `dangerous` profiles.

### Task 4: Replace coarse session-approval storage with capability-scoped grants

**Files:**
- Modify: `src/core/session-approval-state.ts`
- Modify: `src/core/jobs.ts`
- Test: `test/delegation-permissions.test.ts`

**Step 1: Add a new stored grant shape**

Introduce a delegated session grant record keyed by parent session, agent key, permission fingerprint, capability, and workspace root.

Keep file format simple JSON and backward-compatible only if needed for current tests.

**Step 2: Implement match helpers**

Add helpers such as:

- `saveDelegationGrant(...)`
- `getMatchingDelegationGrant(...)`

Keep them pure and explicit about matching rules.

**Step 3: Remove dependency on `safe` / `dangerous` permission profiles inside the new path**

Do not delete old logic yet if other tests still need it, but route new delegated launch logic toward capability grants instead.

**Step 4: Run focused tests**

Run: `npm test -- test/delegation-permissions.test.ts`

Expected: PASS

### Task 5: Add RED tests for parent-session grouped approval prompts

**Files:**
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/delegation-permissions.test.ts`
- Modify: `src/plugin.ts`

**Step 1: Write failing plugin tests for grouped `ask` resolution**

Add tests requiring the plugin to:

- prompt once per delegated launch when unresolved `ask` capabilities remain
- name the capabilities in the prompt body
- support `allow-once`, `allow-session`, and `deny`
- skip prompting when matching session grants already exist

Example expected prompt text:

```text
This delegated job may require file edits and shell commands.
```

**Step 2: Add a failing test for same-session same-agent reuse**

Launch twice with identical agent key and permission fingerprint; the second launch should not prompt again after `allow-session`.

**Step 3: Add failing tests for changed-agent and changed-fingerprint re-prompting**

Second launch should prompt again when:

- the active agent changes
- the permission fingerprint changes

**Step 4: Run the focused plugin tests**

Run: `npm test -- test/delegation-tools.test.ts test/delegation-permissions.test.ts`

Expected: FAIL because launch-time grouped capability approval does not exist yet.

### Task 6: Implement launch-time `ask` resolution in the plugin

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/core/delegation-permissions.ts`
- Modify: `src/core/session-approval-state.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/delegation-permissions.test.ts`

**Step 1: Read current OpenCode agent identity and resolved permission state at launch**

Add a focused helper in `src/plugin.ts` to gather the current delegated-permission input from the OpenCode session context and any available config/agent APIs.

Keep this helper isolated so it can be mocked in tests.

**Step 2: Build the current capability envelope**

Call the new pure capability helper and compute:

- `agentKey`
- `permissionEnvelopeFingerprint`
- unresolved `ask` capabilities

**Step 3: Apply matching session grants**

For each `ask` capability, reuse only a matching session grant.

**Step 4: Prompt once if unresolved `ask` capabilities remain**

Use the existing `context.ask(...)` path but change it to a grouped delegated capability approval prompt.

**Step 5: Persist `allow-session` grants**

Save one grant per approved capability using the new grant keying model.

**Step 6: Preserve current `deny` behavior**

If the user denies the grouped prompt, abort the delegated launch.

**Step 7: Run focused tests**

Run: `npm test -- test/delegation-tools.test.ts test/delegation-permissions.test.ts`

Expected: PASS

### Task 7: Add RED tests for Claude permission mapping

**Files:**
- Modify: `test/claude-adapter.test.ts`
- Modify: `test/windows-psmux.test.ts`
- Modify: `src/adapters/policy-mappers.ts`
- Modify: `src/runtime/windows-psmux.ts`

**Step 1: Write failing tests for Claude tool mapping**

Require a helper to map `DelegationCapabilities` into Claude settings such as:

- `allowedTools`
- `disallowedTools`
- `permissionMode`

Required cases:

- read-only -> `Read`, `Glob`, `Grep`
- write allowed -> add write tools
- shell allowed -> add bash tools
- network denied -> disallow `WebFetch`, `WebSearch`

**Step 2: Add a failing Windows launch test**

Require the Windows Claude backend command generator to include the mapped `--allowedTools` and permission-mode flags.

**Step 3: Run focused tests to confirm RED**

Run: `npm test -- test/claude-adapter.test.ts test/windows-psmux.test.ts`

Expected: FAIL because the current Claude launch path ignores permission mapping.

### Task 8: Implement Claude mapping in SDK and Windows CLI paths

**Files:**
- Modify: `src/adapters/policy-mappers.ts`
- Modify: `src/adapters/claude-client.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/claude-adapter.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Expand the Claude mapping helper minimally**

Return both `allowedTools` and `disallowedTools` from the capability envelope.

**Step 2: Wire the SDK client path**

Pass mapped values into `sdk.query(...)` using:

- `allowedTools`
- `disallowedTools`
- `permissionMode`

Use plugin-owned approval as the authority, so disable provider prompting in this path.

**Step 3: Wire the Windows CLI path**

Extend the generated Claude command to include:

- `--allowedTools ...`
- any needed permission-mode flag

Keep the current stream-json transcript behavior intact.

**Step 4: Run focused tests**

Run: `npm test -- test/claude-adapter.test.ts test/windows-psmux.test.ts`

Expected: PASS

### Task 9: Add RED tests for Codex sandbox and approval mapping

**Files:**
- Modify: `test/codex-adapter.test.ts`
- Modify: `test/windows-psmux.test.ts`
- Modify: `src/adapters/policy-mappers.ts`
- Modify: `src/runtime/windows-psmux.ts`

**Step 1: Write failing tests for Codex mapping**

Require a helper to map `DelegationCapabilities` into Codex settings such as:

- sandbox mode
- writable roots
- network access
- approval policy

Required cases:

- write denied -> `read-only`
- write allowed -> `workspace-write`
- network denied -> workspace-write network disabled
- workspace root forwarded as writable root

**Step 2: Add a failing Windows launch test for Codex config plumbing**

Require the generated backend script to include mapped sandbox/config settings instead of only:

```text
codex exec --json "<prompt>"
```

**Step 3: Run focused tests**

Run: `npm test -- test/codex-adapter.test.ts test/windows-psmux.test.ts`

Expected: FAIL because the current Codex Windows path hardcodes `exec --json` without permission config.

### Task 10: Implement Codex mapping and launch-argument plumbing

**Files:**
- Modify: `src/adapters/policy-mappers.ts`
- Modify: `src/adapters/codex-client.ts`
- Modify: `src/runtime/windows-psmux.ts`
- Test: `test/codex-adapter.test.ts`
- Test: `test/windows-psmux.test.ts`

**Step 1: Expand Codex mapping helper minimally**

Return the mapped sandbox mode, writable roots, network setting, and approval policy from the capability envelope.

**Step 2: Wire the app-server path**

Where the old app-server path is still used, pass the mapped approval policy and sandbox policy instead of relying on a hardcoded `approvalPolicy: "never"`.

**Step 3: Wire the Windows CLI path**

Extend the generated Codex backend command or config override path so the mapped sandbox and approval settings survive the `psmux` launch.

Do not rely on prompt wording for enforcement.

**Step 4: Run focused tests**

Run: `npm test -- test/codex-adapter.test.ts test/windows-psmux.test.ts`

Expected: PASS

### Task 11: Add regression tests for end-to-end grant reuse rules

**Files:**
- Modify: `test/delegation-tools.test.ts`
- Modify: `test/completion-reporting.test.ts` if needed

**Step 1: Add one end-to-end-style plugin test**

Cover this sequence:

1. launch delegation under agent A with `workspaceWrite=ask`
2. choose `allow-session`
3. relaunch under agent A with same fingerprint -> no prompt
4. relaunch under agent B or changed fingerprint -> prompt again

**Step 2: Add one negative test for stored grants with current deny**

If the current capability changes from `ask` to `deny`, the plugin must refuse launch or map the capability to denied even when a matching stored grant exists.

**Step 3: Run focused plugin regression tests**

Run: `npm test -- test/delegation-tools.test.ts`

Expected: PASS

### Task 12: Run full verification and build

**Files:**
- Test: `test/delegation-permissions.test.ts`
- Test: `test/delegation-tools.test.ts`
- Test: `test/claude-adapter.test.ts`
- Test: `test/codex-adapter.test.ts`
- Test: `test/windows-psmux.test.ts`
- Test: any additional plugin/runtime tests touched during implementation

**Step 1: Run the full relevant suite**

Run: `npm test -- test/delegation-permissions.test.ts test/delegation-tools.test.ts test/claude-adapter.test.ts test/codex-adapter.test.ts test/windows-psmux.test.ts`

Expected: PASS

**Step 2: Run the broader suite if focused tests pass**

Run: `npm test`

Expected: PASS

**Step 3: Run the build**

Run: `npm run build`

Expected: PASS

**Step 4: Manual delegated smoke check**

Manually confirm:

- same-agent same-fingerprint `allow-session` reuse skips the prompt
- changing the active agent forces a new prompt
- changing the permission envelope forces a new prompt
- Claude launches with the intended restricted tool surface
- Codex launches with the intended sandbox/config restrictions

**Step 5: Commit**

```bash
git add src/core/delegation-permissions.ts src/core/session-approval-state.ts src/plugin.ts src/adapters/policy-mappers.ts src/adapters/claude-client.ts src/adapters/codex-client.ts src/runtime/windows-psmux.ts test/delegation-permissions.test.ts test/delegation-tools.test.ts test/claude-adapter.test.ts test/codex-adapter.test.ts test/windows-psmux.test.ts
git commit -m "feat: sync delegated permissions with active opencode agent"
```
