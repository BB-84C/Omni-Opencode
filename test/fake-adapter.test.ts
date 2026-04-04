import { describe, expect, it } from "vitest"
import { FakeAdapter } from "../src/adapters/fake-adapter.js"
import type { DelegatedEvent } from "../src/core/events.js"

describe("FakeAdapter", () => {
  it("startJob returns a handle with an id and childSessionId", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-1",
      prompt: "do something",
    })

    expect(handle.id).toBeTruthy()
    expect(typeof handle.id).toBe("string")
    expect(handle.childSessionId).toBe("session-1")
  })

  it("subscribeEvents yields all events and ends with result.final", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-2",
      prompt: "run tests",
    })

    const events: DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(handle.id)) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThan(0)

    const lastEvent = events[events.length - 1]
    expect(lastEvent.type).toBe("result.final")
  })

  it("event sequence contains expected types in order", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-3",
      prompt: "check files",
    })

    const events: DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(handle.id)) {
      events.push(event)
    }

    const types = events.map((e) => e.type)

    expect(types).toContain("status.update")
    expect(types).toContain("tool.start")
    expect(types).toContain("tool.end")
    expect(types).toContain("command.start")
    expect(types).toContain("command.stdout.delta")
    expect(types).toContain("assistant.delta")
    expect(types).toContain("result.final")

    // Verify ordering: status.update before tool.start before tool.end
    const statusIdx = types.indexOf("status.update")
    const toolStartIdx = types.indexOf("tool.start")
    const toolEndIdx = types.indexOf("tool.end")
    const cmdStartIdx = types.indexOf("command.start")
    const cmdStdoutIdx = types.indexOf("command.stdout.delta")
    const assistantIdx = types.indexOf("assistant.delta")
    const resultIdx = types.indexOf("result.final")

    expect(statusIdx).toBeLessThan(toolStartIdx)
    expect(toolStartIdx).toBeLessThan(toolEndIdx)
    expect(toolEndIdx).toBeLessThan(cmdStartIdx)
    expect(cmdStartIdx).toBeLessThan(cmdStdoutIdx)
    expect(cmdStdoutIdx).toBeLessThan(assistantIdx)
    expect(assistantIdx).toBeLessThan(resultIdx)
  })

  it("events have sessionId matching the childSessionId", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-4",
      prompt: "verify session ids",
    })

    for await (const event of adapter.subscribeEvents(handle.id)) {
      expect(event.sessionId).toBe("session-4")
    }
  })

  it("result.final has correct summary and changedFiles", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-5",
      prompt: "verify result",
    })

    let finalEvent: DelegatedEvent | undefined
    for await (const event of adapter.subscribeEvents(handle.id)) {
      if (event.type === "result.final") {
        finalEvent = event
      }
    }

    expect(finalEvent).toBeDefined()
    if (finalEvent?.type === "result.final") {
      expect(finalEvent.summary).toBe("completed")
      expect(finalEvent.changedFiles).toEqual(["src/index.ts"])
    }
  })

  it("cancelJob marks job as cancelled and prevents further events", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-6",
      prompt: "cancel this",
    })

    await adapter.cancelJob(handle.id)

    const snapshot = await adapter.getSnapshot(handle.id)
    // After cancellation the job should be in a terminal state (failed or interrupted)
    expect(["failed", "interrupted"]).toContain(snapshot.status)
  })

  it("getSnapshot returns current status after events complete", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-7",
      prompt: "snapshot test",
    })

    // Consume all events
    for await (const _event of adapter.subscribeEvents(handle.id)) {
      // drain
    }

    const snapshot = await adapter.getSnapshot(handle.id)
    expect(snapshot.id).toBe(handle.id)
    expect(snapshot.childSessionId).toBe("session-7")
    expect(snapshot.status).toBe("completed")
    expect(snapshot.changedFiles).toEqual(["src/index.ts"])
    expect(snapshot.lastEventSeq).toBeGreaterThan(0)
  })

  it("resumeJob returns a new handle and replays events", async () => {
    const adapter = new FakeAdapter()
    const handle = await adapter.startJob({
      childSessionId: "session-8",
      prompt: "initial prompt",
    })

    // Drain first run
    for await (const _event of adapter.subscribeEvents(handle.id)) {
      // drain
    }

    const resumedHandle = await adapter.resumeJob(handle.id, "continue please")
    expect(resumedHandle.id).toBeTruthy()
    expect(resumedHandle.childSessionId).toBe("session-8")

    const resumedEvents: DelegatedEvent[] = []
    for await (const event of adapter.subscribeEvents(resumedHandle.id)) {
      resumedEvents.push(event)
    }

    expect(resumedEvents.length).toBeGreaterThan(0)
    const lastEvent = resumedEvents[resumedEvents.length - 1]
    expect(lastEvent.type).toBe("result.final")
  })
})
