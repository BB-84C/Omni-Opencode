import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

const psmux = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"
const cwd = "D:/Omni-Opencode"

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

async function waitForCodexReady(target, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const cap = await run(["capture-pane", "-t", target, "-p", "-S", "-120"])
    if (cap.stdout.includes("OpenAI Codex") && cap.stdout.includes("gpt-5.3-codex")) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Codex UI did not become ready for ${target}`)
}

async function probe(sessionName, delayMs, submitKey) {
  const marker = `delay-${delayMs}-${submitKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const prompt = `Read README.md in the current workspace and output the top markdown title only. [marker: ${marker}]`
  await run(["kill-session", "-t", sessionName], { allowFailure: true })
  await run(["start-server"], { allowFailure: true })
  await run(["new-session", "-d", "-s", sessionName, "-n", "dashboard", "--", "powershell.exe", "-NoLogo", "-NoProfile"])
  const created = await run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName, "-n", "codexjob", "--", "codex"])
  const pane = created.stdout.trim()
  await waitForCodexReady(`${sessionName}:1`)
  await run(["send-keys", "-t", pane, prompt])
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  await run(["send-keys", "-t", pane, submitKey])
  await new Promise((resolve) => setTimeout(resolve, 7000))
  const history = await readFile("C:/Users/Administrator/.codex/history.jsonl", "utf8")
  const found = history.includes(`[marker: ${marker}]`)
  const capture = await run(["capture-pane", "-t", `${sessionName}:1`, "-p", "-S", "-120"])
  return { marker, found, capture: capture.stdout }
}

const enter250 = await probe("codex-delay-enter-250", 250, "Enter")
const enter1000 = await probe("codex-delay-enter-1000", 1000, "Enter")
const ctrlj250 = await probe("codex-delay-ctrlj-250", 250, "C-j")
const ctrlj1000 = await probe("codex-delay-ctrlj-1000", 1000, "C-j")

console.log(JSON.stringify({ enter250, enter1000, ctrlj250, ctrlj1000 }, null, 2))
