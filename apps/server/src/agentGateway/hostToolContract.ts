// FILE: hostToolContract.ts
// Purpose: One provider-neutral definition for Penkra's injected host tool.

import { z } from "zod";

export const PENKRA_EXEC_COMMAND_NAME = "penkra_exec_command";

export const PENKRA_EXEC_COMMAND_DESCRIPTION =
  'Execute exactly one registered Penkra operation in the caller Thread\'s trusted context. Pass the command as discrete words and send operation data through input or flags. This is not a shell: there is no quoting, escaping, substitution, PATH lookup, pipe, or redirect interpretation. Core commands begin with the reserved penkra root. Installed-App commands begin with the App slug and express dotted manifest keys as words, so issues.create becomes ["linear", "issues", "create"].';

export const PENKRA_EXEC_COMMAND_ZOD_SHAPE = {
  command: z
    .array(z.string())
    .min(1)
    .describe(
      'The command as discrete words, for example ["penkra", "threads", "list"] or ["linear", "issues", "create"]. Send each word exactly as Penkra should receive it; do not quote or escape values.',
    ),
  input: z
    .unknown()
    .optional()
    .describe(
      "Operation input matching the schema and examples returned by command help. Object-shaped operations normally receive a structured JSON object; the dispatcher also recovers once from an equivalent JSON-object string.",
    ),
  flags: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Named options without leading dashes, for example { "document-id": "abc" }.'),
  tabId: z
    .string()
    .optional()
    .describe("The exact App tab to target when the command supports tab targeting."),
};

export const PENKRA_EXEC_COMMAND_INPUT_SCHEMA = z.toJSONSchema(
  z.object(PENKRA_EXEC_COMMAND_ZOD_SHAPE).strict(),
) as Record<string, unknown>;

export const PENKRA_EXEC_COMMAND_ANNOTATIONS = {
  title: "Execute a Penkra command",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
