import { mkdir, readFile, stat } from "node:fs/promises"
import { OmniOpencodePlugin } from "../dist/plugin.js"

const directory = "D:/Omni-Opencode/.verify-transcript-fix"
const sessionID = "verify-transcript-fix-3"
const dashboardPath = `D:/Omni-Opencode/.omni-monitors/${sessionID}-dashboard.json`

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
  prompt: "Read README.md in the current workspace and output the top markdown title only.",
}, context))

const claude = JSON.parse(await plugin.tool.delegate_to_claude.execute({
  prompt: "Read package.json in the current workspace and output the package name only.",
}, context))

const started = Date.now()
let codexSnapshot = null
let claudeSnapshot = null

while (Date.now() - started < 20000) {
  codexSnapshot = JSON.parse(await plugin.tool.delegated_job_snapshot.execute({ jobId: codex.jobId }, context))
  claudeSnapshot = JSON.parse(await plugin.tool.delegated_job_snapshot.execute({ jobId: claude.jobId }, context))

  if (codexSnapshot.status !== "running" && claudeSnapshot.status !== "running") {
    break
  }

  await new Promise((resolve) => setTimeout(resolve, 250))
}

const codexLog = await readFile(codexSnapshot.transcriptCaptureTarget, "utf8")
const claudeLog = await readFile(claudeSnapshot.transcriptCaptureTarget, "utf8")
const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"))

console.log(JSON.stringify({
  codex: {
    snapshot: codexSnapshot,
    logSize: (await stat(codexSnapshot.transcriptCaptureTarget)).size,
    log: codexLog,
  },
  claude: {
    snapshot: claudeSnapshot,
    logSize: (await stat(claudeSnapshot.transcriptCaptureTarget)).size,
    log: claudeLog,
  },
  dashboard,
}, null, 2))
