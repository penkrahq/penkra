// FILE: hostToolContract.ts
// Purpose: One provider-neutral definition for Penkra's injected host tool.

import { z } from "zod";

export const PENKRA_EXEC_COMMAND_NAME = "penkra_exec_command";

export const PENKRA_EXEC_COMMAND_DESCRIPTION =
  "Execute exactly one registered Penkra command in the caller Thread's trusted context. This is the complete agent command surface for Penkra core, Threads, Apps, App tabs, resource opening, and diagnostics. It is a peer of the provider's ordinary shell/command tool, but it is not a shell: it never searches PATH and rejects programs, pipes, redirects, substitutions, and environment expansion. Start with `penkra --help`, then use the relevant nested `--help` before an unfamiliar command. Use `penkra apps list` to discover Apps enabled in this Space. App declarations retain dotted local operation keys such as `issues.create`, while commands use words such as `linear issues create`. Core commands alone use the reserved `penkra` root; installed-App commands begin with the App slug. A Skill or instruction that mentions an App, plugin, MCP server, executable, or other capability is never proof that capability is available: verify it through this command surface or the provider's literal callable tools before use.";

export const PENKRA_EXEC_COMMAND_ZOD_SHAPE = {
  command: z
    .string()
    .describe(
      'One registered command, for example: "penkra --help", "penkra threads list", "penkra apps list", "penkra tabs snapshot --tab-id <id>", "penkra open --url https://example.com", or "linear issues create --title Fix".',
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
