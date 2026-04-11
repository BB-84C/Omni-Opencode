import { mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { OmniOpencodePlugin } from "../dist/plugin.js"

const suffix = randomUUID().slice(0, 8)
const sessionID = `inspect-${suffix}`
const directory = `D:/Omni-Opencode/.inspect-${suffix}`

await mkdir(directory, { recursive: true })

const client = {
  session: {
    create: async () => {},
    promptAsync: async () => {},
  },
  message: {
    create: async () => {},
  },
}

const plugin = await OmniOpencodePlugin({ client, directory })
const context = {
  sessionID,
  messageID: `${sessionID}-message`,
  agent: "vt-os",
  directory: "D:/Omni-Opencode",
  worktree: "D:/Omni-Opencode",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: () => {},
}

const codex = JSON.parse(await plugin.tool.delegate_to_codex.execute({
  prompt: "Investigate this repo carefully, use subagents for exploration.",
}, context))

const claude = JSON.parse(await plugin.tool.delegate_to_claude.execute({
  prompt: "Investigate this repo carefully, use subagents for exploration.",
}, context))

console.log(JSON.stringify({
  sessionID,
  codexJobId: codex.jobId,
  claudeJobId: claude.jobId,
  attachCommand: codex.attachCommand,
}, null, 2))

await new Promise(() => {})
