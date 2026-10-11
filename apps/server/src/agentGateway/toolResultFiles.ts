// FILE: toolResultFiles.ts
// Purpose: Bound provider-facing MCP output without truncating operation results.

import { storeToolResult } from "@penkra/shared/toolResults";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";

export async function boundMcpToolResult(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly opId: string;
  readonly result: McpToolCallResult;
}): Promise<McpToolCallResult> {
  const { result } = input;
  const block = result.content[0];
  const text =
    result.content.length === 1 && block?.type === "text" && result.structuredContent === undefined
      ? block.text
      : JSON.stringify(result);
  const file = await storeToolResult({ ...input, text });
  return file === null
    ? result
    : { ...mcpToolResultJson(file), ...(result.isError ? { isError: true } : {}) };
}
