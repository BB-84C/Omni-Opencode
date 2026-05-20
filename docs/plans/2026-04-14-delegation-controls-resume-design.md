# Delegation Controls And Resume Design

Date: 2026-04-14

## Summary

Add first-class delegation controls for `model` and `reasoningEffort`, expose a released `delegated_job_resume` tool, and extend plugin bookkeeping and parent-facing reporting so every delegated run records and reports what model and reasoning effort were requested and what was effectively used.

## Goals

- Extend `delegate_to_claude` and `delegate_to_codex` with optional `model` and `reasoningEffort` fields.
- Expose `delegated_job_resume(jobId, prompt?, model?, reasoningEffort?)` in the released plugin tool surface.
- Keep resume strict: continue the original backend thread when possible, otherwise fail clearly.
- Allow resume to inject an additional prompt/instruction.
- Store requested and effective model/effort values in plugin bookkeeping.
- Require tool results and aggregate parent follow-ups to always report model and reasoning effort.

## Non-Goals

- No restart or relaunch behavior for already finished jobs in this scope.
- No plugin-owned hardcoded allowlist of backend model names.
- No silent fallback from resume into a fresh launch.

## Chosen API Shape

### Launch tools

- `delegate_to_claude(prompt, model?, reasoningEffort?)`
- `delegate_to_codex(prompt, model?, reasoningEffort?)`

`prompt` remains required. `model` and `reasoningEffort` are optional explicit top-level fields rather than a generic nested options object.

### Resume tool

- `delegated_job_resume(jobId, prompt?, model?, reasoningEffort?)`

Behavior:

- Only resumes an existing delegated backend session/thread.
- If the job has no usable stored backend resume identity, return an error.
- If `prompt` is provided, treat it as a continuation instruction for the resumed thread.
- If `model` or `reasoningEffort` are omitted, reuse the stored values from the source job.
- If `model` or `reasoningEffort` are provided, treat them as explicit overrides for the resumed run.

## Bookkeeping Model

Extend delegated job records to store both requested and effective control values.

Proposed fields:

- `requestedModel?: string`
- `requestedReasoningEffort?: string`
- `effectiveModel?: string`
- `effectiveReasoningEffort?: string`
- `resumedFromJobId?: string`
- `rootJobId?: string`

Semantics:

- Requested values capture what the parent agent asked for.
- Effective values capture what the backend actually used when that is known.
- If no explicit value was requested, requested fields remain empty.
- If the backend only exposes that defaults were used but not the concrete value, effective fields should report `default` rather than inventing a specific model or effort.

## Resume Lifecycle

Resume should create a new delegated plugin-side job record instead of mutating the old record in place.

Rationale:

- Preserves audit history for the source job.
- Keeps terminal source records immutable.
- Allows repeated resume attempts with separate lifecycle tracking.
- Keeps aggregate batch completion semantics clean.

Resume flow:

1. Load source job.
2. Validate source job is not currently running.
3. Validate backend resume identity exists.
4. Build continuation instruction from stored checkpoint/session state plus optional injected prompt.
5. Start a new runtime job that continues the original backend thread.
6. Persist a new delegated job record linked by `resumedFromJobId` and `rootJobId`.
7. Track completion, follow-up injection, and snapshots against the new resumed job.

## Parent-Facing Reporting

The following outputs must always include model and reasoning effort reporting:

- launch result payloads
- `delegated_job_snapshot`
- aggregate follow-up injection to the parent session

Parent-facing aggregate lines should stay concise but include model and effort, for example:

`- <jobId> [codex] completed | model=gpt-5-codex | reasoningEffort=medium | snapshot: ...`

If values are defaulted or unknown, report them truthfully, for example:

- `model=<default>`
- `reasoningEffort=<default>`

## Validation And Failure Rules

- `model` and `reasoningEffort` remain optional strings.
- The plugin performs only lightweight validation on presence/type/emptiness.
- The plugin should not attempt to maintain a fragile global allowlist of backend models.
- If a resume attempt cannot honor the requested continuation semantics, fail clearly.
- A failed resume must leave the source record unchanged and must not create a half-valid running record.

## Backend Handling

- Pass requested values through where the backend supports them.
- Record effective values from backend output, metadata, or known invocation shape when possible.
- Do not silently drop unsupported requested controls during strict resume.

## Batch Semantics

- A resumed run belongs to a new batch tied to the resume tool invocation.
- The original batch remains closed.
- Completion reporting for resumed jobs should inject a follow-up for the new resume batch only.

## Testing Scope

Add coverage for:

- launch with explicit model/effort
- launch with default model/effort
- persistence of requested/effective fields
- launch result payloads include model/effort
- aggregate follow-up includes model/effort
- strict resume failure when backend resume identity is missing
- resume with injected prompt
- resume with stored model/effort reuse
- resume with explicit model/effort override
- resumed job creates a new linked record
- resumed job gets a new batch and new aggregate follow-up

## Documentation Updates

Update README and tool descriptions to document:

- new `model` and `reasoningEffort` fields
- strict resume behavior
- requested versus effective model/effort semantics
- resumed-job lineage fields

## Recommendation

Implement explicit first-class fields rather than a generic options object. This keeps the plugin contract stable, makes reporting uniform, and best matches the requirement that OpenCode always state what model and reasoning effort were used.
