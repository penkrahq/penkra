// FILE: toolResults.ts
// Purpose: Preserve complete agent operation results with one UTF-8 inline budget.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fits every configured provider's token, byte and line budget.
export const INLINE_TOOL_RESULT_BYTES = 10000;

export interface ToolResultFile {
  readonly resultFile: string;
  readonly bytes: number;
}

export async function storeToolResult(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly opId: string;
  readonly text: string;
}): Promise<ToolResultFile | null> {
  const bytes = Buffer.byteLength(input.text, "utf8");
  if (bytes <= INLINE_TOOL_RESULT_BYTES) return null;
  for (const [name, value] of [
    ["threadId", input.threadId],
    ["opId", input.opId],
  ] as const) {
    if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
      throw new Error(`${name} must be a single path component.`);
    }
  }
  const directory = join(input.stateDir, "tool-results", input.threadId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resultFile = join(directory, `${input.opId}.txt`);
  await writeFile(resultFile, input.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { resultFile, bytes };
}
