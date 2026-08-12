// FILE: openCodeSharedMcpConfig.ts
// Purpose: Project only user MCP definitions into isolated OpenCode processes.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

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

export async function loadOpenCodeSharedMcpConfig(homeDir: string): Promise<string | undefined> {
  const configDir = path.join(homeDir, ".config", "opencode");
  const shared: Record<string, unknown> = {};
  for (const fileName of GLOBAL_CONFIG_FILES) {
    const config = await readJsoncObject(path.join(configDir, fileName));
    if (config === null || config.mcp === undefined) continue;
    if (!isRecord(config.mcp)) throw new Error(`${fileName} mcp must be an object.`);
    Object.assign(shared, config.mcp);
  }
  delete shared[RESERVED_MCP_SERVER_NAME];
  return Object.keys(shared).length > 0 ? JSON.stringify({ mcp: shared }) : undefined;
}
