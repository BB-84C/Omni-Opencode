# Delegated Permission Sync Design

## Goal

Replace the plugin's regex-based `safe` / `dangerous` delegated permission classifier with a model derived from the active OpenCode agent's real permission and tool configuration, then map that model onto Codex and Claude Code in a provider-enforced way.

## Problem

The current plugin uses prompt heuristics to decide whether a delegated launch is `safe` or `dangerous`.

That has several problems:

- it does not reflect the actual OpenCode permission model
- it ignores the active OpenCode agent identity and permission envelope
- it cannot represent capability-specific decisions like read-only plus shell denied
- it collapses OpenCode `ask` into a coarse launch-time prompt without reference to the current agent's true permissions

The desired behavior is:

- delegated permission should derive from the active OpenCode agent's real permissions
- OpenCode remains the source of truth
- delegated providers should receive provider-enforced restrictions whenever possible
- OpenCode `ask` should be resolved at delegated launch time in the parent session
- `allow for session` should be remembered by the plugin, but only for the same parent session, same active agent, and same resolved permission envelope

## Chosen Approach

Use a backend-neutral delegated capability model derived from OpenCode's current agent permissions.

- At delegated launch time, read the active OpenCode agent identity and its resolved permission/tool state.
- Reduce that state to a small delegated capability envelope.
- For each delegated capability:
  - `allow` means launch with that capability enabled
  - `deny` means launch with that capability disabled
  - `ask` means prompt in the parent OpenCode session before launch
- If the user chooses `allow for session`, store the grant in plugin state.
- Reuse a stored session grant only when the current parent session, active agent, and relevant permission envelope still match.

This explicitly treats OpenCode `ask` as a launch-time approval envelope for external delegated runs, rather than trying to proxy provider prompts back into OpenCode mid-loop.

## Alternatives Considered

### 1. Launch-time approval envelope with plugin-owned session grants

Selected.

Pros:

- keeps OpenCode as the approval authority
- works consistently across Codex and Claude Code
- avoids trying to bridge provider-native mid-loop prompts into the OpenCode TUI
- preserves session-scoped approval memory without relying on model context

Cons:

- loses true mid-loop OpenCode `ask` granularity
- may approve a broader capability than a delegated run ends up using

### 2. Let providers prompt inside their own monitor windows

Pros:

- closer to each provider's native runtime approval model

Cons:

- splits authority between OpenCode and delegated providers
- breaks the requirement that OpenCode agent permissions drive delegation
- creates a confusing dual approval UX

### 3. Treat all OpenCode `ask` capabilities as denied for delegation

Pros:

- simplest and safest

Cons:

- too restrictive for normal delegated work
- adds unnecessary friction compared with OpenCode's own interactive approval model

### 4. Stop and relaunch delegation whenever new capability elevation is needed

Pros:

- preserves least privilege better than broad pre-approval

Cons:

- more orchestration complexity
- worse user experience than a single launch-time approval step

## Design

### Source of truth

The source of truth is the current OpenCode parent session state, not the delegated backend.

At delegated launch time the plugin should resolve:

- active parent session id
- active OpenCode agent identity
- resolved OpenCode permission configuration relevant to delegation
- workspace root and any allowed extra directories relevant to file access

The plugin should not infer permission from prompt wording once this system is in place.

### Delegated capability model

Reduce OpenCode permission/tool state to a backend-neutral envelope such as:

```ts
type DelegatedCapabilityDecision = "allow" | "ask" | "deny"

type DelegationCapabilities = {
  workspaceWrite: DelegatedCapabilityDecision
  shell: DelegatedCapabilityDecision
  network: DelegatedCapabilityDecision
  subagentLaunch: DelegatedCapabilityDecision
  allowedRoots: string[]
}
```

Initial mapping from OpenCode should be conservative:

- OpenCode `edit` -> `workspaceWrite`
- OpenCode `bash` -> `shell`
- OpenCode `webfetch` and equivalent network tools -> `network`
- OpenCode `task` -> `subagentLaunch`
- OpenCode `external_directory` -> `allowedRoots`

This model is intentionally smaller than the full OpenCode permission system so both Codex and Claude Code can consume it.

### Handling OpenCode `ask`

For delegation, OpenCode `ask` becomes a launch-time approval step in the parent OpenCode session.

The plugin should:

1. derive the current capability envelope
2. collect the capabilities whose decision is `ask`
3. check whether matching session grants already exist
4. if not, prompt the user before the delegated launch starts

The delegated job should not start until this approval step is complete.

This means delegated jobs do not receive live mid-loop OpenCode approval prompts. Instead, they receive a launch-time approval envelope that OpenCode has already approved.

### Approval prompt shape

Prompt once per launch, grouping all unresolved `ask` capabilities into a single parent-session approval dialog.

Example wording:

- `This delegated job may require file edits and shell commands.`
- `Allow once`
- `Allow for this session`
- `Deny`

The prompt should describe capabilities, not backend-specific flags.

If only one capability is unresolved, the prompt should still use the same structure but name the single capability precisely.

### Remembering `allow for session`

Session grants must be stored by the plugin, not in model context and not only in process memory.

Recommended stored shape:

```ts
type DelegationSessionGrant = {
  parentSessionId: string
  agentKey: string
  permissionEnvelopeFingerprint: string
  capability: "workspaceWrite" | "shell" | "network" | "subagentLaunch"
  scope: "session"
  workspaceRoot: string
  grantedAt: number
}
```

#### Reuse rule

Reuse a stored `allow for session` grant only when all of these still match:

- same parent OpenCode session
- same active OpenCode agent identity
- same delegation-relevant permission envelope fingerprint
- same capability
- same workspace root

If any of these differ, ask again.

This intentionally prevents grants from leaking:

- between different active agents in the same session
- across agent reconfiguration within the same session
- across different workspaces or path scopes

#### Current permission always wins

Stored grants must never override the current OpenCode permission state.

That means:

- current `deny` always stays denied
- current `allow` needs no stored grant
- current `ask` may be satisfied by a matching stored session grant

Effective permission is therefore:

`current OpenCode decision intersect stored delegated session grant`

### Agent identity binding

`Allow for session` grants are bound to the current active OpenCode agent.

Recommended identity rule:

- use the active agent identity plus the resolved permission envelope

This gives the desired behavior:

- same session, same agent, same permissions -> reuse allowed
- same session, different agent -> ask again
- same session, same agent name, changed permissions -> ask again

### Provider mapping

#### Claude Code

Claude maps well to OpenCode's tool-centric model.

Use:

- `allowedTools`
- `disallowedTools`
- `permissionMode`

Initial mapping:

- base read-only: `Read`, `Glob`, `Grep`
- `workspaceWrite=allow` -> add write tools such as `Edit`, `Write`, `FileMultiEdit`, `NotebookEdit`
- `shell=allow` -> add `Bash`, `BashOutput`, `KillShell`
- `network=deny` -> disallow `WebFetch`, `WebSearch`

For the initial delegated model, the plugin should remain the approval authority, so Claude should run with provider prompts disabled and tool access constrained by allowlists.

#### Codex

Codex maps better through sandbox and approval policy than through a direct tool allowlist.

Use:

- sandbox mode: `read-only` or `workspace-write`
- writable roots for the workspace
- network access on or off within workspace-write
- approval policy consistent with plugin-owned approval handling

Initial mapping:

- `workspaceWrite=deny` -> `read-only`
- `workspaceWrite=allow` -> `workspace-write`
- `allowedRoots` -> writable roots
- `network=deny` -> sandbox network disabled

Codex currently needs more plumbing because the Windows `psmux` launch path hardcodes `codex exec --json <prompt>` and does not yet pass through the needed permission flags/config overrides.

### Runtime behavior

At launch:

1. resolve active OpenCode agent and permissions
2. build delegated capability envelope
3. apply matching stored session grants where valid
4. if unresolved `ask` capabilities remain, prompt the user in the parent OpenCode session
5. persist any new `allow for session` grants
6. launch delegated backend with mapped provider-enforced settings

This preserves a single approval authority and keeps delegated runs deterministic.

## Testing Strategy

Add tests for:

- capability-envelope derivation from mocked OpenCode agent/permission state
- grouped launch-time prompt for unresolved `ask` capabilities
- `allow once` applying only to the current delegated launch
- `allow for session` stored and reused only when session, agent, permission fingerprint, capability, and workspace all match
- grants rejected when the active agent changes
- grants rejected when the permission envelope changes
- current OpenCode `deny` overriding any stored grant
- Claude launch args/options reflecting mapped tool restrictions
- Codex launch args/config reflecting mapped sandbox and approval settings

## Risks

- OpenCode may not expose every needed piece of resolved permission state in a single convenient API
- current delegated runtime paths, especially Codex on Windows `psmux`, need plumbing changes before the mapping can be fully enforced
- grouping `ask` capabilities into one prompt trades correctness of authority for less granular runtime behavior

## Non-Goals

- recreating OpenCode's full mid-loop interactive approval semantics inside delegated providers
- using prompt text as a security boundary
- sharing grants across different active agents in the same parent session
- making Codex and Claude permissions look identical when their native control models differ
