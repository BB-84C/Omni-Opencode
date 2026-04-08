import { describe, expect, it } from "vitest"
import { loadDelegationPlugin, makeContext } from "./helpers/delegation-plugin-fixture.js"

function expectedPsmuxAttachCommand(monitorSessionId: string): string {
  return `psmux attach -t ${monitorSessionId}`
}

describe("shared monitor sessions", () => {
  it("returns one monitor session id for multiple delegated jobs from the same parent session", async () => {
    const { plugin } = await loadDelegationPlugin({
      runtimeKind: "windows-psmux",
      stateName: "shared-monitor-session",
      nextJobId: (backend, launchCount) => backend === "claude-code" ? `claude-job-${launchCount}` : `codex-job-${launchCount}`,
    })

    const firstLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the atrium" },
      makeContext("parent-session-1", "message-1") as never,
    )) as {
      monitorSessionId?: string
      attachCommand?: string
    }

    const secondLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect the reactor" },
      makeContext("parent-session-1", "message-2") as never,
    )) as {
      monitorSessionId?: string
      attachCommand?: string
    }

    expect(firstLaunch.monitorSessionId).toBe("parent-session-1")
    expect(secondLaunch.monitorSessionId).toBe("parent-session-1")
    expect(secondLaunch.monitorSessionId).toBe(firstLaunch.monitorSessionId)
  })

  it("returns one shared psmux attach command for multiple delegated jobs from the same parent session", async () => {
    const monitorSessionId = "parent-session-1"
    const expectedAttachCommand = expectedPsmuxAttachCommand(monitorSessionId)
    const { plugin } = await loadDelegationPlugin({
      runtimeKind: "windows-psmux",
      stateName: "shared-monitor-session",
      nextJobId: (backend, launchCount) => backend === "claude-code" ? `claude-job-${launchCount}` : `codex-job-${launchCount}`,
    })

    const firstLaunch = JSON.parse(await plugin.tool!.delegate_to_claude.execute(
      { prompt: "inspect the atrium" },
      makeContext(monitorSessionId, "message-1") as never,
    )) as {
      attachCommand?: string
    }

    const secondLaunch = JSON.parse(await plugin.tool!.delegate_to_codex.execute(
      { prompt: "inspect the reactor" },
      makeContext(monitorSessionId, "message-2") as never,
    )) as {
      attachCommand?: string
    }

    expect(firstLaunch.attachCommand).toBe(expectedAttachCommand)
    expect(secondLaunch.attachCommand).toBe(expectedAttachCommand)
    expect(secondLaunch.attachCommand).toBe(firstLaunch.attachCommand)
  })
})
