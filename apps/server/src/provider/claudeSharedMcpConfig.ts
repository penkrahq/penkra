// FILE: claudeSharedMcpConfig.ts
// Purpose: Keep user MCP definitions shared while Claude account state stays isolated.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const RESERVED_MCP_SERVER_NAME = "penkra";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(filePath: string, allowMissing: boolean) {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object.`);
    return parsed;
  } catch (cause) {
    if (allowMissing && isRecord(cause) && cause.code === "ENOENT") return {};
    throw cause;
  }
}

export function sharedClaudeMcpServers(source: Record<string, unknown>): Record<string, unknown> {
  const configured = source.mcpServers;
  if (configured === undefined) return {};
  if (!isRecord(configured)) throw new Error("Claude's global mcpServers value must be an object.");
  return Object.fromEntries(
    Object.entries(configured).filter(([name]) => name !== RESERVED_MCP_SERVER_NAME),
  );
}

export async function synchronizeClaudeSharedMcpConfig(input: {
  readonly sourceConfigPath: string;
  readonly targetConfigDir: string;
}): Promise<void> {
  const targetConfigPath = path.join(input.targetConfigDir, ".claude.json");
  if (path.resolve(input.sourceConfigPath) === path.resolve(targetConfigPath)) return;

  const [source, target] = await Promise.all([
    readJsonObject(input.sourceConfigPath, true),
    readJsonObject(targetConfigPath, true),
  ]);
  const next = {
    ...target,
    mcpServers: sharedClaudeMcpServers(source),
  };
  await mkdir(input.targetConfigDir, { recursive: true });
  const temporaryPath = `${targetConfigPath}.penkra-${process.pid}-${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, targetConfigPath);
}
