# Windows PTY Multiplexer Proof Design

**Date:** 2026-04-06

## Goal

Prove, outside the OpenCode plugin path, that one Windows `node-pty` host process can own and render multiple real external Codex and Claude Code terminal sessions inside a single visible terminal window.

## Scope

This is a standalone proof only.

It does **not** integrate with the OpenCode plugin yet.
It does **not** implement keyboard focus routing in the first milestone.
It does **not** try to solve batch resume, tool payloads, or broker integration.

It only proves:

1. one visible terminal host process
2. five real PTY children
3. direct PTY output from all five shown in one terminal
4. no broker-log or file-tail surface as the visible UI
5. no extra pop-out windows

## Sessions To Prove

The proof should spawn exactly five real sessions:

- `codex-1`
- `codex-2`
- `codex-3`
- `claude-1`
- `claude-2`

Use deterministic workspace-reading prompts so behavior is easy to observe and validate.

## Architecture

Introduce a standalone proof script under `scripts/` that directly owns all PTY children.

- one parent Node process
- one `node-pty` child per external session
- one terminal renderer in the parent process

The parent renderer maintains a rolling buffer per pane and redraws the terminal periodically or when output arrives.

This keeps the proof minimal while validating the most important architecture question: whether direct multi-session PTY ownership works fundamentally on Windows with Codex and Claude Code.

## Process Ownership Model

The standalone proof process is the only owner of the visible terminal surface.

- it spawns the real Codex/Claude child processes with `node-pty`
- it receives PTY output directly from each child
- it renders those outputs into one combined terminal view

The proof must not depend on:

- `.log` tailing
- session replay files as the visible surface
- OpenCode session artifacts
- `windows-monitor.js`
- `windows-multiplexer.js attach ...`

Any file output used for debugging must remain secondary and must not be the display source.

## Rendering Model

Use the smallest possible renderer that proves the model.

Suggested first pass:

- one stacked section per pane
- a short header line with:
  - pane label
  - backend
  - status (`starting`, `running`, `exited <code>`)
- recent output lines for that pane
- full redraw on a timer or output event

No alternate-screen or complex pane resizing is required in the first milestone.

The renderer should prefer clarity over fidelity.

## CLI Launch Model

Spawn real external sessions under PTY.

### Codex

Use a real Codex invocation appropriate for PTY-based proof.

The current investigation suggests Codex is a real TTY-oriented CLI and can be spawned under `node-pty`.

### Claude Code

Use real Claude Code CLI invocations under PTY.

Claude appears to support both interactive and non-interactive modes, but this proof should try the real PTY path first.

## Success Criteria

The proof is successful only if all of the following are true:

1. One visible terminal window only
2. The parent proof process owns all five PTY children directly
3. Live output from all five sessions appears in one terminal
4. The visible terminal content comes from direct PTY child output
5. No additional PowerShell or helper windows pop out
6. The output demonstrates that all five sessions really launched and ran

## Non-Goals For First Milestone

Do not solve these yet:

- keyboard input routing to a focused child
- pane navigation shortcuts
- resize propagation sophistication
- plugin integration
- session attach/re-attach commands
- persistence or recovery

## Why This Proof Matters

The current plugin work got stuck in a mixed state where:

- some paths were real PTY-owned
- some paths still behaved like broker/session-log proxying
- integration bugs made it hard to isolate the fundamental architecture question

This standalone proof strips away that complexity.

If it works, the same ownership model can be ported back into the Windows shared monitor host.
If it fails, we learn that before investing more time in plugin-side glue.
