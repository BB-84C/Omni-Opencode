# OpenCode Plugin API Gap — Native Task/Subagent Integration

**Investigated against:** `@opencode-ai/plugin` v1.3.13, `@opencode-ai/sdk` v1.3.13, OpenCode CLI v1.3.15

## What we want

The ideal UX is: when the parent session delegates to Codex or Claude Code, the parent
transcript shows a native **Task card** (like the ones OpenCode creates for built-in
multi-agent subtasks). The card links directly to the child session. The child session
shows a rich delegated-agent trace (not injected user text).

## What the public API supports

### Creating child sessions — ✅ works

```typescript
client.session.create({ body: { parentID: parentSessionID, title } })
```

This creates a real child session with `parentID` linkage. The child session is visible
in OpenCode's session list as a child of the parent. The `parentID` relationship is
durable in the DB.

### Writing to child sessions — ⚠️ user-role only

```typescript
client.session.promptAsync({
  path: { id: childSessionId },
  body: { noReply: true, parts: [{ type: "text", text }] }
})
```

This injects text into the child session as a `role: "user"` message without triggering
an LLM response. It creates a durable log entry, but the role is "user" not "assistant".
There is **no public API to write assistant-role messages** into a session from a plugin.

### Native Task card in parent transcript — ❌ not possible

OpenCode creates Task card entries internally when its own agent orchestration creates a
subtask. The card references the child session via `AgentPart.sessionID`. But:

- **`AgentPartInput`** (the input type for `promptAsync`) has no `sessionID` field.
  Server assigns `sessionID` when an AgentPart is created through internal orchestration,
  not through the public API.
- **`SubtaskPartInput`** creates a **new** OpenCode-native LLM-driven subtask. It cannot
  link to an externally managed session. Sending a SubtaskPart with `agent: "codex"`
  would cause OpenCode to try to run Codex through its internal agent system, not through
  our adapter.
- The `tool.execute.after` hook can only modify the tool output string and metadata, not
  inject Parts into the parent message.
- The `chat.message` hook can modify `output.parts`, but this fires before the LLM
  response is generated — we cannot retroactively attach a Task card after delegation.

### Custom agent registration — ❌ not possible

There is no hook that allows a plugin to register a custom agent implementation. The
`SubtaskPart.agent` field refers to OpenCode's own built-in agents, not plugin-provided
ones.

## What OpenCode core must expose to close the gap

1. **`AgentPartInput.sessionID`** — Allow plugins to inject an AgentPart that references
   a pre-created child session. This would make the parent transcript show a native Task
   card linked to our externally-managed session.

2. **Custom agent hook** — A plugin hook (e.g., `agent.execute`) that lets a plugin
   intercept `SubtaskPart` execution and route it to an external backend instead of
   OpenCode's internal LLM. This would let delegation start from the parent LLM's own
   tool-calling behavior rather than from a plugin tool.

3. **`session.message.write()`** — A way to write assistant-role messages directly into
   a session from plugin code. This would give the child session a proper delegated-agent
   trace instead of injected user text.

## Current capability summary

| Requirement | Achievable | Notes |
|---|---|---|
| Child session with parentID | ✅ | `session.create({ body: { parentID } })` |
| Parent sees child session ID | ✅ | Returned as tool output string |
| Child session receives event log | ✅ | `promptAsync(noReply:true)` → role:user entries |
| Broker telemetry (last msg, files, summary) | ✅ | Stored in `.broker-state/` |
| Interrupt / cancel | ✅ | `adapter.cancelJob()` + store update |
| Native Task card in parent transcript | ✅ | `config` hook + `mode:"subagent"` bridge agents |
| Delegation triggered by parent LLM natively | ✅ | Bridge agents invoked via OpenCode's Task flow |
| Drain writes land after bridge agent is idle | ✅ | `event` hook watches `session.idle` to trigger drain |
| Assistant-role child session entries | ❌ | Requires session.message.write() API |
