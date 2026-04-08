import { open, stat } from "node:fs/promises"
import { basename } from "node:path"

const target = process.argv[2]

if (!target) {
  process.stderr.write("Usage: node windows-monitor.js <logPath>\n")
  process.exit(1)
}

let offset = 0
let closed = false

void followLog(target).catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})

process.on("SIGINT", () => {
  closed = true
  process.exit(0)
})

process.on("SIGTERM", () => {
  closed = true
  process.exit(0)
})

async function followLog(logPath: string): Promise<void> {
  await pump(logPath)

  const timer = setInterval(() => {
    void pump(logPath)
  }, 250)

  timer.unref()

  process.stdout.write(`\n[omni-monitor] Following ${basename(logPath)}\n`)

  while (!closed) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function pump(logPath: string): Promise<void> {
  const info = await stat(logPath)

  if (info.size <= offset) {
    return
  }

  const handle = await open(logPath, "r")

  try {
    const length = info.size - offset
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    offset = info.size
    process.stdout.write(buffer.toString("utf-8"))
  } finally {
    await handle.close()
  }
}
