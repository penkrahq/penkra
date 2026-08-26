// FILE: hostToolContract.ts
// Purpose: One provider-neutral definition for Penkra's injected host tool.

import { z } from "zod";

export const PENKRA_EXEC_COMMAND_NAME = "penkra_exec_command";

export const PENKRA_EXEC_COMMAND_DESCRIPTION =
  "Execute exactly one registered Penkra command in the caller Thread's trusted context. This is a command-line parser, not a shell: it supports ordinary quoted arguments and --name value options but never searches PATH or evaluates pipes, redirects, substitutions, or environment expansion. Start with penkra --help, then use the relevant nested --help before an unfamiliar command.";

export const PENKRA_EXEC_COMMAND_ZOD_SHAPE = {
  command: z
    .string()
    .min(1)
    .describe(
      'One registered command, for example "penkra threads list", "penkra tabs snapshot --tab-id <id>", or "linear issues create --title Fix".',
    ),
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
