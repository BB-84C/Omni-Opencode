# Authoritative Delegation Permission Source Design

## Goal

Patch the delegation plugin so delegated Codex and Claude Code permissions are derived from the active OpenCode invocation's authoritative effective tool-permission envelope, rather than from the weaker `context.permissions` snapshot alone.

## Problem

The current delegation flow reads permission decisions from tool-call context fields such as:

- `context.permissions`
- `context.agent`
- `context.directory`
- `context.worktree`

This is insufficient for the intended security model.

The mode name itself is not the authority. The authority is the actual effective tool permission configuration active for the current OpenCode invocation. If the plugin relies only on `context.permissions`, delegated permissions can drift from the active OpenCode agent/runtime permission envelope.

That creates two UX and correctness problems:

- delegation can proceed without reflecting the current effective OpenCode tool permissions for the turn
- a read-only or `ask`-gated OpenCode invocation can silently become a mismatched delegated permission envelope if the tool context is incomplete or stale

## Desired Behavior

- Delegated permissions must follow the current OpenCode invocation's effective tool permissions.
- The plugin must not infer authority from the mode name.
- The plugin must not treat `context.permissions` as the final authority.
- Existing delegated `allow-session` persistence should remain in plugin state and continue to work.
- If the plugin cannot read a trustworthy live effective permission envelope, delegation must fail closed.

## Chosen Approach

Introduce an explicit authoritative permission-resolution layer ahead of delegated capability derivation.

At launch time:

1. Resolve the current OpenCode invocation's authoritative effective permission envelope.
2. Normalize that into the existing delegated capability model.
3. Reuse existing session grants where all grant keys still match.
4. Prompt for unresolved `ask` capabilities in the parent OpenCode session.
5. Map the post-approval effective capabilities to Claude/Codex policy.
6. Launch the delegated job.

If step 1 fails, do not launch.

## Alternatives Considered

### 1. Continue using `context.permissions` as the source of truth

Rejected.

Pros:

- already implemented
- simple wiring

Cons:

- does not satisfy the intended authority boundary
- can drift from the effective current OpenCode permission state
- explains the exact mismatch concern raised during investigation

### 2. Fall back to `context.permissions` if the authoritative source is missing

Rejected.

Pros:

- avoids launch failures when stronger permission state is unavailable

Cons:

- reintroduces the same mismatch risk under a different name
- violates the requirement that delegated permissions follow the active OpenCode tool permissions, not a weaker snapshot

### 3. Fall back to read-only delegation if the authoritative source is missing

Rejected.

Pros:

- safer than trusting `context.permissions`

Cons:

- still derives delegated policy from plugin guesswork rather than real OpenCode authority
- would produce behavior the user did not ask for

## Authority Boundary

The source of truth must be the live effective OpenCode permission envelope for the current invocation.

This means:

- mode labels such as `Plan` or `Build` are not security inputs
- `context.permissions` is not the authority
- `context.agent` is useful for grant scoping only
- `context.directory` and `context.worktree` remain useful for runtime cwd and workspace-root identity, but not for permission decisions by themselves

The plugin should only derive delegated permissions after reading an authoritative permission source exposed by the current OpenCode runtime/session path.

## Resolution Flow

The delegated launch flow should be:

1. resolve the authoritative effective OpenCode permission envelope for the current invocation
2. normalize that envelope into the existing delegated capability model:
   - `workspaceWrite`
   - `shell`
   - `network`
   - `subagentLaunch`
   - `allowedRoots`
3. compute the current permission fingerprint from the normalized delegated capabilities
4. read persisted delegated session grants from plugin state
5. reuse only matching grants keyed by:
   - parent session
   - backend
   - active agent
   - permission fingerprint
   - capability
   - workspace root
6. if unresolved `ask` capabilities remain, prompt in the parent OpenCode session
7. persist `allow-session` choices into the plugin grant store immediately
8. build provider-specific Claude/Codex policy from the post-approval effective capability envelope
9. launch the delegated runtime

## Existing Behavior To Preserve

The patch should preserve these already-implemented behaviors:

- delegated `allow-session` grants are stored in plugin state, not model context
- grants are keyed by session, backend, agent, permission fingerprint, capability, and workspace root
- grants are reused from persistent storage, not inferred from conversation history
- grouped `ask` prompting in the parent session remains the user-facing approval mechanism

The patch is therefore a rewire of the permission authority layer, not a redesign of grant persistence.

## Handling `allow-session`

`Allow-session` remains plugin-owned persistence.

It must not rely on the parent context window or prior model memory.

Current intended semantics remain:

- `allow-once` applies only to the current launch
- `allow-session` is written immediately to the plugin grant store
- grants are reused only when all identity keys still match
- current authoritative OpenCode permissions still win over any stored grant

## Consistency Rules

If both of these are available:

- authoritative effective permission source
- `context.permissions`

and they disagree, the authoritative source wins.

The plugin may record this mismatch for diagnostics, but it must not use the weaker `context.permissions` snapshot to widen or narrow delegated authority.

## Failure Behavior

If the plugin cannot read a trustworthy live effective permission envelope, delegation must fail closed.

That means:

- no delegated runtime launch
- no provider process starts
- no grant writes occur
- a clear parent-session error is returned

Suggested user-facing message:

`Delegation blocked: unable to read the active OpenCode permission envelope for this turn, so delegated permissions cannot be derived safely.`

This failure path is expected to be rare if OpenCode reliably exposes effective permissions at tool invocation time. It exists to prevent silent permission drift, not as the normal path.

## Patch Scope

Keep these components conceptually intact:

- delegated capability model
- delegated session grant store
- grouped `ask` prompt flow
- Claude/Codex capability mapping

Patch only these areas:

1. permission authority resolution
2. launch-context shape so authoritative permissions flow into the existing capability model
3. fail-closed behavior when authority cannot be proven
4. optional mismatch diagnostics between authoritative and raw context permissions

## Testing Strategy

Add or update tests for:

- authoritative source available with read-only permissions -> delegated read-only launch, no prompt
- authoritative source available with edit/bash allowed -> delegated write/shell launch
- authoritative source available with `ask` -> existing grouped approval flow still works
- authoritative source unavailable -> delegation is refused and no runtime launch occurs
- authoritative source and `context.permissions` disagree -> authoritative source wins
- existing grant persistence and reuse remain unchanged

## Non-Goals

- using mode names like `Plan` or `Build` as security inputs
- falling back to `context.permissions` when the authoritative source is unavailable
- falling back to guessed read-only delegation when authority cannot be proven
- redesigning the existing delegated grant persistence model
