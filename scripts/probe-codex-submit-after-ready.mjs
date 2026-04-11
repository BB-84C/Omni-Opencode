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

function findMarker(historyJsonl, marker) {
  return historyJsonl.includes(`[marker: ${marker}]`)
}

async function waitForCodexReady(target, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const cap = await run(["capture-pane", "-t", target, "-p", "-S", "-120"])
    if (cap.stdout.includes("OpenAI Codex") && cap.stdout.includes("gpt-5.3-codex")) {
      return cap.stdout
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Codex UI did not become ready for ${target}`)
}

async function probe(sessionName, submitKey) {
  const marker = `ready-${submitKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  await run(["kill-session", "-t", sessionName], { allowFailure: true })
  await run(["start-server"], { allowFailure: true })
  await run(["new-session", "-d", "-s", sessionName, "-n", "dashboard", "--", "powershell.exe", "-NoLogo", "-NoProfile"])
  const created = await run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName, "-n", "codexjob", "--", "codex"])
  const pane = created.stdout.trim()
  await waitForCodexReady(`${sessionName}:1`)
  await run(["send-keys", "-t", pane, `Say exactly PROBE [marker: ${marker}]`])
  await run(["send-keys", "-t", pane, submitKey])
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const capture = await run(["capture-pane", "-t", `${sessionName}:1`, "-p", "-S", "-120"])
  const history = await readFile("C:/Users/Administrator/.codex/history.jsonl", "utf8")
  return {
    submitKey,
    marker,
    found: findMarker(history, marker),
    capture: capture.stdout,
  }
}

const enterResult = await probe("codex-ready-enter", "Enter")
const ctrlJResult = await probe("codex-ready-ctrlj", "C-j")
const ctrlMResult = await probe("codex-ready-ctrlm", "C-m")
const ctrlSResult = await probe("codex-ready-ctrls", "C-s")

console.log(JSON.stringify({ enterResult, ctrlJResult, ctrlMResult, ctrlSResult }, null, 2))
