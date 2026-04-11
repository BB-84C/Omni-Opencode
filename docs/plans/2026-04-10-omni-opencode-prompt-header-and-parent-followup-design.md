# Prompt Header And Parent Follow-Up Design

## Goal

Improve delegated job usability in two ways:

1. Show the original full launch prompt at the top of each agent window transcript, separated from agent output by a clear divider.
2. Inject a concise user-facing follow-up back into the parent OpenCode session once all jobs in a batch have reached terminal state.

## Problem

The current delegated windows start directly with provider output, which makes it harder to remember what prompt produced the transcript. Separately, the plugin already sends an aggregate follow-up when a batch finishes, but the desired behavior is more specific:

- the follow-up should happen once there are no running jobs left in the batch, regardless of whether individual jobs completed, failed, or were cancelled
- the follow-up should not dump whole agent reports into the OpenCode TUI
- instead it should point the parent session to the right inspection tools and transcript lookup commands

## Chosen Approach

Use a transcript header plus a concise parent-session user message.

- Every delegated transcript begins with a prompt header block.
- The prompt header contains the exact full prompt verbatim.
- The header is separated from agent output by a long divider line:

`------------------------------`

- Batch completion injection remains in the plugin layer using the existing parent-session reporting API.
- The injected message stays short and points to where the user can inspect final reports and full transcripts.

## Alternatives Considered

### 1. Transcript header plus concise parent follow-up

Selected.

Pros:

- best usability inside individual job windows
- keeps OpenCode TUI uncluttered
- reuses the existing injection mechanism cleanly

Cons:

- slightly more transcript boilerplate at the top of every job window

### 2. Parent follow-up only

Pros:

- smaller implementation

Cons:

- misses the prompt-context problem inside the live job windows

### 3. Rich injected summaries with full reports inline

Pros:

- more information in the parent session immediately

Cons:

- too noisy for OpenCode TUI
- explicitly against the desired behavior

## Design

### Transcript header

Each delegated runtime transcript should start with a fixed preamble before any provider output is written.

Shape:

```text
[omni-opencode] prompt
<full prompt text>
------------------------------
```

Requirements:

- full prompt verbatim, no truncation
- separator always present
- written exactly once per job transcript
- must appear before any provider progress, tool activity, or final answer text

This should apply to both live Windows job windows and captured transcript files.

### Parent-session injected follow-up

When the batch has no more running jobs, inject a concise `user` message back into the parent OpenCode session.

The current plugin already has the right mechanism:

- `message.create(...)`
- fallback `session.promptAsync(...)`

The new content should remain short and actionable.

Suggested structure:

- batch finished header
- one line per job with backend and final status
- inspection references only, such as:
  - `delegated_job_snapshot({"jobId":"..."})`
  - `delegated_job_read({"jobId":"..."})`
  - `delegated_job_attach({"jobId":"..."})`

Do not inline the full agent report body.

### Completion trigger

The follow-up should be sent once every job in the batch is no longer `running`.

That means the batch is eligible when all jobs are terminal, including:

- `completed`
- `failed`
- `cancelled`

The trigger should not require all jobs to succeed.

### Report wording

The message should clearly tell the parent session:

- where to inspect the final summary
- where to read the full transcript incrementally
- how to reattach or inspect the delegated monitor session if needed

But it should avoid pasting the full report into the injected message.

## Testing Strategy

Add tests for:

- transcript header written once and before provider output
- full verbatim prompt preserved in transcript files
- long separator line rendered exactly as chosen
- parent follow-up sent when all jobs are terminal, including failed/cancelled mixes
- injected message contains inspection references but not full report body

## Risks

- prompt header must not be duplicated when transcripts are resumed or appended incrementally
- parent follow-up should not be sent early if one job is still running
- concise follow-up formatting should remain readable in OpenCode’s TUI

## Non-Goals

- changing backend launch/runtime architecture
- injecting whole reports into the parent session
- truncating or rewriting the original prompt text
