import { z } from "zod"

// ---------------------------------------------------------------------------
// Individual event schemas
// ---------------------------------------------------------------------------

const assistantDeltaSchema = z.object({
  type: z.literal("assistant.delta"),
  sessionId: z.string(),
  text: z.string(),
})

const assistantMessageSchema = z.object({
  type: z.literal("assistant.message"),
  sessionId: z.string(),
  text: z.string(),
})

const reasoningNoteSchema = z.object({
  type: z.literal("reasoning.note"),
  sessionId: z.string(),
  text: z.string(),
})

const toolStartSchema = z.object({
  type: z.literal("tool.start"),
  sessionId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
})

const toolOutputDeltaSchema = z.object({
  type: z.literal("tool.output.delta"),
  sessionId: z.string(),
  text: z.string(),
})

const toolEndSchema = z.object({
  type: z.literal("tool.end"),
  sessionId: z.string(),
  toolName: z.string(),
  exitCode: z.number().optional(),
})

const commandStartSchema = z.object({
  type: z.literal("command.start"),
  sessionId: z.string(),
  command: z.string(),
})

const commandStdoutDeltaSchema = z.object({
  type: z.literal("command.stdout.delta"),
  sessionId: z.string(),
  text: z.string(),
})

const commandStderrDeltaSchema = z.object({
  type: z.literal("command.stderr.delta"),
  sessionId: z.string(),
  text: z.string(),
})

const fileChangeSchema = z.object({
  type: z.literal("file.change"),
  sessionId: z.string(),
  path: z.string(),
  changeType: z.enum(["created", "modified", "deleted"]),
})

const patchReadySchema = z.object({
  type: z.literal("patch.ready"),
  sessionId: z.string(),
  patch: z.string(),
})

const statusUpdateSchema = z.object({
  type: z.literal("status.update"),
  sessionId: z.string(),
  message: z.string(),
})

const approvalRequestedSchema = z.object({
  type: z.literal("approval.requested"),
  sessionId: z.string(),
  prompt: z.string(),
})

const warningSchema = z.object({
  type: z.literal("warning"),
  sessionId: z.string(),
  message: z.string(),
})

const errorSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string(),
  message: z.string(),
})

const resultFinalSchema = z.object({
  type: z.literal("result.final"),
  sessionId: z.string(),
  summary: z.string(),
  changedFiles: z.array(z.string()).optional(),
})

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const delegatedEventSchema = z.discriminatedUnion("type", [
  assistantDeltaSchema,
  assistantMessageSchema,
  reasoningNoteSchema,
  toolStartSchema,
  toolOutputDeltaSchema,
  toolEndSchema,
  commandStartSchema,
  commandStdoutDeltaSchema,
  commandStderrDeltaSchema,
  fileChangeSchema,
  patchReadySchema,
  statusUpdateSchema,
  approvalRequestedSchema,
  warningSchema,
  errorSchema,
  resultFinalSchema,
])

// ---------------------------------------------------------------------------
// Exported type — TypeScript discriminant narrowing via `type` field
// ---------------------------------------------------------------------------

export type DelegatedEvent = z.infer<typeof delegatedEventSchema>
