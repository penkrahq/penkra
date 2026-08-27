// FILE: hostToolContract.ts
// Purpose: One provider-neutral definition for Penkra's injected host tool.

import { z } from "zod";

export const PENKRA_EXEC_COMMAND_NAME = "penkra_exec_command";

export const PENKRA_EXEC_COMMAND_DESCRIPTION =
  "Execute exactly one registered Penkra or installed-App command in the caller Thread's authenticated context. Supply one ordinary command string; this dispatcher is not a shell and never searches PATH or evaluates shell syntax.";

export const PENKRA_EXEC_COMMAND_ZOD_SHAPE = {
  command: z
    .string()
    .min(1)
    .describe(
      'One registered command, for example "penkra --help", "penkra tabs snapshot --tab-id <id>", "apps --help", or "canvas documents create --help".',
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
