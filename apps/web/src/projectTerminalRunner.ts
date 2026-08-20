// FILE: projectTerminalRunner.ts
// Purpose: Shared helper for launching project commands in managed terminal sessions.
// Layer: Web terminal orchestration helper
// Exports: runProjectCommandInTerminal and default dimensions for script terminals.

import type { NativeApi, TerminalSessionSnapshot, ThreadId } from "@penkra/contracts";
import {
  deriveTerminalCommandIdentity,
  type TerminalCliKind,
} from "@penkra/shared/terminalThreads";

import { projectScriptRuntimeEnv } from "./projectScripts";

export const PROJECT_COMMAND_TERMINAL_COLS = 120;
export const PROJECT_COMMAND_TERMINAL_ROWS = 30;

export interface ProjectCommandTerminalMetadata {
  cliKind: TerminalCliKind | null;
  label: string;
}

export async function runProjectCommandInTerminal(input: {
  api: NativeApi;
  threadId: ThreadId;
  terminalId: string;
  project: { cwd: string };
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<{
  snapshot: TerminalSessionSnapshot;
  metadata: ProjectCommandTerminalMetadata | null;
}> {
  const runtimeEnv = projectScriptRuntimeEnv({
    project: {
      cwd: input.project.cwd,
    },
    ...(input.env ? { extraEnv: input.env } : {}),
  });
  const terminalCommandIdentity = deriveTerminalCommandIdentity(input.command);
  const snapshot = await input.api.terminal.open({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    env: runtimeEnv,
    cols: PROJECT_COMMAND_TERMINAL_COLS,
    rows: PROJECT_COMMAND_TERMINAL_ROWS,
  });
  await input.api.terminal.write({
    threadId: input.threadId,
    terminalId: input.terminalId,
    data: `${input.command}\r`,
  });

  return {
    snapshot,
    metadata: terminalCommandIdentity
      ? {
          cliKind: terminalCommandIdentity.cliKind,
          label: terminalCommandIdentity.title,
        }
      : null,
  };
}
