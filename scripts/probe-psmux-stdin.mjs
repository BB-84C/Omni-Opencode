import { spawn } from "node:child_process"

const psmux = "D:/Omni-Opencode/.omni-tools/psmux/3.3.1/win32-x64/psmux.exe"

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(psmux, args, { cwd: "D:/Omni-Opencode" })
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

await run(["kill-session", "-t", "stdin-probe"], { allowFailure: true })
await run(["start-server"], { allowFailure: true })

const created = await run([
  "new-session",
  "-d",
  "-P",
  "-F",
  "#{pane_id}",
  "-s",
  "stdin-probe",
  "-n",
  "job",
  "--",
  "codex",
  "exec",
  "--color",
  "never",
  "-",
])

const pane = created.stdout
await run(["set-option", "-t", "stdin-probe:0", "remain-on-exit", "on"])
await new Promise((resolve) => setTimeout(resolve, 500))
await run(["send-keys", "-t", pane, "Read README.md in the current workspace and output the top markdown title only."])
await run(["send-keys", "-t", pane, "Enter"])
await run(["send-keys", "-t", pane, "C-z"])
await run(["send-keys", "-t", pane, "Enter"])
await new Promise((resolve) => setTimeout(resolve, 8000))

const dead = await run(["list-panes", "-t", "stdin-probe:0", "-F", "#{pane_dead} #{pane_current_command}"])
const capture = await run(["capture-pane", "-t", "stdin-probe:0", "-p", "-S", "-120"])

console.log(JSON.stringify({
  pane,
  dead: dead.stdout,
  capture: capture.stdout,
}, null, 2))
