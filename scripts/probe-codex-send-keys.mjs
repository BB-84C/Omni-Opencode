import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

const psmux = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"
const cwd = "D:/Omni-Opencode"

function discoverFromHistory(historyJsonl, marker) {
  for (const line of historyJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry?.text === "string" && entry.text.includes(`[marker: ${marker}]`)) {
        return entry
      }
    } catch {
      // ignore malformed lines
    }
  }

  return undefined
}

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(psmux, args, { cwd })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      reject(new Error(stderr || stdout || `exit ${code}`))
    })
  })
}

async function probe(sessionName, mode, submitKey, commandArgs = ["codex"]) {
  await run(["kill-session", "-t", sessionName], { allowFailure: true })
  await run(["start-server"], { allowFailure: true })
  await run(["new-session", "-d", "-s", sessionName, "-n", "dashboard", "--", "powershell.exe", "-NoLogo", "-NoProfile"])
  const created = await run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName, "-n", "job", "--", ...commandArgs])
  const pane = created.stdout.trim()
  if (!pane) {
    throw new Error(`No pane id returned for ${sessionName}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const paneState = await run(["list-panes", "-t", `${sessionName}:1`, "-F", "#{pane_id} dead=#{pane_dead} cmd=#{pane_current_command}"])

  const marker = `probe:${sessionName}`
  const prompt = `Say exactly PROBE [marker: ${marker}]`

  if (mode === "combined") {
    await run(["send-keys", "-t", pane, prompt, submitKey])
  } else {
    await run(["send-keys", "-t", pane, prompt])
    await run(["send-keys", "-t", pane, submitKey])
  }

  await new Promise((resolve) => setTimeout(resolve, 5000))
  const capture = await run(["capture-pane", "-t", `${sessionName}:0`, "-p", "-S", "-120"])
  const history = await readFile("C:/Users/Administrator/.codex/history.jsonl", "utf8")
  const discovered = discoverFromHistory(history, marker)
  return { paneState: paneState.stdout, capture: capture.stdout, discovered }
}

const combinedEnter = await probe("codex-probe-a", "combined", "Enter")
const separateEnter = await probe("codex-probe-b", "separate", "Enter")
const separateCm = await probe("codex-probe-c", "separate", "C-m")
const separateCj = await probe("codex-probe-d", "separate", "C-j")
const noAltScreenEnter = await probe("codex-probe-e", "separate", "Enter", ["codex", "--no-alt-screen"])

console.log(JSON.stringify({ combinedEnter, separateEnter, separateCm, separateCj, noAltScreenEnter }, null, 2))
