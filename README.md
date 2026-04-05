# Omni-Opencode

Plugin-driven OpenCode integration for delegated external subagents backed by Codex and Claude Code.

## PTY Runtime Model

The primary delegation path no longer depends on wrapper-bridge subagents or same-session event projection.

- Parent-facing tools (`delegate_to_claude`, `delegate_to_codex`) launch the external runtime directly from the parent session.
- Runtime output is monitored through the selected PTY backend: Windows PTY on Windows, `tmux` where available.
- Completion updates are written back to the parent session through `client.message.create` after the PTY monitor detects final runtime state.
- Detailed output stays in the runtime monitor/log path and remains inspectable through delegated job tools (`delegated_job_read`, `delegated_job_attach`, `delegated_job_snapshot`).

This keeps the parent-facing tool architecture intact while retiring the old wrapper-agent/session-idle streaming path from the main flow.

## Real-World Usage

Use the parent session tools directly:

- `delegate_to_claude` starts a Claude Code run and returns delegated job plus attach metadata immediately.
- `delegate_to_codex` starts a Codex run and returns the same immediate monitor metadata shape.
- `delegated_job_snapshot` shows the current delegated job record, including transcript capture progress, summary, changed files, and cleanup metadata.
- `delegated_job_read` reads newly available runtime output.
- `delegated_job_attach` refreshes attach metadata so a UI or operator can reconnect to the active monitor target.

The parent session stays compact by design. Detailed runtime output is captured by the PTY monitor and completion is reported back to the parent only after the monitor confirms final runtime state.

## Monitor Behavior

- Launch results include monitor attach metadata immediately so operators can inspect the live terminal without waiting for completion.
- While the runtime is still active, the background monitor keeps polling output and snapshots, appending transcript chunks and updating stored transcript byte and chunk counts.
- Once the runtime reports `stopped`, the plugin extracts the final report from the captured transcript and posts a concise completion message back to the parent session.
- Final delegated job records include cleanup metadata: `cleanupState=completed` and a `cleanupReason` of `completed`, `failed`, or `cancelled`.

## Windows Warp Expectations

On Windows, the preferred monitor backend is the native PTY path. In practice that means:

- Expect attach targets to point at the PTY monitor handle rather than a child OpenCode session.
- Warp or any other terminal UI should attach to the reported PTY target and treat transcript playback as monitor-owned output.
- Completion reporting still arrives through the parent session message path even if the live PTY is no longer attached.
- The automated E2E monitor test uses mocked runtimes for determinism; real Warp validation is still a manual smoke check against an installed Windows PTY environment.

Manual smoke-check sequence:

1. Launch a delegated Claude or Codex job from the parent session.
2. Confirm the tool returns attach metadata immediately.
3. Attach via Warp or your PTY viewer and verify output advances while `delegated_job_snapshot` shows transcript counts increasing.
4. Wait for completion and confirm the parent session receives the final concise update.
5. Inspect `delegated_job_snapshot` again and confirm cleanup metadata reflects the terminal state.

## Initial Goal

Build an OpenCode plugin that lets the main OpenCode agent launch Codex or Claude Code as child-session-backed subagents with rich streamed progress, interrupt/resume support, and real workspace edit/command access.

## Docs

- Design: `docs/plans/2026-04-04-omni-opencode-external-subagents-design.md`
- Implementation plan: `docs/plans/2026-04-04-omni-opencode-external-subagents.md`
