import type { JobRecord } from "../core/jobs.js"

export type InterruptCheckpoint = {
  childSessionId: string
  status: "interrupted"
  phase: string
  lastOutput?: string
  activeCommand?: string
  activeTool?: string
  changedFiles: string[]
  resumable: boolean
  checkpointAt: number
}

export function buildInterruptCheckpoint(params: {
  childSessionId: string
  status: "interrupted"
  changedFiles?: string[]
  activeCommand?: string
  activeTool?: string
  lastOutput?: string
  resumable?: boolean
}): InterruptCheckpoint {
  const { childSessionId, status, changedFiles = [], activeCommand, activeTool, lastOutput, resumable = true } = params

  let phase: string
  if (activeTool !== undefined) {
    phase = `tool:${activeTool}`
  } else if (activeCommand !== undefined) {
    phase = `command:${activeCommand}`
  } else {
    phase = "running"
  }

  return {
    childSessionId,
    status,
    phase,
    lastOutput,
    activeCommand,
    activeTool,
    changedFiles,
    resumable,
    checkpointAt: Date.now(),
  }
}

export function interruptCheckpointToMessage(checkpoint: InterruptCheckpoint): string {
  const lines: string[] = [
    `⚠ Job interrupted`,
    `Phase: ${checkpoint.phase}`,
  ]

  if (checkpoint.changedFiles.length > 0) {
    lines.push(`Changed files: ${checkpoint.changedFiles.join(", ")}`)
  } else {
    lines.push(`Changed files: none`)
  }

  lines.push(`Resumable: ${checkpoint.resumable ? "yes" : "no"}`)

  return lines.join("\n")
}

export function resumeInstructionFromCheckpoint(checkpoint: InterruptCheckpoint, extraInstruction?: string): string {
  const filesPart =
    checkpoint.changedFiles.length > 0
      ? checkpoint.changedFiles.join(", ")
      : "none"

  let instruction = `Continue the previous task. Last phase: ${checkpoint.phase}. Files changed so far: ${filesPart}.`

  if (extraInstruction) {
    instruction += ` ${extraInstruction}`
  }

  return instruction
}
