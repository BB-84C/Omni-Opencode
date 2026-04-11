# Omni-Opencode Interactive CLI Correlation Design

**Date:** 2026-04-09

## Goal

Restore real interactive Codex and Claude CLI panes inside the shared Windows `psmux` session while still letting the plugin deterministically correlate each delegated pane with the correct parent OpenCode session and delegated job record.

## Approved Direction

Use real interactive backend CLIs in job windows and add explicit correlation metadata so each delegated pane can be mapped back to its owning parent OpenCode session.

This replaces the temporary `exec` / `print` / shell-wrapper approach for the long-term job-window model.

## Product Model

Per parent OpenCode session:

- one shared `psmux` session
- window `0` = dashboard + shell
- windows `1..N` = real interactive backend CLI panes

The dashboard remains session-local and shows only jobs for its own parent OpenCode session.

## Core Requirements

Each delegated job window must:

- host a real interactive `codex` or `claude` CLI session
- not rely on `codex exec`, `claude --print`, or a shell-script proxy as the primary pane experience
- be recoverable and inspectable later through stored session metadata

Each delegated job record must store enough information to answer two questions reliably:

1. Which parent OpenCode session owns this backend session?
2. Which backend session should be reopened or resumed for this delegated job?

## Correlation Strategy

### Shared Correlation Metadata

For every delegated job, store:

- parent OpenCode session id
- parent OpenCode message id
- runtime job id
- backend (`codex` or `claude-code`)
- `psmux` window index
- first-prompt correlation marker
- prompt fingerprint or exact first-prompt text as needed
- discovered backend session id once available

The first-prompt correlation marker must be unique per delegated job and stable enough to locate the correct backend session even when multiple parent OpenCode sessions delegate nearly simultaneously.

### Claude

Claude appears to support direct session control through flags such as:

- `--session-id <uuid>`
- `--resume [value]`

Approved direction:

- launch real interactive `claude`
- seed it with the delegated first prompt plus the unique correlation marker
- discover/store the backend session id from Claude-supported session mechanisms or persisted state
- use the stored session id for reopen/resume behavior

### Codex

Codex exposes interactive resume behavior through:

- `codex resume [SESSION_ID]`
- `codex resume --last`

Codex local persisted state already provides useful correlation evidence:

- `C:\Users\Administrator\.codex\history.jsonl` contains `session_id`, `ts`, and `text`

Approved direction:

- launch real interactive `codex`
- send a first prompt containing the delegated prompt plus a unique correlation marker
- discover the created Codex `session_id` by matching that marker in `history.jsonl`
- store the discovered session id on the delegated job record
- later reopen via `codex resume <session_id>` rather than heuristics like `--last`

## Concurrency Safety

The design must not assume “most recent backend session belongs to this OpenCode session.”

That is explicitly unsafe when:

- two parent OpenCode sessions delegate Codex almost simultaneously
- multiple jobs are launched in quick succession
- the user manually opens backend CLIs outside the plugin

The correlation marker plus discovered backend session id is the required safety boundary.

## Launch Model

The runtime should prefer launching the real interactive backend CLI in the pane.

If a tiny bootstrap step is still required to deliver the first prompt safely, that bootstrap must be treated as a transport detail, not as the pane’s long-term UI. The visible and durable pane experience must still become the real backend CLI session.

## Persistence Model

The plugin/broker should persist backend-session correlation metadata alongside the delegated job record so that:

- `delegated_job_snapshot` can show the backend session identity
- future resume/reattach logic can reopen the same interactive session
- restart recovery can reconcile the parent job record with the backend session

## Verification Standard

Do not treat this work as complete until a live session proves:

1. delegation creates a shared multi-window `psmux` session automatically
2. window `0` is the dashboard
3. window `1..N` host real interactive Codex/Claude CLI panes
4. the delegated job record stores the discovered backend session id
5. simultaneous or near-simultaneous delegations can still be correlated to the correct parent OpenCode session
6. reopen/resume behavior uses stored backend session identity rather than “latest session” heuristics

## Files Expected To Change

- `src/plugin.ts`
- `src/runtime/types.ts`
- `src/runtime/windows-psmux.ts`
- new helper files if needed for Codex/Claude session discovery
- tests covering plugin command construction, runtime launch, and session correlation

## Notes

This design builds on the already-completed Windows `psmux` dashboard/session work and specifically targets the remaining gap: replacing proxy-like delegated job windows with real interactive backend sessions plus deterministic correlation.
