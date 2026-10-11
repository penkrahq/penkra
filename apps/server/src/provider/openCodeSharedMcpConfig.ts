// FILE: openCodeSharedMcpConfig.ts
// Purpose: Build the OPENCODE_CONFIG_CONTENT for isolated OpenCode processes:
// project only user MCP definitions, and install Penkra's image-transform plugin.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { INLINE_TOOL_RESULT_BYTES } from "@penkra/shared/toolResults";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { ensureOpenCodeImageTransformPlugin } from "./openCodeImageTransformPlugin.ts";

const GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const;
const RESERVED_MCP_SERVER_NAME = "penkra";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsoncObject(filePath: string): Promise<Record<string, unknown> | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return null;
    throw cause;
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `${filePath} is invalid JSONC (${errors.map((error) => printParseErrorCode(error.error)).join(", ")}).`,
    );
  }
  if (!isRecord(value)) throw new Error(`${filePath} must contain a JSON object.`);
  return value;
}

export async function loadOpenCodeConfigContent(homeDir: string): Promise<string> {
  const configDir = path.join(homeDir, ".config", "opencode");
  const shared: Record<string, unknown> = {};
  for (const fileName of GLOBAL_CONFIG_FILES) {
    const config = await readJsoncObject(path.join(configDir, fileName));
    if (config === null || config.mcp === undefined) continue;
    if (!isRecord(config.mcp)) throw new Error(`${fileName} mcp must be an object.`);
    Object.assign(shared, config.mcp);
  }
  delete shared[RESERVED_MCP_SERVER_NAME];
  const pluginPath = await ensureOpenCodeImageTransformPlugin(homeDir);
  return JSON.stringify({
    ...(Object.keys(shared).length > 0 ? { mcp: shared } : {}),
    plugin: [pluginPath],
    tool_output: { max_bytes: INLINE_TOOL_RESULT_BYTES, max_lines: INLINE_TOOL_RESULT_BYTES },
  });
}
