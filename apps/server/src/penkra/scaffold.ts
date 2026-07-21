import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { PenkraClientRecord } from "./backendClient";

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const CLIENT_INSTRUCTION_VIEW_FILE = "client.md";
export const HQ_INSTRUCTION_VIEW_FILE = "hq.md";

export async function scaffoldClient(input: {
  root: string;
  endpoint: string;
  client: PenkraClientRecord;
  token: string | null;
  instructions: string;
}): Promise<string> {
  const workspace = path.join(input.root, input.client.id);
  const configPath = path.join(workspace, ".penkra", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700);
  if (input.token) {
    await writeAtomic(
      configPath,
      `${JSON.stringify(
        {
          endpoint: input.endpoint,
          scope: "client",
          clientId: input.client.id,
          token: input.token,
          displayName: input.client.displayName,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  }
  await writeInstructionFiles(
    workspace,
    composeClientInstructions(input.instructions, input.client.instructions),
  );
  await writeAtomicIfChanged(
    path.join(workspace, CLIENT_INSTRUCTION_VIEW_FILE),
    input.client.instructions,
    0o600,
  );
  return workspace;
}

export function composeClientInstructions(
  genericInstructions: string,
  clientInstructions: string,
): string {
  const clientBody = clientInstructions.trim();
  if (!clientBody) return genericInstructions;
  return `${genericInstructions.trimEnd()}\n\n## Client-provided instructions\n\nThe following instructions come from the client. Generic client instructions and HQ policy take precedence on conflict.\n\n${clientBody}\n`;
}

export async function scaffoldHq(
  root: string,
  hqInstructions: string,
  clientInstructions: string,
): Promise<string> {
  const workspace = path.join(root, "hq");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeInstructionFiles(workspace, hqInstructions);
  await writeAtomicIfChanged(path.join(workspace, HQ_INSTRUCTION_VIEW_FILE), hqInstructions, 0o600);
  await writeAtomicIfChanged(
    path.join(workspace, CLIENT_INSTRUCTION_VIEW_FILE),
    clientInstructions,
    0o600,
  );
  await rm(path.join(workspace, "skills"), { recursive: true, force: true });
  return workspace;
}

async function writeInstructionFiles(workspace: string, instructions: string): Promise<void> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    await writeAtomicIfChanged(path.join(workspace, name), instructions, 0o600);
  }
}

async function writeAtomicIfChanged(
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  try {
    if ((await readFile(filePath, "utf8")) === contents) return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await writeAtomic(filePath, contents, mode);
}

export async function hasClientConfig(workspace: string, clientId: string): Promise<boolean> {
  const configPath = path.join(workspace, ".penkra", "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const config = JSON.parse(text) as Record<string, unknown>;
  if (
    config.scope !== "client" ||
    config.clientId !== clientId ||
    typeof config.token !== "string"
  ) {
    throw new Error(`Invalid client config at ${configPath}`);
  }
  return true;
}

async function writeAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, mode);
  const directory = await open(path.dirname(filePath), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
