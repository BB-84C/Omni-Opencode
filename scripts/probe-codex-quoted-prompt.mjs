import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

const psmux = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"
const cwd = "D:/Omni-Opencode"
const sessionName = "codex-quoted-prompt"
const marker = "probe-codex-quoted-prompt"

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(psmux, args, { cwd })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      reject(new Error(stderr || stdout || `exit ${code}`))
    })
  })
}

const prompt = `Read README.md in the current workspace and output the top markdown title only. [marker: ${marker}]`
const quotedPrompt = `"${prompt.replace(/"/g, '\\"')}"`

await run(["kill-session", "-t", sessionName], { allowFailure: true })
await run(["start-server"], { allowFailure: true })
await run(["new-session", "-d", "-s", sessionName, "-n", "dashboard", "--", "powershell.exe", "-NoLogo", "-NoProfile"])
await run(["new-window", "-d", "-t", sessionName, "-n", "codexjob", "--", "codex", quotedPrompt])
await new Promise((resolve) => setTimeout(resolve, 10000))

const history = await readFile("C:/Users/Administrator/.codex/history.jsonl", "utf8")
const found = history.includes(`[marker: ${marker}]`)
const windows = await run(["list-windows", "-t", sessionName], { allowFailure: true })
const capture = await run(["capture-pane", "-t", `${sessionName}:1`, "-p", "-S", "-120"], { allowFailure: true })

console.log(JSON.stringify({
  prompt,
  quotedPrompt,
  found,
  windows: windows.stdout,
  capture: capture.stdout,
  captureError: capture.stderr,
}, null, 2))
