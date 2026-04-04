import type { DelegatedEvent } from "../core/events.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectedMessageKind =
  | "message"       // assistant text (delta or complete)
  | "tool-activity" // tool start/end
  | "command"       // shell command activity
  | "file-change"   // file was edited
  | "patch"         // patch checkpoint
  | "status"        // status update / reasoning
  | "approval"      // requires user approval
  | "warning"
  | "error"
  | "result"        // final result

export type ProjectedMessage = {
  kind: ProjectedMessageKind
  sessionId: string
  text: string        // human-readable summary for child session timeline
  raw: DelegatedEvent // the original event for structured log
}

// ---------------------------------------------------------------------------
// Projection function
// ---------------------------------------------------------------------------

export function projectEvent(event: DelegatedEvent): ProjectedMessage {
  switch (event.type) {
    case "assistant.delta":
      return {
        kind: "message",
        sessionId: event.sessionId,
        text: event.text,
        raw: event,
      }

    case "assistant.message":
      return {
        kind: "message",
        sessionId: event.sessionId,
        text: event.text,
        raw: event,
      }

    case "reasoning.note":
      return {
        kind: "status",
        sessionId: event.sessionId,
        text: "Reasoning: " + event.text,
        raw: event,
      }

    case "tool.start":
      return {
        kind: "tool-activity",
        sessionId: event.sessionId,
        text: "→ " + event.toolName,
        raw: event,
      }

    case "tool.output.delta":
      return {
        kind: "tool-activity",
        sessionId: event.sessionId,
        text: event.text,
        raw: event,
      }

    case "tool.end":
      return {
        kind: "tool-activity",
        sessionId: event.sessionId,
        text:
          "✓ " +
          event.toolName +
          (event.exitCode != null ? " (exit " + event.exitCode + ")" : ""),
        raw: event,
      }

    case "command.start":
      return {
        kind: "command",
        sessionId: event.sessionId,
        text: "$ " + event.command,
        raw: event,
      }

    case "command.stdout.delta":
      return {
        kind: "command",
        sessionId: event.sessionId,
        text: event.text,
        raw: event,
      }

    case "command.stderr.delta":
      return {
        kind: "command",
        sessionId: event.sessionId,
        text: "stderr: " + event.text,
        raw: event,
      }

    case "file.change":
      return {
        kind: "file-change",
        sessionId: event.sessionId,
        text: event.changeType + ": " + event.path,
        raw: event,
      }

    case "patch.ready":
      return {
        kind: "patch",
        sessionId: event.sessionId,
        text: `Patch ready (${event.patch.length} chars)`,
        raw: event,
      }

    case "status.update":
      return {
        kind: "status",
        sessionId: event.sessionId,
        text: event.message,
        raw: event,
      }

    case "approval.requested":
      return {
        kind: "approval",
        sessionId: event.sessionId,
        text: event.prompt,
        raw: event,
      }

    case "warning":
      return {
        kind: "warning",
        sessionId: event.sessionId,
        text: event.message,
        raw: event,
      }

    case "error":
      return {
        kind: "error",
        sessionId: event.sessionId,
        text: event.message,
        raw: event,
      }

    case "result.final":
      return {
        kind: "result",
        sessionId: event.sessionId,
        text:
          "Done: " +
          event.summary +
          (event.changedFiles?.length
            ? " (" + event.changedFiles.length + " files changed)"
            : ""),
        raw: event,
      }
  }
}
